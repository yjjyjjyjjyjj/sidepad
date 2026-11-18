const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamSettings, applySenderSettings, applyReceiverLatency, intervalAverageMs, receiverMetrics } = require('../src/shared/streaming.js');

test('low latency preserves every selected resolution and frame rate', () => {
  for (const quality of ['light', 'balanced', 'sharp']) {
    for (const fps of [30, 60]) {
      const standard = createStreamSettings({ quality, fps });
      const low = createStreamSettings({ lowLatency: true, quality, fps });
      assert.deepEqual(low, { ...standard, lowLatency: true });
      assert.equal(low.fps, fps);
      assert.equal(low.contentHint, 'detail');
      assert.equal(low.degradationPreference, 'maintain-resolution');
    }
  }
  const fullHd = createStreamSettings({ lowLatency: true, fps: 60 });
  assert.equal(fullHd.width, 1920);
  assert.equal(fullHd.height, 1200);
  assert.equal(fullHd.bitrate, 12000000);
  assert.equal(createStreamSettings({ lowLatency: true, quality: 'sharp' }).width, 2560);
});

test('sender retries unsupported degradation preference with fresh parameters', async () => {
  const attempts = [];
  let transaction = 0;
  const sender = {
    getParameters() { return { transactionId: String(++transaction), encodings: [{}] }; },
    async setParameters(params) {
      attempts.push(params);
      if ('degradationPreference' in params) throw new Error('Unsupported preference');
    }
  };
  assert.deepEqual(await applySenderSettings(sender, createStreamSettings({ lowLatency: true, fps: 60 })), { applied: true, preference: false });
  assert.notEqual(attempts[0].transactionId, attempts[1].transactionId);
  assert.equal(attempts[1].encodings[0].maxFramerate, 60);
  assert.equal(attempts[1].encodings[0].maxBitrate, 12000000);
});

test('unsupported receiver tuning does not create a fake successful property', () => {
  const receiver = {};
  assert.deepEqual(applyReceiverLatency(receiver, true), { supported: false, applied: false });
  assert.equal('jitterBufferTarget' in receiver, false);
  const throwing = { get jitterBufferTarget() { return null; }, set jitterBufferTarget(value) { throw new Error('Unavailable'); } };
  assert.deepEqual(applyReceiverLatency(throwing, true), { supported: true, applied: false });
});

test('returning to standard mode restores automatic receiver buffering', () => {
  const receiver = { jitterBufferTarget: null };
  assert.equal(applyReceiverLatency(receiver, true).applied, true);
  assert.equal(receiver.jitterBufferTarget, 0);
  assert.equal(applyReceiverLatency(receiver, false).applied, true);
  assert.equal(receiver.jitterBufferTarget, null);
});

test('buffer metric measures the recent interval, not the connection lifetime', () => {
  // Lifetime mean is 110 ms, but the ten most recent frames waited 20 ms each.
  const previous = { id: 'video', jitterBufferDelay: 2, jitterBufferEmittedCount: 10, totalDecodeTime: 0.1, framesDecoded: 10 };
  const current = { id: 'video', jitterBufferDelay: 2.2, jitterBufferEmittedCount: 20, totalDecodeTime: 0.12, framesDecoded: 20 };
  const result = receiverMetrics(current, previous);
  assert.ok(Math.abs(result.bufferMs - 20) < 0.0001);
  assert.ok(Math.abs(result.decodeMs - 2) < 0.0001);
  assert.equal(receiverMetrics({ ...current, id: 'new-stream' }, previous).bufferMs, null);
  assert.equal(intervalAverageMs(1, 5, 2, 10), null);
  assert.equal(intervalAverageMs(2, 10, 2, 10), null);
  assert.equal(intervalAverageMs(undefined, 20, 2, 10), null);
});
