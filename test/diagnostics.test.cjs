const test = require('node:test');
const assert = require('node:assert/strict');
const { senderMetrics, receiverMetrics, validReceiverMetrics, acceptReceiver, freshReceiver, efficiencyLabel } = require('../src/shared/diagnostics.js');

test('sender measures recent encode time per frame and queue time per packet separately', () => {
  const previous = { id: 'out', ssrc: 1, codecId: 'codec', timestamp: 1000, framesEncoded: 10, packetsSent: 100, totalEncodeTime: 0.1, totalPacketSendDelay: 1, bytesSent: 1000 };
  const current = { ...previous, timestamp: 3000, framesEncoded: 130, packetsSent: 1100, totalEncodeTime: 0.34, totalPacketSendDelay: 4, bytesSent: 1001000, encoderImplementation: 'test encoder', qualityLimitationReason: 'none' };
  const report = new Map([['codec', { mimeType: 'video/H264' }], ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }], ['pair', { currentRoundTripTime: 0.005 }]]);
  const metrics = senderMetrics(current, previous, report);
  assert.ok(Math.abs(metrics.encodeMs - 2) < 0.0001);
  assert.equal(metrics.sendQueueMs, 3);
  assert.equal(metrics.encodedFps, 60);
  assert.equal(metrics.bitrateMbps, 4);
  assert.equal(metrics.rttMs, 5);
  assert.equal(metrics.codec, 'video/H264');
  assert.equal(metrics.powerEfficient, null);
  assert.equal(efficiencyLabel(null), '확인 불가');
  assert.equal(senderMetrics(current, null, report).encodeMs, null);
  assert.equal(senderMetrics({ ...current, ssrc: 2 }, previous, report).encodeMs, null);
  assert.equal(senderMetrics({ ...current, codecId: 'new' }, previous, report).encodeMs, null);
  assert.equal(senderMetrics({ ...current, totalEncodeTime: 0 }, previous, report).encodeMs, null);
});

test('receiver diagnostics preserve overlap, absent stats and idle intervals', () => {
  const previous = { id: 'in', timestamp: 1000, framesDecoded: 10, jitterBufferEmittedCount: 10, jitterBufferDelay: 1, totalDecodeTime: 0.1, totalProcessingDelay: 2, framesDropped: 0 };
  const current = { ...previous, timestamp: 3000, framesDecoded: 110, jitterBufferEmittedCount: 110, jitterBufferDelay: 3, totalDecodeTime: 0.3, totalProcessingDelay: 5, framesDropped: 4 };
  const metrics = receiverMetrics(current, previous, { supported: true, applied: true }, true);
  assert.equal(metrics.bufferMs, 20);
  assert.ok(Math.abs(metrics.decodeMs - 2) < 0.0001);
  assert.equal(metrics.receiveProcessMs, 30);
  assert.equal(metrics.droppedFrames, 4);
  assert.equal(metrics.minimumBufferMs, null);
  assert.equal(metrics.bufferControl, 'minimum');
  assert.equal(validReceiverMetrics(metrics), true);
  const idle = receiverMetrics({ ...current, timestamp: 5000 }, current, { supported: false, applied: false }, true);
  assert.equal(idle.bufferMs, null);
  assert.equal(idle.decodeMs, null);
  assert.equal(idle.decodedFps, 0);
  assert.equal(idle.bufferControl, 'unsupported');
});

test('receiver telemetry validates fields and ignores old sessions, old sequences and expired samples', () => {
  const metrics = receiverMetrics({ id: 'video', timestamp: 1000 }, null, null, false);
  assert.equal(validReceiverMetrics({ ...metrics, bufferMs: -1 }), false);
  assert.equal(validReceiverMetrics({ ...metrics, decodeMs: Infinity }), false);
  assert.equal(validReceiverMetrics({ ...metrics, width: '1920' }), false);
  assert.equal(validReceiverMetrics({ ...metrics, token: 'private' }), false);
  assert.equal(validReceiverMetrics({ ...metrics, decoder: 'x'.repeat(161) }), false);
  const signal = { sessionId: 'current', sequence: 1, metrics };
  const sample = acceptReceiver(null, signal, 'current', 100);
  assert.equal(freshReceiver(sample, 6000), metrics);
  assert.equal(freshReceiver(sample, 6700), null);
  assert.equal(acceptReceiver(sample, signal, 'current', 200), sample);
  assert.equal(acceptReceiver(sample, { ...signal, sequence: 2, sessionId: 'old' }, 'current', 200), sample);
  assert.equal(acceptReceiver(sample, { ...signal, sequence: 2 }, 'current', 200).receivedAt, 200);
});
