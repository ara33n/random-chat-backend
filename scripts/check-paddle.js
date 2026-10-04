// Read-only diagnostics. Run inside Render Shell so it uses Render's environment.
import fs from 'node:fs';
import axios from 'axios';
import { paddleConfiguration, paddleOrigin, paddleRequestOptions, logPaddleError } from '../payments/diagnostics.js';
import { missingPaddleSettings } from '../payments/paddle.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
console.info('[Paddle] configuration', paddleConfiguration());
if (missingPaddleSettings().length) process.exitCode = 1;
else {
  try {
    const price = (await axios.get(paddleOrigin() + '/prices/' + process.env.PADDLE_UNBAN_PRICE_ID, paddleRequestOptions())).data?.data;
    const valid = price?.id === process.env.PADDLE_UNBAN_PRICE_ID && price.status === 'active' && !price.billing_cycle;
    console.info('[Paddle] price check', { sameAccountAndEnvironment: price?.id === process.env.PADDLE_UNBAN_PRICE_ID, activeOneTimePrice: valid });
    if (!valid) process.exitCode = 1;
  } catch (error) { logPaddleError(error, 'diagnostics.price_lookup'); process.exitCode = 1; }
}
