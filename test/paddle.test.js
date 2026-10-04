import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, isExpectedTransaction, isPaidReactivationEligible, missingPaddleSettings } from '../payments/paddle.js';
const secret='unit-test-secret';
const ts=String(Math.floor(Date.now()/1000));
const raw=Buffer.from('{"event_type":"transaction.completed"}');
const header=`ts=${ts};h1=${createHmac('sha256',secret).update(ts+':').update(raw).digest('hex')}`;
test('Paddle signatures require original body, matching secret and recent timestamp',()=>{
 assert.equal(verifySignature(raw,header,secret),true);
 assert.equal(verifySignature(Buffer.from('{}'),header,secret),false);
 assert.equal(verifySignature(raw,header,'wrong'),false);
 assert.equal(verifySignature(raw,header,secret,Date.now()+60000),false);
 assert.equal(verifySignature(raw,'ts=bad;h1=bad',secret),false);
});
test('only the exact completed one-time transaction is eligible',()=>{
 const payment={transactionId:'txn_test',orderId:'order-test',priceId:'pri_01m429f20x3bj3nr3qkp99f1t0'};
 const data={id:'txn_test',status:'completed',custom_data:{order_id:'order-test'},items:[{quantity:1,price:{id:'pri_01m429f20x3bj3nr3qkp99f1t0',billing_cycle:null}}]};
 assert.equal(isExpectedTransaction(data,payment),true);
 for(const change of [{id:'txn_other'},{status:'paid'},{subscription_id:'sub_test'},{custom_data:{order_id:'other'}},{items:[{quantity:1,price:{id:'pri_other'}}]}]) assert.equal(isExpectedTransaction({...data,...change},payment),false);
});
test('only explicitly eligible active temporary bans may be released',()=>{
 const active={status:'active',reactivationEligible:true,expiry:new Date(Date.now()+60000)};
 assert.equal(isPaidReactivationEligible(active),true);
 assert.equal(isPaidReactivationEligible({...active,reactivationEligible:false}),false);
 assert.equal(isPaidReactivationEligible({...active,status:'closed'}),false);
 assert.equal(isPaidReactivationEligible({...active,expiry:new Date(Date.now()-1)}),false);
 assert.equal(isPaidReactivationEligible({...active,expiry:null}),false);
});


test('Paddle readiness identifies missing configuration without returning secrets',()=>{
 assert.deepEqual(missingPaddleSettings({}),['PADDLE_API_KEY','PADDLE_WEBHOOK_SECRET','PADDLE_UNBAN_PRICE_ID','PADDLE_ENVIRONMENT']);
 assert.deepEqual(missingPaddleSettings({PADDLE_API_KEY:'private',PADDLE_WEBHOOK_SECRET:'secret',PADDLE_UNBAN_PRICE_ID:'pri_01m429f20x3bj3nr3qkp99f1t0',PADDLE_ENVIRONMENT:'sandbox'}),[]);
 assert.deepEqual(missingPaddleSettings({PADDLE_API_KEY:'private',PADDLE_WEBHOOK_SECRET:' ',PADDLE_UNBAN_PRICE_ID:'invalid',PADDLE_ENVIRONMENT:'sandbox'}),['PADDLE_WEBHOOK_SECRET']);
});


test('configuration distinguishes whitespace, absent values, malformed IDs and environments', async()=>{
 const { paddleSettings, validatePaddleSettings, paddleConfiguration } = await import('../payments/diagnostics.js');
 const id='pri_01m429f20x3bj3nr3qkp99f1t0';
 const base={PADDLE_API_KEY:'private',PADDLE_WEBHOOK_SECRET:'secret',PADDLE_UNBAN_PRICE_ID:id,PADDLE_ENVIRONMENT:'sandbox'};
 for (const whitespace of ['', ' ', '\n', '\t', '\r\n']) {
  const env={...base,PADDLE_UNBAN_PRICE_ID:whitespace+id+whitespace,PADDLE_ENVIRONMENT:' sandbox\n'};
  assert.deepEqual(validatePaddleSettings(env),{missing:[],invalid:[]});
  assert.equal(paddleSettings(env).priceId,id);
  const diag=paddleConfiguration(env);
  assert.equal(diag.hasUnbanPriceId,true);assert.equal(diag.priceIdStartsWithPri,true);assert.equal(diag.priceIdLength,30);
  assert.equal(diag.priceIdWhitespaceTrimmed,Boolean(whitespace));
  for(const value of [id,'private','secret'])assert.ok(!JSON.stringify(diag).includes(value));
 }
 for(const value of [undefined,'',' \n'])assert.deepEqual(validatePaddleSettings({...base,PADDLE_UNBAN_PRICE_ID:value}),{missing:['PADDLE_UNBAN_PRICE_ID'],invalid:[]});
 for(const value of [id.toUpperCase(),'pro_'+id.slice(4),'"'+id+'"',id.slice(0,8)+' '+id.slice(8)]) {
  assert.deepEqual(validatePaddleSettings({...base,PADDLE_UNBAN_PRICE_ID:value}),{missing:[],invalid:['PADDLE_UNBAN_PRICE_ID']});
 }
 assert.deepEqual(validatePaddleSettings({...base,PADDLE_ENVIRONMENT:'wrong'}),{missing:[],invalid:['PADDLE_ENVIRONMENT']});
});


test('local price checks accept variable lengths and delegate validity to Paddle', async()=>{
 const { validatePaddleSettings, paddlePriceConfiguration } = await import('../payments/diagnostics.js');
 for (const id of ['pri_', 'pri_short', 'pri_'+'a'.repeat(80), 'pri_ABC-123']) {
  const env={PADDLE_API_KEY:'private',PADDLE_WEBHOOK_SECRET:'secret',PADDLE_UNBAN_PRICE_ID:' '+id+'\n',PADDLE_ENVIRONMENT:'sandbox'};
  assert.deepEqual(validatePaddleSettings(env),{missing:[],invalid:[]});
  assert.deepEqual(paddlePriceConfiguration(env),{configured:true,startsWithPri:true,length:id.length,containsWhitespace:false});
  assert.ok(!JSON.stringify(paddlePriceConfiguration(env)).includes(id));
 }
});
