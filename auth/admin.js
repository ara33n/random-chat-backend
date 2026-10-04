import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
const scrypt = promisify(scryptCallback);
export const AdminAccount = mongoose.model('AdminAccount', new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  salt: { type: String, required: true },
  passwordHash: { type: String, required: true },
}, { timestamps: true }));
export async function passwordRecord(password) {
  const salt = randomBytes(32).toString('hex');
  return { salt, passwordHash: (await scrypt(password, salt, 64)).toString('hex') };
}
export async function verifyPassword(password, account) {
  if (typeof password !== 'string' || password.length > 256 || !/^[a-f0-9]{128}$/.test(account.passwordHash)) return false;
  const actual = await scrypt(password, account.salt, 64);
  return timingSafeEqual(actual, Buffer.from(account.passwordHash, 'hex'));
}
export async function adminAuth(req, res, next) {
  const user = req.headers['x-admin-user'];
  const pass = req.headers['x-admin-pass'];
  const token = req.headers['x-admin-token'];
  if (process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN) return next();
  try {
    // A provisioned account takes precedence over legacy environment credentials.
    const account = typeof user === 'string' && user.length <= 100
      ? await AdminAccount.findOne({ username: user }) : null;
    if (account) {
      if (await verifyPassword(pass, account)) return next();
    } else if (process.env.ADMIN_USER && process.env.ADMIN_PASS && user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) {
      return next();
    }
    if (!process.env.ADMIN_USER && !process.env.ADMIN_TOKEN && !await AdminAccount.exists({})) {
      return res.status(503).json({ error: 'Admin login is not configured on the server.' });
    }
    return res.status(403).json({ error: 'Unauthorized' });
  } catch { return res.status(503).json({ error: 'Admin login is temporarily unavailable.' }); }
}
