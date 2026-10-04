// Run with ADMIN_SETUP_USER and ADMIN_SETUP_PASSWORD supplied privately in the environment.
import fs from 'node:fs';
import mongoose from 'mongoose';
import { AdminAccount, passwordRecord } from '../auth/admin.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
try {
  const username = process.env.ADMIN_SETUP_USER?.trim();
  const password = process.env.ADMIN_SETUP_PASSWORD;
  if (!username || username.length > 100 || !password || password.length < 8 || password.length > 256) throw new Error('Invalid setup fields');
  if (!process.env.MONGO_URI) throw new Error('Missing database configuration');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  await AdminAccount.init();
  await AdminAccount.findOneAndUpdate({ username }, { $set: await passwordRecord(password) }, { upsert: true, runValidators: true });
  console.log('Admin account saved. Deploy the backend before signing in.');
} catch { console.error('Admin setup failed. Check setup fields and database connectivity.'); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
