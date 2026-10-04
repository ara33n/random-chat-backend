import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import axios from 'axios';
import mongoose from 'mongoose';
import { readBanToken } from './ban-token.js';

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
  if (!/^pri_[a-z0-9]+$/.test(env.PADDLE_UNBAN_PRICE_ID || '')) missing.push('PADDLE_UNBAN_PRICE_ID');
  return missing;
}

export function paddleHandlers({ getBanModel, getActiveBan, clientIp }) {
  return {
    async checkout(req, res) {
      const missing = missingPaddleSettings();
      if (missing.length) return res.status(503).json({ error: 'Paddle checkout is not configured yet.', missing });
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
        const ip = ban.ip;
        const existing = await UnbanPayment.findOne({ banId: ban._id, status: 'pending', transactionId: { $exists: true } });
        if (existing) return res.json({ orderId: existing.orderId, transactionId: existing.transactionId, priceId: existing.priceId });
        const orderId = randomUUID();
        const priceId = process.env.PADDLE_UNBAN_PRICE_ID;
        const payment = await UnbanPayment.create({ orderId, banId: ban._id, ip, priceId, environment: process.env.PADDLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox' });
        const origin = process.env.PADDLE_ENVIRONMENT === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
        const response = await axios.post(origin + '/transactions', {
          items: [{ price_id: priceId, quantity: 1 }], collection_mode: 'automatic',
          custom_data: { order_id: orderId },
        }, { headers: { Authorization: `Bearer ${process.env.PADDLE_API_KEY}`, 'Paddle-Version': '1' }, timeout: 15000 });
        const transaction = response.data.data;
        if (!Array.isArray(transaction.items) || transaction.items.length !== 1 ||
            transaction.items[0].price?.id !== priceId || transaction.items[0].price?.billing_cycle) {
          return res.status(400).json({ error: 'The configured Paddle price must be a one-time price.' });
        }
        payment.transactionId = transaction.id;
        await payment.save();
        res.json({ orderId, transactionId: payment.transactionId, priceId });
      } catch { res.status(502).json({ error: 'Unable to open checkout. Please try again later.' }); }
    },
    async status(req, res) {
      try {
        const token = req.headers['x-ban-checkout-token'];
        const banId = token ? readBanToken(token, { allowExpired: true }) : null;
        if (token && !banId) return res.status(403).json({ error: 'Invalid checkout reference.' });
        const payment = await UnbanPayment.findOne({ orderId: req.params.orderId, ...(banId ? { banId } : { ip: clientIp(req) }) });
        if (!payment) return res.status(404).json({ error: 'Payment not found.' });
        res.json({ status: payment.status });
      } catch { res.status(503).json({ error: 'Unable to check payment.' }); }
    },
    async webhook(req, res) {
      if (!verifySignature(req.body, req.headers['paddle-signature'], process.env.PADDLE_WEBHOOK_SECRET)) return res.sendStatus(400);
      let event;
      try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
      if (event.event_type !== 'transaction.completed') return res.sendStatus(200);
      try {
        const orderId = event.data?.custom_data?.order_id;
        if (typeof orderId !== 'string') return res.sendStatus(200);
        const payment = await UnbanPayment.findOne({ orderId });
        if (!payment) return res.sendStatus(200);
        // A webhook may race transaction creation; let Paddle retry after the ID is saved.
        if (!payment.transactionId) return res.sendStatus(503);
        if (!isExpectedTransaction(event.data, payment)) return res.sendStatus(400);
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
      } catch { res.sendStatus(503); }
    },
  };
}
