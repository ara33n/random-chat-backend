// Supply PADDLE_RECONCILE_ORDER_ID and PADDLE_RECONCILE_TRANSACTION_ID privately.
// Does not create a transaction or remove a ban. Re-send the completed webhook afterward.
import fs from 'node:fs';
import mongoose from 'mongoose';
import axios from 'axios';
import { UnbanPayment } from '../payments/paddle.js';
import { paddleEnvironment, paddleOrigin, paddleRequestOptions, logPaddleError } from '../payments/diagnostics.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
try {
  const orderId = process.env.PADDLE_RECONCILE_ORDER_ID;
  const transactionId = process.env.PADDLE_RECONCILE_TRANSACTION_ID;
  if (!orderId || !/^txn_[a-z0-9]{26}$/.test(transactionId || '')) throw new Error('Missing references');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const payment = await UnbanPayment.findOne({ orderId });
  if (!payment || (payment.environment && payment.environment !== paddleEnvironment()) ||
      (payment.transactionId && payment.transactionId !== transactionId)) throw new Error('Payment mismatch');
  const data = (await axios.get(paddleOrigin() + '/transactions/' + transactionId, paddleRequestOptions())).data?.data;
  if (data?.id !== transactionId || data.custom_data?.order_id !== orderId || data.subscription_id ||
      !['draft', 'ready', 'paid', 'completed'].includes(data.status) || data.items?.length !== 1 ||
      data.items[0].quantity !== 1 || data.items[0].price?.id !== payment.priceId || data.items[0].price?.billing_cycle) throw new Error('Transaction mismatch');
  const result = await UnbanPayment.updateOne({ _id: payment._id, status: { $in: ['unknown', 'pending'] },
      $or: [{ transactionId: { $exists: false } }, { transactionId }] },
    { $set: { transactionId, environment: paddleEnvironment(), status: 'pending' }, $unset: { failureCode: 1 } });
  console.info('[Paddle] reconciliation', { matched: result.matchedCount === 1, requiresCompletedWebhook: data.status === 'completed' });
} catch (error) { logPaddleError(error, 'reconciliation'); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
