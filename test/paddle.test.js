import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, isExpectedTransaction } from '../payments/paddle.js';
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
 const payment={transactionId:'txn_test',orderId:'order-test',priceId:'pri_test'};
 const data={id:'txn_test',status:'completed',custom_data:{order_id:'order-test'},items:[{quantity:1,price:{id:'pri_test',billing_cycle:null}}]};
 assert.equal(isExpectedTransaction(data,payment),true);
 for(const change of [{id:'txn_other'},{status:'paid'},{subscription_id:'sub_test'},{custom_data:{order_id:'other'}},{items:[{quantity:1,price:{id:'pri_other'}}]}]) assert.equal(isExpectedTransaction({...data,...change},payment),false);
});
