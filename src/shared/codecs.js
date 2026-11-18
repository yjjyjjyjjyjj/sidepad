(function (root) {
  function parameters(codec) {
    return Object.fromEntries((codec?.sdpFmtpLine || '').split(';').map(part => part.trim().split('=')).filter(pair => pair.length === 2).map(([key, value]) => [key.toLowerCase(), value.toLowerCase()]));
  }
  function h264Profile(codec) {
    const value = parameters(codec)['profile-level-id'] || '42e01f';
    if (!/^[a-f0-9]{6}$/.test(value)) return 'unknown';
    const idc = parseInt(value.slice(0, 2), 16), flags = parseInt(value.slice(2, 4), 16);
    // RFC 6184 / WebRTC profile patterns, including equivalent profile encodings.
    if ((idc === 0x42 && (flags & 0x4f) === 0x40) || (idc === 0x4d && (flags & 0x8f) === 0x80) || (idc === 0x58 && (flags & 0xcf) === 0xc0)) return 'constrained-baseline';
    if ((idc === 0x42 && (flags & 0x4f) === 0) || (idc === 0x58 && (flags & 0xcf) === 0x80)) return 'baseline';
    if (idc === 0x4d && (flags & 0xaf) === 0) return 'main';
    if (idc === 0x64 && flags === 0) return 'high';
    if (idc === 0x64 && flags === 0x0c) return 'constrained-high';
    return 'unknown';
  }
  function codecRank(codec, preference) {
    const mime = codec.mimeType.toLowerCase();
    if (preference === 'compatibility') return mime === 'video/h264' ? 0 : 50;
    if (mime === 'video/h264') {
      const ranks = { high: 0, 'constrained-high': 0, main: 1, baseline: 2, 'constrained-baseline': 25, unknown: 30 };
      return ranks[h264Profile(codec)] + (parameters(codec)['packetization-mode'] === '1' ? 0 : 10);
    }
    // NVIDIA's Windows MFT rejects Constrained Baseline. HEVC is preferred over
    // that software-only path when both endpoints genuinely advertise HEVC.
    if (mime === 'video/h265') return 4;
    if (['video/rtx', 'video/red', 'video/ulpfec', 'video/flexfec-03'].includes(mime)) return 100;
    return 50;
  }
  function preferredCodecs(codecs, preference = 'hardware') {
    return [...codecs].sort((a, b) => codecRank(a, preference) - codecRank(b, preference));
  }
  function applyCodecPreferences(transceiver, codecs, preference = 'hardware') {
    if (!transceiver?.setCodecPreferences || !codecs?.length) return false;
    try { transceiver.setCodecPreferences(preferredCodecs(codecs, preference)); return true; }
    catch { return false; }
  }
  function summarizeCodecs(codecs = []) {
    return codecs.filter(codec => /^video\/(H264|H265|VP8|VP9|AV1)$/i.test(codec.mimeType)).slice(0, 32).map(codec => ({
      mimeType: codec.mimeType, sdpFmtpLine: (codec.sdpFmtpLine || '').slice(0, 256)
    }));
  }
  function validCodecSummary(value) {
    return Array.isArray(value) && value.length <= 32 && value.every(codec => codec && typeof codec === 'object' &&
      Object.keys(codec).length === 2 && /^video\/(H264|H265|VP8|VP9|AV1)$/i.test(codec.mimeType) &&
      typeof codec.sdpFmtpLine === 'string' && codec.sdpFmtpLine.length <= 256);
  }
  function summarizeVideoSdp(sdp) {
    const codecs = new Map();
    let video = false;
    for (const line of String(sdp || '').split(/\r?\n/)) {
      if (line.startsWith('m=')) video = line.startsWith('m=video ');
      if (!video) continue;
      const rtp = line.match(/^a=rtpmap:(\d+) (H264|H265|VP8|VP9|AV1)\/90000$/i);
      if (rtp && codecs.size < 32) codecs.set(rtp[1], { mimeType: `video/${rtp[2]}`, sdpFmtpLine: '' });
      const fmtp = line.match(/^a=fmtp:(\d+) (.+)$/);
      if (fmtp && codecs.has(fmtp[1])) codecs.get(fmtp[1]).sdpFmtpLine = fmtp[2].slice(0, 256);
    }
    return [...codecs.values()];
  }
  function encoderStatus(sender) {
    if (!sender?.encoder) return 'unknown';
    if (/NVIDIA/i.test(sender.encoder) && sender.powerEfficient !== false) return 'nvidia';
    if (/OpenH264|libvpx|libaom/i.test(sender.encoder)) return 'software';
    return sender.powerEfficient === true ? 'efficient' : 'unknown';
  }
  const api = { parameters, h264Profile, preferredCodecs, applyCodecPreferences, summarizeCodecs, validCodecSummary, summarizeVideoSdp, encoderStatus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SidepadCodecs = Object.freeze(api);
})(globalThis);
