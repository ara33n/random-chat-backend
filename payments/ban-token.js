import { paddleSettings } from './diagnostics.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
const sign = (value, secret) => createHmac('sha256', secret).update('loopchatx-ban-checkout:' + value).digest('hex');
export function createBanToken(ban, secret = paddleSettings().webhookSecret) {
  if (!secret) return undefined;
  const value = `${ban._id}.${ban.expiry.getTime()}`;
  return `${value}.${sign(value, secret)}`;
}
export function readBanToken(token, { allowExpired = false, secret = paddleSettings().webhookSecret, now = Date.now() } = {}) {
  if (!secret || typeof token !== 'string' || token.length > 160) return null;
  const [id, expiry, signature, extra] = token.split('.');
  if (extra !== undefined || !/^[a-f0-9]{24}$/.test(id || '') || !/^\d{13}$/.test(expiry || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return null;
  const expected = sign(`${id}.${expiry}`, secret);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) return null;
  if (!allowExpired && Number(expiry) <= now) return null;
  return id;
}
