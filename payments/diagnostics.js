// Local syntax check only; Paddle's authenticated price lookup is authoritative.
export const priceIdValid = value => typeof value === 'string' && value.length > 0 && value.startsWith('pri_') && !/\s/.test(value);
export function paddlePriceConfiguration(env = process.env) {
  const priceId = env.PADDLE_UNBAN_PRICE_ID?.trim();
  return { configured: Boolean(priceId), startsWithPri: Boolean(priceId?.startsWith('pri_')), length: priceId?.length || 0, containsWhitespace: /\s/.test(priceId || '') };
}
// Normalize once at every read; never remove internal characters or quotes.
export function paddleSettings(env = process.env) {
  return {
    priceId: env.PADDLE_UNBAN_PRICE_ID?.trim() || '',
    environment: env.PADDLE_ENVIRONMENT?.trim() || 'sandbox',
    apiKey: env.PADDLE_API_KEY?.trim() || '',
    webhookSecret: env.PADDLE_WEBHOOK_SECRET?.trim() || '',
  };
}
export function validatePaddleSettings(env = process.env) {
  const settings = paddleSettings(env);
  const missing = [];
  const invalid = [];
  if (!settings.apiKey) missing.push('PADDLE_API_KEY');
  if (!settings.webhookSecret) missing.push('PADDLE_WEBHOOK_SECRET');
  if (!settings.priceId) missing.push('PADDLE_UNBAN_PRICE_ID');
  else if (!priceIdValid(settings.priceId)) invalid.push('PADDLE_UNBAN_PRICE_ID');
  if (!['sandbox', 'production'].includes(settings.environment)) invalid.push('PADDLE_ENVIRONMENT');
  return { missing, invalid };
}
export function paddleEnvironment() {
  return paddleSettings().environment;
}
export function paddleConfiguration(env = process.env) {
  const { environment, priceId, apiKey, webhookSecret } = paddleSettings(env);
  return {
    environment: ['sandbox', 'production'].includes(environment) ? environment : 'invalid',
    apiKeyConfigured: Boolean(apiKey),
    webhookSecretConfigured: Boolean(webhookSecret),
    hasUnbanPriceId: Boolean(priceId),
    priceIdStartsWithPri: priceId.startsWith('pri_'),
    priceIdLength: priceId.length,
    priceIdFormatValid: priceIdValid(priceId),
    priceIdWhitespaceTrimmed: Boolean(env.PADDLE_UNBAN_PRICE_ID && env.PADDLE_UNBAN_PRICE_ID !== priceId),
  };
}
export function paddleRequestOptions() {
  return { headers: { Authorization: `Bearer ${paddleSettings().apiKey}`, 'Paddle-Version': '1', 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 0 };
}
export function paddleOrigin() {
  const environment = paddleEnvironment();
  if (!['sandbox', 'production'].includes(environment)) throw new Error('Invalid Paddle environment');
  return environment === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
}
// Deliberately omit arbitrary messages/details, request bodies, Axios config and headers.
// Provider error codes are identifiers, never raw data or a Mongo duplicate-key message.
export function safePaddleError(error, operation) {
  const rawCode = error?.response?.data?.error?.code;
  const secretValues = [process.env.PADDLE_API_KEY, process.env.PADDLE_WEBHOOK_SECRET, paddleSettings().apiKey, paddleSettings().webhookSecret].filter(Boolean);
  const paddleCode = typeof rawCode === 'string' && /^[a-z][a-z0-9_]{1,79}$/.test(rawCode) && !secretValues.some(secret => rawCode.includes(secret)) ? rawCode : undefined;
  const rawRequestId = error?.response?.data?.meta?.request_id || error?.response?.headers?.['request-id'];
  const requestId = typeof rawRequestId === 'string' && /^[a-f0-9-]{36}$/i.test(rawRequestId) && !secretValues.includes(rawRequestId) ? rawRequestId : undefined;
  const status = Number.isInteger(error?.response?.status) ? error.response.status : undefined;
  const transportCode = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE'].includes(error?.code) ? error.code : undefined;
  return { operation, environment: paddleConfiguration().environment, message: status ? 'Paddle API request rejected' : 'Operation failed', status, paddleCode, requestId, code: error?.code === 11000 ? 'DUPLICATE_PAYMENT_RECORD' : transportCode };
}
export function logPaddleError(error, operation) {
  console.error('[Paddle]', safePaddleError(error, operation));
}
