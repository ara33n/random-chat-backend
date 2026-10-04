import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import axios from 'axios';
import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  orderId: { type: String, unique: true, required: true },
  banId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  ip: { type: String, required: true },
  priceId: { type: String, required: true },
  transactionId: { type: String },
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

export function paddleHandlers({ getBanModel, getActiveBan, clientIp }) {
  const configured = () => !!(process.env.PADDLE_API_KEY && process.env.PADDLE_WEBHOOK_SECRET && /^pri_[a-z0-9]+$/.test(process.env.PADDLE_UNBAN_PRICE_ID || ''));
  return {
    async checkout(req, res) {
      if (!configured()) return res.status(503).json({ error: 'Paddle checkout is not configured yet.' });
      try {
        await UnbanPayment.init();
        const ip = clientIp(req);
        const ban = await getActiveBan({ ip });
        if (!ban) return res.status(409).json({ error: 'No active payable ban. Temporary word-filter restrictions expire automatically.' });
        const existing = await UnbanPayment.findOne({ banId: ban._id, status: 'pending', transactionId: { $exists: true } });
        if (existing) return res.json({ orderId: existing.orderId, transactionId: existing.transactionId, priceId: existing.priceId });
        const orderId = randomUUID();
        const priceId = process.env.PADDLE_UNBAN_PRICE_ID;
        const payment = await UnbanPayment.create({ orderId, banId: ban._id, ip, priceId });
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
        const payment = await UnbanPayment.findOne({ orderId: req.params.orderId, ip: clientIp(req) });
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
        if (payment.status === 'completed') return res.sendStatus(200);
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
