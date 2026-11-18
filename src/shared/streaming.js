(function (root) {
  const profiles = Object.freeze({
    balanced: { width: 1920, height: 1200, bitrate: 8000000 },
    sharp: { width: 2560, height: 1600, bitrate: 16000000 },
    light: { width: 1280, height: 800, bitrate: 3000000 }
  });

  function createStreamSettings({ lowLatency = false, quality = 'balanced', fps = 30, encoderPreference = 'hardware', adaptiveBitrate = true } = {}) {
    const low = lowLatency === true;
    const profile = profiles[quality] || profiles.balanced;
    const frameRate = Number(fps) === 60 ? 60 : 30;
    return Object.freeze({
      ...profile, lowLatency: low, fps: frameRate,
      adaptiveBitrate: low && adaptiveBitrate === true,
      encoderPreference: encoderPreference === 'compatibility' ? 'compatibility' : 'hardware',
      bitrate: profile.bitrate * (frameRate === 60 ? 1.5 : 1),
      // Buffer tuning must not silently trade away the user's selected resolution.
      contentHint: 'detail',
      degradationPreference: 'maintain-resolution'
    });
  }

  async function applySenderSettings(sender, settings) {
    // Always start from the current browser parameters, retaining its transaction ID.
    const update = includePreference => {
      const params = sender.getParameters();
      if (!params.encodings?.length) throw new Error('Video encoding parameters are not ready.');
      for (const encoding of params.encodings) {
        encoding.maxBitrate = settings.bitrate;
        encoding.maxFramerate = settings.fps;
      }
      if (includePreference) params.degradationPreference = settings.degradationPreference;
      return sender.setParameters(params);
    };
    try {
      await update(true);
      return { applied: true, preference: true };
    } catch {
      try {
        await update(false);
        return { applied: true, preference: false };
      } catch {
        // Capture constraints and contentHint still apply on older implementations.
        return { applied: false, preference: false };
      }
    }
  }

  function applyReceiverLatency(receiver, lowLatency) {
    // Do not create an inert expando property on browsers without this API.
    if (!receiver) return { supported: false, applied: false, api: null };
    const target = lowLatency === true ? 0 : null;
    let supported = false;
    // Older Chromium exposes the same request in seconds. Zero/null have the
    // same meaning in both APIs. Neither API imposes a hard buffer limit.
    for (const key of ['jitterBufferTarget', 'playoutDelayHint']) {
      if (!(key in receiver)) continue;
      supported = true;
      try {
        receiver[key] = target;
        if (receiver[key] === target) return { supported: true, applied: true, api: key };
      } catch { /* Try the legacy API if present. */ }
    }
    return { supported, applied: false, api: null };
  }

  async function applyBitrateLimit(sender, bitrate) {
    if (!Number.isSafeInteger(bitrate) || bitrate <= 0) return false;
    try {
      const params = sender.getParameters();
      if (params.encodings?.length !== 1) return false;
      params.encodings[0].maxBitrate = bitrate;
      // Keep codec, frame rate, resolution and degradation preference intact.
      await sender.setParameters(params);
      return sender.getParameters().encodings?.[0]?.maxBitrate === bitrate;
    } catch { return false; }
  }

  function intervalAverageMs(total, count, previousTotal, previousCount) {
    if (![total, count, previousTotal, previousCount].every(Number.isFinite)) return null;
    const elapsed = total - previousTotal;
    const emitted = count - previousCount;
    if (elapsed < 0 || emitted <= 0) return null;
    return elapsed / emitted * 1000;
  }

  function receiverMetrics(current, previous) {
    if (!previous || current.id !== previous.id) return { bufferMs: null, decodeMs: null };
    return {
      bufferMs: intervalAverageMs(current.jitterBufferDelay, current.jitterBufferEmittedCount, previous.jitterBufferDelay, previous.jitterBufferEmittedCount),
      decodeMs: intervalAverageMs(current.totalDecodeTime, current.framesDecoded, previous.totalDecodeTime, previous.framesDecoded)
    };
  }

  const api = { createStreamSettings, applySenderSettings, applyReceiverLatency, applyBitrateLimit, intervalAverageMs, receiverMetrics };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SidepadStreaming = Object.freeze(api);
})(globalThis);
