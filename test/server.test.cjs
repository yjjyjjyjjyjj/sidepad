const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { DisplayServer, validSignal } = require('../src/server.cjs');
const { receiverMetrics } = require('../src/shared/diagnostics.js');

async function setup(t) {
  const server = await new DisplayServer({ port: 0, bind: '127.0.0.1' }).listen();
  t.after(() => server.close());
  return server;
}
async function connect(server) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/signal`, { origin: `http://127.0.0.1:${server.port}` });
  ws.on('error', () => {});
  await once(ws, 'open');
  return ws;
}
function join(ws, token) { ws.send(JSON.stringify({ type: 'join', token })); }
async function paired(server) {
  const ws = await connect(server);
  const welcome = once(ws, 'message');
  join(ws, server.token);
  const [raw] = await welcome;
  assert.equal(JSON.parse(raw).type, 'welcome');
  return ws;
}

test('viewer files work and cannot read local files or pairing secrets', async t => {
  const server = await setup(t);
  const response = await fetch(`http://127.0.0.1:${server.port}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('Sidepad'));
  assert.ok(!html.includes(server.token));
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/src/main.cjs`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/diagnostics.js`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/?token=${server.token}`)).status, 404);
});
test('invalid pairing is rejected without claiming the viewer slot', async t => {
  const server = await setup(t);
  const ws = await connect(server);
  const closed = once(ws, 'close');
  join(ws, '0'.repeat(48));
  assert.equal((await closed)[0], 4003);
  assert.equal(server.viewer, null);
});
test('only one authenticated viewer may receive screen signaling', async t => {
  const server = await setup(t);
  const first = await paired(server);
  const second = await connect(server);
  const closed = once(second, 'close');
  join(second, server.token);
  assert.equal((await closed)[0], 4009);
  const received = once(first, 'message');
  server.send({ type: 'offer', sdp: 'private video description' });
  assert.equal(JSON.parse((await received)[0]).sdp, 'private video description');
});
test('foreign web origins cannot open a signaling socket', async t => {
  const server = await setup(t);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/signal`, { origin: 'https://example.com' });
  const error = await new Promise(resolve => ws.once('error', resolve));
  assert.match(error.message, /403/);
});
test('stale peer identifiers cannot send to a replacement device', async t => {
  const server = await setup(t);
  const ws = await paired(server);
  const oldId = server.peerId;
  const left = once(server, 'viewer');
  ws.close();
  await left;
  await paired(server);
  assert.notEqual(server.peerId, oldId);
  assert.equal(server.send({ type: 'offer', sdp: 'stale' }, oldId), false);
});
test('validated viewer answers reach the host only during capture', async t => {
  const server = await setup(t);
  const ws = await paired(server);
  server.setActive(true);
  const signaled = once(server, 'signal');
  ws.send(JSON.stringify({ type: 'answer', sessionId: 'a', sdp: 'answer' }));
  const [event] = await signaled;
  assert.equal(event.peerId, server.peerId);
  assert.equal(event.signal.sdp, 'answer');
  const stopped = once(ws, 'message');
  server.setActive(false);
  assert.equal(JSON.parse((await stopped)[0]).type, 'stopped');
  // A late answer after Stop must not kick out the paired viewer.
  ws.send(JSON.stringify({ type: 'answer', sessionId: 'a', sdp: 'late answer' }));
  const retry = once(server, 'retry');
  ws.send(JSON.stringify({ type: 'retry' }));
  assert.equal((await retry)[0].peerId, server.peerId);
});
test('malformed messages fail closed and free the viewer slot', async t => {
  const server = await setup(t);
  const ws = await paired(server);
  const closed = once(ws, 'close');
  ws.send('{');
  assert.equal((await closed)[0], 4002);
});
test('viewer cannot send offers or arbitrary control instructions', () => {
  assert.equal(validSignal({ type: 'offer', sdp: 'attack' }), false);
  assert.equal(validSignal({ type: 'answer', sdp: 123 }), false);
  assert.equal(validSignal({ type: 'answer', sdp: 'x'.repeat(70000) }), false);
  assert.equal(validSignal({ type: 'candidate', candidate: { candidate: 'x', sdpMid: '0', sdpMLineIndex: -1 } }), false);
  assert.equal(validSignal({ type: 'candidate', candidate: { candidate: 'x', sdpMid: '0', sdpMLineIndex: 0 } }), true);
});

test('authenticated receiver diagnostics are forwarded only while capture is active', async t => {
  const server = await setup(t);
  const ws = await paired(server);
  const metrics = receiverMetrics({ id: 'in', timestamp: 1 }, null, null, false);
  const data = { type: 'diagnostics', sessionId: 'session', sequence: 0, metrics };
  server.setActive(true);
  const forwarded = once(server, 'signal');
  ws.send(JSON.stringify(data));
  assert.deepEqual((await forwarded)[0].signal, data);
  const stopped = once(ws, 'message');
  server.setActive(false);
  await stopped;
  let count = 0;
  server.on('signal', () => count++);
  ws.send(JSON.stringify({ ...data, sequence: 1 }));
  const retry = once(server, 'retry');
  ws.send(JSON.stringify({ type: 'retry' }));
  await retry;
  assert.equal(count, 0);
  assert.equal(validSignal({ ...data, metrics: { ...metrics, decodeMs: -1 } }), false);
  assert.equal(validSignal({ ...data, sessionId: 'x'.repeat(65) }), false);
  assert.equal(validSignal({ ...data, sequence: 1.5 }), false);
});
