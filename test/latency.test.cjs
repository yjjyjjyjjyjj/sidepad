const test = require('node:test');
const assert = require('node:assert/strict');
const { createLatencyController } = require('../src/shared/latency.js');
const settings = { lowLatency: true, adaptiveBitrate: true, fps: 60, width: 1920, height: 1080, bitrate: 24000000 };
const sender = { encodedFps: 60, encodeMs: 5, sendQueueMs: 20, rttMs: 5, limitation: 'none' };
const metrics = { bufferMs: 65, decodedFps: 60, decodeMs: 6, receivedPackets: 1000, lostPackets: 0, freezes: 0 };
function feed(controller, time, s = sender, r = metrics, sequence = time) {
  return controller.observe(s, { metrics: r, receivedAt: time, sequence }, time);
}

test('requires warmup and three distinct sustained congested intervals, then reads application result', () => {
  const c = createLatencyController(settings);
  for (const time of [2000, 4000, 6000, 8000, 10000]) assert.equal(feed(c, time), null);
  assert.equal(feed(c, 10000), null, 'duplicate diagnostics cannot advance the streak');
  const action = feed(c, 12000);
  assert.equal(action.bitrate, 19200000);
  assert.equal(c.snapshot().currentBitrate, 24000000, 'do not report a setting before it is applied');
  assert.equal(feed(c, 14000), null, 'serialize changes');
  c.commit(action, true, 14000);
  assert.equal(c.snapshot().currentBitrate, 19200000);
});

test('high receiver buffer alone, processing overload and idle samples do not reduce quality', () => {
  for (const [s, r] of [
    [{ ...sender, sendQueueMs: 2 }, metrics],
    [{ ...sender, encodeMs: 30 }, metrics],
    [sender, { ...metrics, decodeMs: 30 }],
    [sender, { ...metrics, decodedFps: 0 }],
    [sender, { ...metrics, bufferMs: null }]
  ]) {
    const c = createLatencyController(settings);
    for (let time = 8000; time < 30000; time += 2000) assert.equal(feed(c, time, s, r), null);
    assert.equal(c.snapshot().currentBitrate, settings.bitrate);
  }
});

test('one brief spike is ignored, but repeated bursts in three of four intervals are handled', () => {
  const c = createLatencyController(settings);
  assert.equal(feed(c, 8000), null);
  assert.equal(feed(c, 10000, { ...sender, sendQueueMs: 2 }), null);
  assert.equal(feed(c, 12000), null);
  assert.equal(feed(c, 14000).bitrate, 19200000);
});

test('old diagnostics, gaps, failure and disabled control cannot drive further adjustments', () => {
  const c = createLatencyController(settings);
  feed(c, 8000); feed(c, 10000);
  assert.equal(c.observe(sender, { metrics, receivedAt: 10000, sequence: 11000 }, 20000), null);
  assert.equal(feed(c, 22000), null);
  assert.equal(feed(c, 24000), null);
  const action = feed(c, 26000);
  c.commit(action, false, 26000);
  assert.equal(c.snapshot().reason, 'failed');
  assert.equal(c.snapshot().currentBitrate, settings.bitrate);
  for (let time = 28000; time < 40000; time += 2000) assert.equal(feed(c, time), null);
  for (const disabled of [{ lowLatency: false }, { adaptiveBitrate: false }]) {
    const off = createLatencyController({ ...settings, ...disabled });
    for (let time = 8000; time < 30000; time += 2000) assert.equal(feed(off, time), null);
  }
});

test('persistent pressure stops at a quality floor; recovery is slower and bounded', () => {
  const c = createLatencyController(settings);
  let time;
  for (time = 8000; time <= 90000; time += 2000) {
    const action = feed(c, time);
    if (action) c.commit(action, true, time);
    assert.ok(c.snapshot().currentBitrate >= c.snapshot().minimumBitrate);
  }
  assert.equal(c.snapshot().currentBitrate, c.snapshot().minimumBitrate);
  const floor = c.snapshot().currentBitrate;
  const calm = { ...metrics, bufferMs: 15 };
  for (let i = 0; i < 7; i++, time += 2000) assert.equal(feed(c, time, { ...sender, sendQueueMs: 2 }, calm), null);
  assert.equal(c.snapshot().currentBitrate, floor);
  for (; time < 500000; time += 2000) {
    const action = feed(c, time, { ...sender, sendQueueMs: 2 }, calm);
    if (action) c.commit(action, true, time);
    assert.ok(c.snapshot().currentBitrate <= settings.bitrate);
  }
  assert.equal(c.snapshot().currentBitrate, settings.bitrate);
});
