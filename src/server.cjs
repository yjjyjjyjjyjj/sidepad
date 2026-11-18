const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { WebSocketServer, WebSocket } = require('ws');
const { validReceiverMetrics } = require('./shared/diagnostics.js');
const { validCodecSummary } = require('./shared/codecs.js');

function validSignal(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'diagnostics') return typeof value.sessionId === 'string' && value.sessionId.length <= 64 &&
    Number.isSafeInteger(value.sequence) && value.sequence >= 0 && validReceiverMetrics(value.metrics);
  if (value.type === 'answer') return typeof value.sdp === 'string' && value.sdp.length < 60000 &&
    (value.codecCapabilities === undefined || validCodecSummary(value.codecCapabilities)) &&
    (value.codecPreferenceApplied === undefined || typeof value.codecPreferenceApplied === 'boolean');
  if (value.type === 'candidate') {
    const c = value.candidate;
    return c && typeof c.candidate === 'string' && c.candidate.length < 4096 &&
      (c.sdpMid === null || typeof c.sdpMid === 'string') &&
      (c.sdpMLineIndex === null || (Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0));
  }
  return false;
}

class DisplayServer extends EventEmitter {
  constructor({ port = 3210, bind = '0.0.0.0', publicDir = path.join(__dirname, 'viewer') } = {}) {
    super();
    this.requestedPort = port;
    this.bind = bind;
    this.token = randomBytes(24).toString('hex');
    this.active = false;
    this.viewer = null;
    this.peerId = null;
    this.allowedHosts = new Set();
    this.files = new Map([
      ['/', ['text/html; charset=utf-8', readFileSync(path.join(publicDir, 'index.html'))]],
      ['/viewer.js', ['text/javascript; charset=utf-8', readFileSync(path.join(publicDir, 'viewer.js'))]],
      ['/style.css', ['text/css; charset=utf-8', readFileSync(path.join(publicDir, 'style.css'))]],
      ['/streaming.js', ['text/javascript; charset=utf-8', readFileSync(path.join(__dirname, 'shared', 'streaming.js'))]],
      ['/diagnostics.js', ['text/javascript; charset=utf-8', readFileSync(path.join(__dirname, 'shared', 'diagnostics.js'))]],
      ['/codecs.js', ['text/javascript; charset=utf-8', readFileSync(path.join(__dirname, 'shared', 'codecs.js'))]]
    ]);
    this.http = http.createServer((req, res) => {
      if (!this.allowedHosts.has(req.headers.host)) { res.writeHead(403).end(); return; }
      const file = this.files.get(req.url);
      if (req.method !== 'GET' || !file) { res.writeHead(404).end(); return; }
      res.writeHead(200, {
        'Content-Type': file[0], 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
      });
      res.end(file[1]);
    });
    this.http.headersTimeout = 10000;
    this.http.requestTimeout = 15000;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
    this.http.on('upgrade', (req, socket, head) => {
      if (req.url !== '/signal' || !this.allowedHosts.has(req.headers.host) ||
          req.headers.origin !== `http://${req.headers.host}` || this.wss.clients.size >= 8) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req));
    });
    this.wss.on('connection', ws => this.accept(ws));
  }

  async listen(addresses = []) {
    await new Promise((resolve, reject) => {
      const fail = error => reject(error);
      this.http.once('error', fail);
      this.http.listen(this.requestedPort, this.bind, () => {
        this.http.off('error', fail);
        resolve();
      });
    });
    this.port = this.http.address().port;
    this.allowedHosts = new Set(['localhost', '127.0.0.1', ...addresses].map(ip => `${ip}:${this.port}`));
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!ws.alive) { ws.terminate(); continue; }
        ws.alive = false;
        ws.ping();
      }
    }, 10000);
    this.heartbeat.unref();
    return this;
  }

  accept(ws) {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    let authenticated = false;
    let count = 0;
    let intervalStart = Date.now();
    const deadline = setTimeout(() => ws.close(4001, 'Pairing timed out'), 5000);
    deadline.unref();
    ws.on('message', (raw, binary) => {
      if (Date.now() - intervalStart > 1000) { count = 0; intervalStart = Date.now(); }
      if (binary || ++count > 100) { ws.close(4002, 'Invalid message'); return; }
      let data;
      try { data = JSON.parse(raw.toString()); } catch { ws.close(4002, 'Invalid message'); return; }
      if (!authenticated) {
        const supplied = Buffer.from(typeof data?.token === 'string' ? data.token : '');
        const expected = Buffer.from(this.token);
        if (data?.type !== 'join' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          ws.close(4003, 'Invalid pairing link'); return;
        }
        if (this.viewer) { ws.close(4009, 'Another device is connected'); return; }
        clearTimeout(deadline);
        authenticated = true;
        this.viewer = ws;
        this.peerId = randomBytes(8).toString('hex');
        ws.peerId = this.peerId;
        ws.send(JSON.stringify({ type: 'welcome', active: this.active }));
        this.emit('viewer', { connected: true, peerId: this.peerId });
        return;
      }
      if (data?.type === 'retry') {
        this.emit('retry', { peerId: ws.peerId });
      } else if (validSignal(data)) {
        if (this.active) this.emit('signal', { peerId: ws.peerId, signal: data });
      } else {
        ws.close(4002, 'Invalid signal');
      }
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      if (this.viewer === ws) {
        this.viewer = null;
        this.peerId = null;
        this.emit('viewer', { connected: false, peerId: ws.peerId });
      }
    });
  }

  send(signal, peerId = this.peerId) {
    if (peerId !== this.peerId || this.viewer?.readyState !== WebSocket.OPEN) return false;
    this.viewer.send(JSON.stringify(signal));
    return true;
  }

  setActive(active) {
    this.active = Boolean(active);
    if (!this.active) this.send({ type: 'stopped' });
  }

  disconnect() {
    const viewer = this.viewer;
    this.viewer = null;
    this.peerId = null;
    viewer?.close(4000, 'Disconnected on PC');
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = this.finishClose();
    return this.closing;
  }

  async finishClose() {
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise(resolve => this.wss.close(resolve));
    this.http.closeAllConnections();
    await new Promise(resolve => this.http.close(resolve));
  }
}

module.exports = { DisplayServer, validSignal };
