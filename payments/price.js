import axios from 'axios';
import { paddleSettings, paddleEnvironment, paddleOrigin, paddleRequestOptions, validatePaddleSettings, logPaddleError } from './diagnostics.js';
let cached;
function publicPrice(price) {
  if (price?.id !== paddleSettings().priceId || price.status !== 'active' || price.billing_cycle ||
      !/^\d+$/.test(price.unit_price?.amount || '') || !/^[A-Z]{3}$/.test(price.unit_price?.currency_code || '')) throw new Error('Invalid one-time price');
  const currency = price.unit_price.currency_code;
  const digits = new Intl.NumberFormat('en', {style:'currency',currency}).resolvedOptions().maximumFractionDigits;
  return {amountMinor:price.unit_price.amount,currency,digits,environment:paddleEnvironment()};
}
export function minorAmount(amount, digits) {
  if (typeof amount !== 'string' || !/^\d{1,9}(\.\d{1,3})?$/.test(amount.trim())) return null;
  const [whole, fraction=''] = amount.trim().split('.');
  if (fraction.length > digits) return null;
  const minor = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits,'0') || '0');
  return minor > 0n ? minor.toString() : null;
}
async function readPrice(fresh = false) {
  const {missing,invalid}=validatePaddleSettings();
  if(missing.length || invalid.length) throw new Error('Configuration unavailable');
  const key=paddleEnvironment()+':'+paddleSettings().priceId;
  if(!fresh && cached?.key===key && cached.until>Date.now()) return cached.value;
  const price=(await axios.get(paddleOrigin()+'/prices/'+encodeURIComponent(paddleSettings().priceId),paddleRequestOptions())).data?.data;
  const value=publicPrice(price);cached={key,value,until:Date.now()+30000};return value;
}
export const priceHandlers = {
 async get(req,res) {
  try {res.json(await readPrice(req.path.startsWith('/admin')));}
  catch(error){logPaddleError(error,'price.read');res.status(503).json({code:'PADDLE_PRICE_LOOKUP_FAILED',error:'Price is unavailable. The final amount is shown at checkout.'});}
 },
 async update(req,res) {
  try {
   const current=await readPrice(true);
   const amount=minorAmount(req.body?.amount,current.digits);
   if(!amount || req.body?.currency!==current.currency) return res.status(400).json({error:'Enter a positive amount in the displayed currency with the correct decimal places.'});
   const price=(await axios.patch(paddleOrigin()+'/prices/'+encodeURIComponent(paddleSettings().priceId),
    {unit_price:{amount,currency_code:current.currency}},paddleRequestOptions())).data?.data;
   cached=undefined;
   res.json(publicPrice(price));
  }catch(error){logPaddleError(error,'price.update');res.status(502).json({code:'PADDLE_PRICE_UPDATE_FAILED',error:'Could not update the Paddle price. Check the API key price.write permission and try again.'});}
 }
};
