import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import axios from 'axios';
import mongoose from 'mongoose';
import { readBanToken } from './ban-token.js';
import { priceIdValid, paddleEnvironment, paddleOrigin, paddleRequestOptions, logPaddleError } from './diagnostics.js';

const schema = new mongoose.Schema({
  orderId: { type: String, unique: true, required: true },
  banId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  ip: { type: String, required: true },
  priceId: { type: String, required: true },
  transactionId: { type: String },
  amountMinor: String,
  currency: String,
  completedAt: Date,
  environment: { type: String, enum: ['sandbox', 'production'] },
  status: { type: String, default: 'pending' },
  creationStartedAt: Date,
  failureCode: String,
}, { timestamps: true });
export const UnbanPayment = mongoose.model('UnbanPayment', schema);

export function verifySignature(raw, header, secret, now = Date.now()) {
  if (!secret || !Buffer.isBuffer(raw) || typeof header !== 'string') return false;
  const parts = header.split(';').map(p => p.trim().split('='));
  const ts = parts.find(([key]) => key === 'ts')?.[1];
  if (!ts || !/^\d+$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > 5) return false;
  const expected = createHmac('sha256', secret).update(ts + ':').update(raw).digest();
  return parts.filter(([key]) => key === 'h1').some(([, value]) => {
    if (!/^[a-f0-9]{64}$/i.test(value || '')) return false;
    return timingSafeEqual(expected, Buffer.from(value, 'hex'));
  });
}

export function isExpectedTransaction(data, payment) {
  return data?.status === 'completed' && data.id === payment.transactionId &&
    data.custom_data?.order_id === payment.orderId && !data.subscription_id &&
    Array.isArray(data.items) && data.items.length === 1 &&
    data.items[0].price?.id === payment.priceId && data.items[0].quantity === 1 &&
    !data.items[0].price?.billing_cycle;
}

export function missingPaddleSettings(env = process.env) {
  const missing = ['PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET'].filter(key => !env[key]?.trim());
  if (!priceIdValid(env.PADDLE_UNBAN_PRICE_ID)) missing.push('PADDLE_UNBAN_PRICE_ID');
  if (env.PADDLE_ENVIRONMENT && !['sandbox', 'production'].includes(env.PADDLE_ENVIRONMENT)) missing.push('PADDLE_ENVIRONMENT');
  return missing;
}

export function paddleHandlers({ getBanModel, getActiveBan, clientIp }) {
  return {
    async checkout(req, res) {
      const missing = missingPaddleSettings();
      if (missing.length) return res.status(503).json({ error: 'Paddle checkout is not configured yet.', missing });
      let payment;
      let ownsAttempt = false;
      let sentCreate = false;
      let operation = 'checkout.database';
      try {
        await UnbanPayment.init();
        let ban;
        if (req.body?.banToken) {
          const id = readBanToken(req.body.banToken, { allowExpired: true });
          if (!id) return res.status(403).json({ error: 'Invalid checkout reference. Reconnect to refresh your restriction.' });
          ban = await getBanModel().findOne({ _id: id, status: 'active', expiry: { $gt: new Date() } });
        } else {
          // Compatibility for older clients; new clients use the signed ban reference.
          ban = await getActiveBan({ ip: clientIp(req) });
        }
        if (!ban) return res.status(409).json({ code: 'BAN_NOT_ACTIVE', error: 'This restriction has expired or was removed. Reconnect to chat; no payment is needed for it.' });
        const environment = paddleEnvironment();
        const priceId = process.env.PADDLE_UNBAN_PRICE_ID;
        payment = await UnbanPayment.findOne({ banId: ban._id });
        if (!payment) {
          try {
            payment = await UnbanPayment.create({ orderId: randomUUID(), banId: ban._id, ip: ban.ip, priceId, environment, status: 'creating', creationStartedAt: new Date() });
            ownsAttempt = true;
          } catch (error) {
            if (error.code !== 11000) throw error;
            payment = await UnbanPayment.findOne({ banId: ban._id });
          }
        }
        if (!ownsAttempt && payment?.status === 'failed' && !payment.transactionId) {
          payment = await UnbanPayment.findOneAndUpdate({ _id: payment._id, status: 'failed', transactionId: { $exists: false } },
            { $set: { status: 'creating', creationStartedAt: new Date(), priceId, environment }, $unset: { failureCode: 1 } }, { new: true });
          ownsAttempt = Boolean(payment);
        }
        if (!ownsAttempt) {
          if (payment?.status === 'pending' && payment.transactionId && payment.environment === environment) {
            return res.json({ orderId: payment.orderId, transactionId: payment.transactionId, priceId: payment.priceId });
          }
          // Never retry an ambiguous POST: Paddle does not promise idempotency keys.
          // Legacy orphan records and interrupted processes require reconciliation.
          if (payment && !payment.transactionId && (payment.status === 'pending' ||
              (payment.status === 'creating' && Date.now() - new Date(payment.creationStartedAt || 0).getTime() > 60000))) {
            await UnbanPayment.updateOne({ _id: payment._id, status: payment.status, transactionId: { $exists: false } },
              { $set: { status: 'unknown', failureCode: 'RECONCILIATION_REQUIRED' } });
          }
          const busy = payment?.status === 'creating' && Date.now() - new Date(payment.creationStartedAt || 0).getTime() <= 60000;
          return res.status(409).json({ code: busy ? 'PADDLE_CHECKOUT_IN_PROGRESS' : 'PADDLE_RECONCILIATION_REQUIRED',
            error: busy ? 'Checkout is being prepared. Please try again shortly.' : 'This payment attempt needs verification. Please wait for the restriction to expire or contact support; another payment has not been created.' });
        }
        operation = 'checkout.price_lookup';
        const origin = paddleOrigin();
        const options = paddleRequestOptions();
        // Authenticated lookup validates the same account/environment before any POST.
        const price = (await axios.get(origin + '/prices/' + priceId, options)).data?.data;
        if (price?.id !== priceId || price.status !== 'active' || price.billing_cycle) {
          await UnbanPayment.updateOne({ _id: payment._id, status: 'creating' }, { $set: { status: 'failed', failureCode: 'PADDLE_PRICE_INVALID' } });
          return res.status(503).json({ code: 'PADDLE_PRICE_INVALID', error: 'The configured Paddle price must be active and one-time.' });
        }
        operation = 'checkout.transaction_create';
        sentCreate = true;
        const response = await axios.post(origin + '/transactions', {
          items: [{ price_id: priceId, quantity: 1 }], collection_mode: 'automatic',
          custom_data: { order_id: payment.orderId },
        }, options);
        const transaction = response.data?.data;
        if (!/^txn_[a-z0-9]{26}$/.test(transaction?.id || '') || transaction.custom_data?.order_id !== payment.orderId ||
            !Array.isArray(transaction.items) || transaction.items.length !== 1 || transaction.items[0].quantity !== 1 ||
            transaction.items[0].price?.id !== priceId || transaction.items[0].price?.billing_cycle || transaction.subscription_id) {
          throw new Error('Unexpected Paddle transaction');
        }
        operation = 'checkout.transaction_save';
        await UnbanPayment.updateOne({ _id: payment._id, status: { $in: ['creating', 'unknown'] } },
          { $set: { transactionId: transaction.id, status: 'pending' }, $unset: { failureCode: 1 } });
        res.json({ orderId: payment.orderId, transactionId: transaction.id, priceId });
      } catch (error) {
        logPaddleError(error, operation);
        // Only explicit Paddle 4xx JSON rejections prove the POST failed. Timeouts,
        // malformed responses, 5xx and DB-save failures must not create another charge.
        const status = error?.response?.status;
        const rejected = operation === 'checkout.transaction_create' && status >= 400 && status < 500 && status !== 408 &&
          typeof error?.response?.data?.error?.code === 'string';
        const code = operation === 'checkout.database' || operation === 'checkout.transaction_save' ? 'PADDLE_DATABASE_ERROR' :
          operation === 'checkout.price_lookup' ? 'PADDLE_PRICE_LOOKUP_FAILED' : 'PADDLE_TRANSACTION_CREATE_FAILED';
        if (ownsAttempt && payment) {
          try {
            await UnbanPayment.updateOne({ _id: payment._id, status: { $in: ['creating', 'unknown'] }, transactionId: { $exists: false } },
              { $set: { status: !sentCreate || rejected ? 'failed' : 'unknown', failureCode: code } });
          } catch (saveError) { logPaddleError(saveError, 'checkout.failure_save'); }
        }
        res.status(operation === 'checkout.database' || operation === 'checkout.transaction_save' ? 503 : 502)
          .json({ error: 'Unable to open checkout. Please try again later.', code });
      }
    },
    async status(req, res) {
      try {
        const token = req.headers['x-ban-checkout-token'];
        const banId = token ? readBanToken(token, { allowExpired: true }) : null;
        if (token && !banId) return res.status(403).json({ error: 'Invalid checkout reference.' });
        const payment = await UnbanPayment.findOne({ orderId: req.params.orderId, ...(banId ? { banId } : { ip: clientIp(req) }) });
        if (!payment) return res.status(404).json({ error: 'Payment not found.' });
        res.json({ status: payment.status });
      } catch (error) { logPaddleError(error, 'payment.status'); res.status(503).json({ error: 'Unable to check payment.' }); }
    },
    async webhook(req, res) {
      if (!verifySignature(req.body, req.headers['paddle-signature'], process.env.PADDLE_WEBHOOK_SECRET)) {
        logPaddleError({}, 'webhook.signature_invalid');
        return res.sendStatus(400);
      }
      let event;
      try { event = JSON.parse(req.body.toString('utf8')); } catch { logPaddleError({}, 'webhook.json_invalid'); return res.sendStatus(400); }
      if (event.event_type !== 'transaction.completed') return res.sendStatus(200);
      try {
        const orderId = event.data?.custom_data?.order_id;
        if (typeof orderId !== 'string') return res.sendStatus(200);
        const payment = await UnbanPayment.findOne({ orderId });
        if (!payment) return res.sendStatus(200);
        // A webhook may race transaction creation; let Paddle retry after the ID is saved.
        if (!payment.transactionId) return res.sendStatus(503);
        if (payment.environment !== paddleEnvironment() || !isExpectedTransaction(event.data, payment)) {
          logPaddleError({}, 'webhook.transaction_mismatch');
          return res.sendStatus(400);
        }
        const total = event.data.details?.totals?.grand_total;
        const currency = event.data.currency_code;
        if (typeof total === 'string' && /^\d+$/.test(total) && /^[A-Z]{3}$/.test(currency || '')) {
          payment.amountMinor = total;
          payment.currency = currency;
        }
        const completedAt = new Date(event.occurred_at);
        if (!payment.completedAt) payment.completedAt = Number.isNaN(completedAt.getTime()) ? new Date() : completedAt;
        if (payment.status === 'completed') {
          await payment.save();
          return res.sendStatus(200);
        }
        // Exact ban ID: payment for an old ban must never lift a later restriction.
        await getBanModel().updateOne({ _id: payment.banId, ip: payment.ip, status: 'active' }, {
          $set: { status: 'closed', closedAt: new Date(), expiry: new Date(), paymentStatus: 'success', paymentOrderId: payment.orderId },
        });
        payment.status = 'completed'; await payment.save();
        res.sendStatus(200);
      } catch (error) { logPaddleError(error, 'webhook.fulfillment'); res.sendStatus(503); }
    },
  };
}
