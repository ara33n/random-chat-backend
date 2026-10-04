import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';
import mongoose from 'mongoose';

// Tests must use a disposable local database, never the production MONGO_URI.
const mongo = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017';
assert.match(mongo, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/?$/);
const database = `loopchat_test_${process.pid}`;
const port = 3102;
const url = `http://127.0.0.1:${port}`;
const clients = [];
let server;
const event = (socket, name) => Promise.race([
  once(socket, name).then(([data]) => data),
  delay(5000).then(() => { throw new Error(`Timed out: ${name}`); }),
]);
function client(transport = 'polling') {
  const socket = io(url, { autoConnect: false, transports: [transport], reconnection: false,
    extraHeaders: { Origin: 'https://loopchatx.chat' } });
  clients.push(socket);
  return socket;
}
async function connect(socket) {
  const ready = event(socket, 'connect'); socket.connect(); await ready;
}
async function pair(a, b, mode = 'text') {
  const matched = Promise.all([event(a, 'partner-found'), event(b, 'partner-found')]);
  a.emit('find-partner', { mode, topics: ['music'] });
  b.emit('find-partner', { mode, topics: ['music'] });
  return matched;
}
before(async () => {
  await mongoose.connect(`${mongo.replace(/\/$/, '')}/${database}`, { serverSelectionTimeoutMS: 3000 });
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, MONGO_URI: `${mongo.replace(/\/$/, '')}/${database}`, PORT: `${port}`,
      FRONTEND_ORIGINS: 'https://loopchatx.chat', TRUST_PROXY: 'true', PADDLE_WEBHOOK_SECRET: 'integration-webhook-secret', ADMIN_USER: 'integration-operator', ADMIN_PASS: 'integration-only-secret', ADMIN_TOKEN: '' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${url}/health`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('Test server did not become healthy');
});
after(async () => {
  clients.forEach(socket => socket.disconnect());
  if (server) { const exited = once(server, 'exit'); server.kill(); await exited; }
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('health checks MongoDB and polling permits the configured frontend origin', async () => {
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true, database: 'connected' });
  const response = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://loopchatx.chat' } });
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://loopchatx.chat');
  assert.match(await response.text(), /^0/);
  const other = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://unconfigured.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('immediate matchmaking, messages, typing and video signaling work across transports', async () => {
  const a = client('polling'), b = client('websocket');
  const matched = Promise.all([event(a, 'partner-found'), event(b, 'partner-found')]);
  for (const socket of [a, b]) {
    socket.once('connect', () => socket.emit('find-partner', { mode: 'text', topics: ['music'] }));
    socket.connect();
  }
  const [first, second] = await matched;
  assert.equal(first.partnerId, b.id);
  assert.equal(second.partnerId, a.id);
  assert.deepEqual(first.matchedTopics, ['music']);
  const message = event(b, 'message'); a.emit('message', 'Hello from the integration test');
  assert.equal(await message, 'Hello from the integration test');
  const typing = event(a, 'typing'); b.emit('typing'); await typing;
  const stopped = event(a, 'self-stopped'); a.emit('stop'); await stopped;
  const video = await pair(a, b, 'video'); assert.equal(video[0].mode, 'video');
  assert.notEqual(video[0].initiator, video[1].initiator);
  const signal = event(b, 'signal'); a.emit('signal', { type: 'offer', sdp: 'test-sdp' });
  assert.deepEqual(await signal, { type: 'offer', sdp: 'test-sdp' });
  const left = event(b, 'partner-left'); a.disconnect(); await left; b.disconnect();
});

test('stopped users are removed from the waiting queue', async () => {
  const a = client(), b = client(), c = client();
  await Promise.all([connect(a), connect(b), connect(c)]);
  a.emit('find-partner', { mode: 'text' });
  const stopped = event(a, 'self-stopped'); a.emit('stop'); await stopped;
  const [first, second] = await pair(b, c);
  assert.equal(first.partnerId, c.id); assert.equal(second.partnerId, b.id);
  [a, b, c].forEach(s => s.disconnect());
});

test('active bans reject the handshake before chat events can be sent', async () => {
  await mongoose.connection.collection('bans').insertOne({ ip: '127.0.0.9', status: 'active', reason: 'test', expiry: new Date(Date.now() + 60000), createdAt: new Date() });
  const socket = io(url, { autoConnect: false, reconnection: false, extraHeaders: { Origin: 'https://loopchatx.chat', 'x-forwarded-for': '127.0.0.9' } });
  clients.push(socket);
  const failure = event(socket, 'connect_error'); socket.connect();
  const error = await failure; assert.equal(error.message, 'BANNED'); assert.equal(error.data.reason, 'test');
  socket.disconnect();
});

test('reports reject arbitrary targets and ignore client-supplied IPs', async () => {
  const a=client(), b=client(), outsider=client();
  await Promise.all([connect(a),connect(b),connect(outsider)]);
  await pair(a,b);
  const denied=event(a,'report-error');a.emit('report-user',{accusedSocketId:outsider.id,accusedIp:'unrelated',reason:'false target'});await denied;
  const accepted=event(a,'report-success');a.emit('report-user',{accusedSocketId:b.id,accusedIp:'spoofed',reason:'integration report'});await accepted;
  const report=await mongoose.connection.collection('reports').findOne({reason:'integration report'});
  assert.ok(report);assert.notEqual(report.accusedIp,'spoofed');
  [a,b,outsider].forEach(s=>s.disconnect());
});

test('blocked connections cannot match again and other users can still match', async()=>{
  const a=client(),b=client(),c=client();await Promise.all([connect(a),connect(b),connect(c)]);await pair(a,b);
  const blocked=event(a,'block-success');a.emit('block-user');await blocked;
  let reunited=false;a.on('partner-found',data=>{if(data.partnerId===b.id) reunited=true;});
  a.emit('find-partner',{mode:'text'});b.emit('find-partner',{mode:'text'});await delay(150);assert.equal(reunited,false);
  const matched=event(c,'partner-found');c.emit('find-partner',{mode:'text'});await matched;
  [a,b,c].forEach(s=>s.disconnect());
});

test('admin, snapshots and payment records cannot be read anonymously',async()=>{
 for(const path of ['/admin/session','/admin/reports','/snapshots/anything.png']){
  const response=await fetch(url+path);assert.equal(response.status,403);assert.match(response.headers.get('x-robots-tag'),/noindex/);
 }
 assert.equal((await fetch(url+'/api/payment-status/order_example')).status,410);
 const invalid=await fetch(url+'/admin/ban-user',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ip:{$ne:null}})});
 assert.equal(invalid.status,400);
});

test('socket message flooding is limited',async()=>{
 const a=client(),b=client();await Promise.all([connect(a),connect(b)]);await pair(a,b);
 const limited=event(a,'rate-limit');for(let i=0;i<35;i++)a.emit('message','hello');await limited;
 [a,b].forEach(s=>s.disconnect());
});


test('reviewed reports enforce a real ban and support unban', async()=>{
 const a=client(),b=client();b.io.opts.extraHeaders['x-forwarded-for']='127.0.0.23';
 await Promise.all([connect(a),connect(b)]);await pair(a,b);
 const accepted=event(a,'report-success');a.emit('report-user',{accusedSocketId:b.id,reason:'enforcement-test'});await accepted;
 const report=await mongoose.connection.collection('reports').findOne({reason:'enforcement-test'});
 const headers={'content-type':'application/json','x-admin-user':'integration-operator','x-admin-pass':'integration-only-secret'};
 assert.equal((await fetch(url+'/admin/session',{headers})).status,200);
 const banned=event(b,'banned');
 const result=await fetch(url+'/admin/resolve-report',{method:'POST',headers,body:JSON.stringify({reportId:String(report._id),action:'ban'})});
 assert.equal(result.status,200);await banned;
 const ban=await mongoose.connection.collection('bans').findOne({ip:'127.0.0.23',status:'active'});assert.ok(ban);
 const closed=await fetch(url+'/admin/unban-user',{method:'POST',headers,body:JSON.stringify({banId:String(ban._id)})});assert.equal(closed.status,200);
 [a,b].forEach(s=>s.disconnect());
});


test('signed Paddle fulfillment closes only its paid ban and is idempotent', async()=>{
 const bans=mongoose.connection.collection('bans');
 const ip='127.0.0.29';
 const first=await bans.insertOne({ip,reason:'paid test ban',status:'active',expiry:new Date(Date.now()+60000)});
 const second=await bans.insertOne({ip,reason:'later ban',status:'active',expiry:new Date(Date.now()+60000)});
 const orderId='integration-paddle-order';
 await mongoose.connection.collection('unbanpayments').insertOne({orderId,banId:first.insertedId,ip,priceId:'pri_test',transactionId:'txn_test',status:'pending'});
 const data={id:'txn_test',status:'completed',custom_data:{order_id:orderId},items:[{quantity:1,price:{id:'pri_test',billing_cycle:null}}]};
 async function send(body,valid=true){
   const ts=String(Math.floor(Date.now()/1000));
   const signature=createHmac('sha256',valid?'integration-webhook-secret':'wrong').update(ts+':'+body).digest('hex');
   return fetch(url+'/api/paddle/webhook',{method:'POST',headers:{'content-type':'application/json','paddle-signature':`ts=${ts};h1=${signature}`},body});
 }
 const body=JSON.stringify({event_type:'transaction.completed',data});
 assert.equal((await send(body,false)).status,400);
 assert.equal((await bans.findOne({_id:first.insertedId})).status,'active');
 assert.equal((await send(JSON.stringify({event_type:'transaction.completed',data:{...data,id:'txn_wrong'}}))).status,400);
 assert.equal((await send(body)).status,200);
 assert.equal((await send(body)).status,200);
 assert.equal((await bans.findOne({_id:first.insertedId})).status,'closed');
 assert.equal((await bans.findOne({_id:second.insertedId})).status,'active');
 const status=await fetch(url+'/api/paddle/status/'+orderId,{headers:{'x-forwarded-for':ip}});
 assert.deepEqual(await status.json(),{status:'completed'});
 assert.equal((await fetch(url+'/api/paddle/status/'+orderId)).status,404);
});


test('only the apex and www production browser origins are accepted for HTTP and WebSocket', async()=>{
 for (const origin of ['https://loop-chatx.vercel.app','http://localhost:4200','https://loopchatx.chat.evil.example','null']) {
   const response=await fetch(url+'/health',{headers:{Origin:origin}});
   assert.equal(response.status,403,origin);
   const socket=io(url,{autoConnect:false,reconnection:false,transports:['websocket'],extraHeaders:{Origin:origin}});clients.push(socket);
   const rejected=event(socket,'connect_error');socket.connect();await rejected;socket.disconnect();
 }
 const socket=io(url,{autoConnect:false,reconnection:false,transports:['websocket']});clients.push(socket);
 const rejected=event(socket,'connect_error');socket.connect();await rejected;socket.disconnect();
 for (const origin of ['https://loopchatx.chat', 'https://www.loopchatx.chat']) {
   const response = await fetch(url+'/health',{headers:{Origin:origin}});
   assert.equal(response.status,200);
   assert.equal(response.headers.get('access-control-allow-origin'),origin);
   const allowed = io(url,{autoConnect:false,reconnection:false,transports:['websocket'],extraHeaders:{Origin:origin}});
   clients.push(allowed);await connect(allowed);allowed.disconnect();
   const polling = await fetch(url+'/socket.io/?EIO=4&transport=polling',{headers:{Origin:origin}});
   assert.equal(polling.status,200);
   assert.equal(polling.headers.get('access-control-allow-origin'),origin);
 }

});
