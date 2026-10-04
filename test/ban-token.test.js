import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createBanToken, readBanToken } from '../payments/ban-token.js';
import { paddleHandlers, UnbanPayment } from '../payments/paddle.js';
const secret='test-signing-secret';
const ban={_id:'123456789012345678901234',ip:'192.0.2.1',expiry:new Date(Date.now()+600000)};
test('ban references are signed, expire and reject tampering',()=>{
 const token=createBanToken(ban,secret);
 assert.equal(readBanToken(token,{secret}),ban._id);
 assert.equal(readBanToken(token.slice(0,-1)+(token.endsWith('0')?'1':'0'),{secret}),null);
 assert.equal(readBanToken(token,{secret:'wrong'}),null);
 assert.equal(readBanToken(token,{secret,now:ban.expiry.getTime()+1}),null);
 assert.equal(readBanToken(token,{secret,now:ban.expiry.getTime()+1,allowExpired:true}),ban._id);
});
test('checkout and payment status use the signed ban even if the HTTP IP changes',async()=>{
 const old={...process.env};
 process.env.PADDLE_API_KEY='test-api';process.env.PADDLE_WEBHOOK_SECRET=secret;process.env.PADDLE_UNBAN_PRICE_ID='pri_01m429f20x3bj3nr3qkp99f1t0';
 const token=createBanToken(ban,secret);
 const existing={orderId:'test-order',priceId:'pri_01m429f20x3bj3nr3qkp99f1t0',transactionId:'txn_test',status:'pending',environment:'sandbox'};
 const init=mock.method(UnbanPayment,'init',async()=>{});
 const find=mock.method(UnbanPayment,'findOne',async query=>{assert.equal(String(query.banId),ban._id);assert.equal(query.ip,undefined);return existing;});
 let activeBan=ban;
 const handlers=paddleHandlers({getBanModel:()=>({findOne:async query=>{assert.equal(query._id,ban._id);assert.ok(query.expiry.$gt instanceof Date);return activeBan;}}),getActiveBan:()=>{throw new Error('IP fallback must not be used');},clientIp:()=> '192.0.2.99'});
 const res={statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};
 try{
  await handlers.checkout({body:{banToken:token}},res);assert.equal(res.statusCode,200);assert.equal(res.body.transactionId,'txn_test');
  await handlers.status({headers:{'x-ban-checkout-token':token},params:{orderId:'test-order'}},res);assert.deepEqual(res.body,{status:'pending'});
  activeBan=null;await handlers.checkout({body:{banToken:token}},res);assert.equal(res.statusCode,409);assert.equal(res.body.code,'BAN_NOT_ACTIVE');
  await handlers.checkout({body:{banToken:'tampered'}},res);assert.equal(res.statusCode,403);
 }finally{init.mock.restore();find.mock.restore();for(const key of ['PADDLE_API_KEY','PADDLE_WEBHOOK_SECRET','PADDLE_UNBAN_PRICE_ID']){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}}
});
