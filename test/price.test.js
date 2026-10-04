import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {minorAmount,priceHandlers} from '../payments/price.js';
test('price amounts use currency precision without floating-point rounding',()=>{
 assert.equal(minorAmount('1.25',2),'125');assert.equal(minorAmount('123',0),'123');assert.equal(minorAmount('1.234',3),'1234');
 for(const value of ['-1','0','1.001','1e3','NaN',''])assert.equal(minorAmount(value,2),null);
});
test('admin price update changes only configured one-time price in its existing currency',async()=>{
 const previous={...process.env};
 Object.assign(process.env,{PADDLE_ENVIRONMENT:'sandbox',PADDLE_API_KEY:'test',PADDLE_WEBHOOK_SECRET:'test',PADDLE_UNBAN_PRICE_ID:'pri_price_test'});
 const price={id:'pri_price_test',status:'active',billing_cycle:null,unit_price:{amount:'100',currency_code:'USD'}};
 const get=mock.method(axios,'get',async()=>({data:{data:price}}));
 const patch=mock.method(axios,'patch',async(url,body)=>{
  assert.equal(url,'https://sandbox-api.paddle.com/prices/pri_price_test');
  assert.deepEqual(body,{unit_price:{amount:'250',currency_code:'USD'}});
  return {data:{data:{...price,unit_price:body.unit_price}}};
 });
 const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
 try{
  await priceHandlers.update({body:{amount:'2.50',currency:'USD'}},res);assert.equal(res.body.amountMinor,'250');
  await priceHandlers.update({body:{amount:'2.50',currency:'EUR'}},res);assert.equal(res.statusCode,400);assert.equal(patch.mock.callCount(),1);
 }finally{get.mock.restore();patch.mock.restore();for(const key of ['PADDLE_ENVIRONMENT','PADDLE_API_KEY','PADDLE_WEBHOOK_SECRET','PADDLE_UNBAN_PRICE_ID']){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});
