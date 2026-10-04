export const priceIdValid = value => /^pri_[a-z0-9]{26}$/.test(value || '');
export function paddleEnvironment() {
  return process.env.PADDLE_ENVIRONMENT || 'sandbox';
}
export function paddleConfiguration() {
  const environment = paddleEnvironment();
  return {
    environment: ['sandbox', 'production'].includes(environment) ? environment : 'invalid',
    apiKeyConfigured: Boolean(process.env.PADDLE_API_KEY?.trim()),
    webhookSecretConfigured: Boolean(process.env.PADDLE_WEBHOOK_SECRET?.trim()),
    unbanPriceConfigured: Boolean(process.env.PADDLE_UNBAN_PRICE_ID?.trim()),
    priceIdPrefixValid: priceIdValid(process.env.PADDLE_UNBAN_PRICE_ID),
  };
}
export function paddleRequestOptions() {
  return { headers: { Authorization: `Bearer ${process.env.PADDLE_API_KEY?.trim()}`, 'Paddle-Version': '1', 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 0 };
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
  const secretValues = [process.env.PADDLE_API_KEY, process.env.PADDLE_WEBHOOK_SECRET].filter(Boolean);
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
