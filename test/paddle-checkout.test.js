import { test, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import axios from 'axios';
import { paddleHandlers, UnbanPayment } from '../payments/paddle.js';
import { safePaddleError, paddleConfiguration } from '../payments/diagnostics.js';
const mongo=process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017';
assert.match(mongo,/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/?$/);
const priceId='pri_01m429f20x3bj3nr3qkp99f1t0';
const transactionId='txn_01m429f20x3bj3nr3qkp99f1t0';
before(async()=>{
 process.env.PADDLE_API_KEY='test-api-secret';process.env.PADDLE_WEBHOOK_SECRET='test-webhook-secret';
 process.env.PADDLE_UNBAN_PRICE_ID=priceId;process.env.PADDLE_ENVIRONMENT='sandbox';
 await mongoose.connect(mongo.replace(/\/$/,'')+'/paddle_checkout_test_'+process.pid);await UnbanPayment.init();
});
after(async()=>{await mongoose.connection.dropDatabase();await mongoose.disconnect();});
beforeEach(async()=>{await UnbanPayment.deleteMany({});});
function setup(){
 const ban={_id:new mongoose.Types.ObjectId(),ip:'192.0.2.1',status:'active',reactivationEligible:true,expiry:new Date(Date.now()+60000)};
 const handler=paddleHandlers({getBanModel:()=>({}),getActiveBan:async()=>ban,clientIp:()=>ban.ip});
 const request=()=>{const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};return handler.checkout({body:{}},res).then(()=>res);};
 return {ban,request};
}
function mocks(post){
 const get=mock.method(axios,'get',async(url,options)=>{
  assert.equal(url,'https://sandbox-api.paddle.com/prices/'+priceId);
  assert.equal(options.headers['Content-Type'],'application/json');assert.equal(options.headers['Paddle-Version'],'1');
  assert.equal(options.headers.Authorization,'Bearer test-api-secret');
  return {data:{data:{id:priceId,status:'active',billing_cycle:null}}};
 });
 const create=mock.method(axios,'post',post);
 const log=mock.method(console,'error',()=>{});
 return {get,create,log,restore(){get.mock.restore();create.mock.restore();log.mock.restore();}};
}
const success=async(url,body)=>{
 assert.equal(url,'https://sandbox-api.paddle.com/transactions');
 return {data:{data:{id:transactionId,items:[{quantity:1,price:{id:priceId,billing_cycle:null}}],custom_data:body.custom_data}}};
};
test('concurrent checkout requests create one transaction and retries reuse it',async()=>{
 const {ban,request}=setup();const m=mocks(success);
 try {
  const responses=await Promise.all([request(),request(),request()]);
  assert.ok(responses.some(r=>r.statusCode===200));
  assert.equal(m.create.mock.callCount(),1);
  const retry=await request();assert.equal(retry.body.transactionId,transactionId);
  assert.equal(m.create.mock.callCount(),1);assert.equal(await UnbanPayment.countDocuments({banId:ban._id}),1);
 }finally{m.restore();}
});
test('explicit JSON rejection is saved as failed and retries the same intent',async()=>{
 const {ban,request}=setup();let count=0;
 const m=mocks(async(...args)=>{if(!count++)throw {response:{status:400,data:{error:{code:'transaction_default_checkout_url_not_set'}}}};return success(...args);});
 try {
  const first=await request();assert.equal(first.statusCode,502);assert.equal(first.body.code,'PADDLE_TRANSACTION_CREATE_FAILED');
  const before=await UnbanPayment.findOne({banId:ban._id});assert.equal(before.status,'failed');
  const retry=await request();assert.equal(retry.statusCode,200);assert.equal(retry.body.orderId,before.orderId);
  assert.equal(await UnbanPayment.countDocuments({banId:ban._id}),1);
 }finally{m.restore();}
});
test('timeout and legacy orphan require reconciliation without another POST',async()=>{
 const {ban,request}=setup();const m=mocks(async()=>{throw {code:'ECONNABORTED'};});
 try {
  assert.equal((await request()).statusCode,502);
  assert.equal((await UnbanPayment.findOne({banId:ban._id})).status,'unknown');
  assert.equal((await request()).body.code,'PADDLE_RECONCILIATION_REQUIRED');assert.equal(m.create.mock.callCount(),1);
  const legacy=setup();await UnbanPayment.create({orderId:'legacy',banId:legacy.ban._id,ip:legacy.ban.ip,priceId});
  assert.equal((await legacy.request()).body.code,'PADDLE_RECONCILIATION_REQUIRED');assert.equal(m.create.mock.callCount(),1);
 }finally{m.restore();}
});
test('database save failure after successful POST never sends a second POST',async()=>{
 const {request}=setup();const m=mocks(success);
 const original=UnbanPayment.updateOne.bind(UnbanPayment);let first=true;
 const save=mock.method(UnbanPayment,'updateOne',(...args)=>{if(first){first=false;throw new Error('database failed');}return original(...args);});
 try {
  const response=await request();assert.equal(response.statusCode,503);assert.equal(response.body.code,'PADDLE_DATABASE_ERROR');
  assert.equal((await request()).body.code,'PADDLE_RECONCILIATION_REQUIRED');assert.equal(m.create.mock.callCount(),1);
 }finally{save.mock.restore();m.restore();}
});
test('price lookup failure never creates a transaction',async()=>{
 const {ban,request}=setup();const m=mocks(success);m.get.mock.restore();
 const get=mock.method(axios,'get',async()=>{throw {response:{status:403,data:{error:{code:'forbidden'}}}};});
 try {
  const response=await request();assert.equal(response.body.code,'PADDLE_PRICE_LOOKUP_FAILED');assert.equal(response.body.missing,undefined);assert.equal(m.create.mock.callCount(),0);
  assert.equal((await UnbanPayment.findOne({banId:ban._id})).status,'failed');
 }finally{get.mock.restore();m.create.mock.restore();m.log.mock.restore();}
});
test('ineligible bans cannot create a Paddle transaction',async()=>{
 const ban={_id:new mongoose.Types.ObjectId(),ip:'192.0.2.55',status:'active',reactivationEligible:false,expiry:new Date(Date.now()+60000)};
 const handler=paddleHandlers({getBanModel:()=>({}),getActiveBan:async()=>ban,clientIp:()=>ban.ip});
 const get=mock.method(axios,'get',async()=>{throw new Error('Paddle must not be called');});
 const post=mock.method(axios,'post',async()=>{throw new Error('Paddle must not be called');});
 const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
 try {
  await handler.checkout({body:{}},res);
  assert.equal(res.statusCode,409);assert.equal(res.body.code,'BAN_NOT_ELIGIBLE');
  assert.equal(get.mock.callCount(),0);assert.equal(post.mock.callCount(),0);
 } finally {get.mock.restore();post.mock.restore();}
});
test('logs exclude messages, raw data, tokens, credentials and arbitrary headers',()=>{
 const info=safePaddleError({message:'private ban token',code:'ERR_BAD_REQUEST',config:{headers:{Authorization:'test-api-secret'}},response:{status:400,headers:{'request-id':'00000000-0000-0000-0000-000000000000'},data:{error:{code:'transaction_default_checkout_url_not_set',detail:'test-webhook-secret'},secret:'test-api-secret'}}},'checkout.transaction_create');
 const output=JSON.stringify(info);
 assert.match(output,/transaction_default_checkout_url_not_set/);assert.match(output,/00000000-/);
 for(const secret of ['test-api-secret','test-webhook-secret','private ban token','Authorization'])assert.ok(!output.includes(secret));
 assert.ok(!JSON.stringify(paddleConfiguration()).includes('test-api-secret'));
});

test('checkout uses the trimmed ID in lookup, transaction request and database',async()=>{
 const {ban,request}=setup();const m=mocks(async(url,body)=>{assert.equal(body.items[0].price_id,priceId);return success(url,body);});
 process.env.PADDLE_UNBAN_PRICE_ID=' \t'+priceId+'\r\n';
 process.env.PADDLE_ENVIRONMENT=' sandbox\n';
 try {
  const response=await request();assert.equal(response.statusCode,200);assert.equal(response.body.priceId,priceId);
  const payment=await UnbanPayment.findOne({banId:ban._id});assert.equal(payment.priceId,priceId);assert.equal(payment.environment,'sandbox');
 }finally{process.env.PADDLE_UNBAN_PRICE_ID=priceId;process.env.PADDLE_ENVIRONMENT='sandbox';m.restore();}
});
test('missing and malformed configuration have distinct responses without calling Paddle',async()=>{
 const {request}=setup();const m=mocks(success);
 try {
  process.env.PADDLE_UNBAN_PRICE_ID=' \n';
  const absent=await request();assert.equal(absent.body.code,'PADDLE_CONFIGURATION_MISSING');assert.deepEqual(absent.body.missing,['PADDLE_UNBAN_PRICE_ID']);
  process.env.PADDLE_UNBAN_PRICE_ID='pri_bad value';
  const malformed=await request();assert.equal(malformed.body.code,'PADDLE_PRICE_ID_INVALID');assert.equal(malformed.body.missing,undefined);assert.deepEqual(malformed.body.invalid,['PADDLE_UNBAN_PRICE_ID']);
  process.env.PADDLE_UNBAN_PRICE_ID=priceId;process.env.PADDLE_ENVIRONMENT='bad';
  const environment=await request();assert.equal(environment.body.code,'PADDLE_ENVIRONMENT_INVALID');assert.equal(environment.body.missing,undefined);
  assert.equal(m.get.mock.callCount(),0);assert.equal(m.create.mock.callCount(),0);
 }finally{process.env.PADDLE_UNBAN_PRICE_ID=priceId;process.env.PADDLE_ENVIRONMENT='sandbox';m.restore();}
});


test('variable-length price reaches Paddle; 404 is lookup failure, never missing',async()=>{
 const {request}=setup();const m=mocks(success);m.get.mock.restore();
 const id='pri_short/with?reserved#characters';
 process.env.PADDLE_UNBAN_PRICE_ID=' '+id+'\n';
 const get=mock.method(axios,'get',async url=>{
  assert.equal(url,'https://sandbox-api.paddle.com/prices/'+encodeURIComponent(id));
  throw {response:{status:404,data:{error:{code:'not_found'}}}};
 });
 try {
  const response=await request();assert.equal(response.statusCode,502);
  assert.equal(response.body.code,'PADDLE_PRICE_LOOKUP_FAILED');assert.equal(response.body.missing,undefined);
  assert.equal(get.mock.callCount(),1);assert.equal(m.create.mock.callCount(),0);
 }finally{process.env.PADDLE_UNBAN_PRICE_ID=priceId;get.mock.restore();m.create.mock.restore();m.log.mock.restore();}
});
