// Read-only diagnostics. Run inside Render Shell so it uses Render's environment.
import fs from 'node:fs';
import axios from 'axios';
import { paddleSettings, validatePaddleSettings, paddleConfiguration, paddleOrigin, paddleRequestOptions, logPaddleError } from '../payments/diagnostics.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
console.info('[Paddle] configuration', paddleConfiguration());
const { missing, invalid } = validatePaddleSettings();
const { priceId } = paddleSettings();
if (missing.length || invalid.length) { console.error('[Paddle] configuration invalid', { missing, invalid }); process.exitCode = 1; }
else {
  try {
    const price = (await axios.get(paddleOrigin() + '/prices/' + priceId, paddleRequestOptions())).data?.data;
    const valid = price?.id === priceId && price.status === 'active' && !price.billing_cycle;
    console.info('[Paddle] price check', { sameAccountAndEnvironment: price?.id === priceId, activeOneTimePrice: valid });
    if (!valid) process.exitCode = 1;
  } catch (error) { logPaddleError(error, 'diagnostics.price_lookup'); process.exitCode = 1; }
}
