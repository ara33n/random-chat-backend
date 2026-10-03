import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
    extraHeaders: { Origin: 'http://localhost:4200' } });
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
      FRONTEND_ORIGINS: 'http://localhost:4200' }, stdio: 'ignore',
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
  const response = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'http://localhost:4200' } });
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:4200');
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
  const socket = io(url, { autoConnect: false, reconnection: false, extraHeaders: { 'x-forwarded-for': '127.0.0.9' } });
  clients.push(socket);
  const failure = event(socket, 'connect_error'); socket.connect();
  const error = await failure; assert.equal(error.message, 'BANNED'); assert.equal(error.data.reason, 'test');
  socket.disconnect();
});
