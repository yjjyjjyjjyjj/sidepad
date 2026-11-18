const test = require('node:test');
const assert = require('node:assert/strict');
const { h264Profile, preferredCodecs, applyCodecPreferences, summarizeCodecs, validCodecSummary, summarizeVideoSdp, encoderStatus } = require('../src/shared/codecs.js');
const { validSignal } = require('../src/server.cjs');
const h264 = profile => ({ mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}` });

test('H264 distinguishes NVIDIA-compatible and constrained baseline profiles', () => {
  for (const profile of ['42e01f', '42c01f', '4d801f', '58c01f']) assert.equal(h264Profile(h264(profile)), 'constrained-baseline');
  assert.equal(h264Profile(h264('42001f')), 'baseline');
  assert.equal(h264Profile(h264('4d001f')), 'main');
  assert.equal(h264Profile(h264('640032')), 'high');
  assert.equal(h264Profile(h264('640c1f')), 'constrained-high');
  assert.equal(h264Profile(h264('invalid')), 'unknown');
});

test('hardware preference uses HEVC before constrained baseline without inventing codecs', () => {
  const baseline = h264('42e01f'), hevc = { mimeType: 'video/H265', clockRate: 90000, sdpFmtpLine: 'profile-id=1' }, high = h264('640032');
  const codecs = [baseline, hevc, high, { mimeType: 'video/rtx', clockRate: 90000 }];
  const ordered = preferredCodecs(codecs);
  assert.deepEqual(ordered, [high, hevc, baseline, codecs[3]]);
  assert.equal(codecs[0], baseline);
  assert.equal(preferredCodecs([baseline, hevc])[0], hevc);
  assert.equal(preferredCodecs([baseline, hevc], 'compatibility')[0], baseline);
  assert.deepEqual(preferredCodecs([baseline]), [baseline]);
  assert.ok(ordered.every(codec => codecs.includes(codec)));
  assert.equal(applyCodecPreferences({}, codecs), false);
  assert.equal(applyCodecPreferences({ setCodecPreferences() { throw new Error('unsupported'); } }, codecs), false);
});

test('codec diagnostics contain bounded codec fields only, not connection secrets', () => {
  const summary = summarizeCodecs([h264('42e01f'), { mimeType: 'video/rtx' }]);
  assert.equal(validCodecSummary(summary), true);
  assert.equal(validCodecSummary([{ ...summary[0], token: 'private' }]), false);
  assert.equal(validCodecSummary([{ ...summary[0], sdpFmtpLine: 'x'.repeat(257) }]), false);
  assert.equal(validSignal({ type: 'answer', sdp: 'answer', codecCapabilities: summary, codecPreferenceApplied: true }), true);
  assert.equal(validSignal({ type: 'answer', sdp: 'answer', codecCapabilities: [{ mimeType: 'evil', sdpFmtpLine: '' }] }), false);
  const sdp = 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=ice-pwd:secret\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 profile-level-id=42e01f\r\na=candidate:private-ip\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';
  assert.deepEqual(summarizeVideoSdp(sdp), [{ mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' }]);
  assert.equal(encoderStatus({ encoder: 'OpenH264', powerEfficient: false }), 'software');
  assert.equal(encoderStatus({ encoder: 'MediaFoundationVideoEncodeAccelerator (NVIDIA HEVC Encoder MFT)', powerEfficient: true }), 'nvidia');
  assert.equal(encoderStatus({ encoder: null, powerEfficient: true }), 'unknown');
});
