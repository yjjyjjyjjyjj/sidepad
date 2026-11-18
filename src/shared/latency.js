(function (root) {
  // A slow outer loop around WebRTC's congestion controller. Buffer delay alone
  // is NOT evidence of congestion, and maxBitrate is a ceiling, not a target.
  function createLatencyController(settings, now = 0) {
    const maximum = settings.bitrate;
    const frameMs = 1000 / settings.fps;
    const minimum = Math.min(maximum, Math.ceil(Math.max(maximum * 0.35,
      settings.width * settings.height * settings.fps * 0.055) / 100000) * 100000);
    const enabled = settings.lowLatency && settings.adaptiveBitrate;
    let current = maximum, started = now, lastChange = now, lastSample = null;
    let sequence = -1, recentPressure = [], healthy = 0, baselineRtt = null, pending = null;
    let reason = enabled ? 'warming-up' : 'disabled', changes = 0, failed = false;
    function observe(sender, sample, time) {
      if (!enabled || failed || pending || !sample || !sender || time < started) return null;
      if (time < sample.receivedAt || time - sample.receivedAt > 6500) {
        recentPressure = []; healthy = 0; reason = 'waiting'; return null;
      }
      if (sample.sequence <= sequence) return null;
      if (lastSample !== null && time - lastSample > 6500) { recentPressure = []; healthy = 0; }
      sequence = sample.sequence; lastSample = time;
      const r = sample.metrics;
      if (!Number.isFinite(r.bufferMs) || !(r.decodedFps > 0) || !(sender.encodedFps > 0)) {
        recentPressure = []; healthy = 0; reason = 'waiting'; return null;
      }
      if (Number.isFinite(sender.rttMs)) baselineRtt = Math.min(baselineRtt ?? sender.rttMs, sender.rttMs);
      if (time - started < 8000) { reason = 'warming-up'; return null; }
      if (sender.encodeMs > frameMs || r.decodeMs > frameMs || sender.limitation === 'cpu') {
        recentPressure = []; healthy = 0; reason = 'processing-limited'; return null;
      }
      const loss = Number.isFinite(r.receivedPackets) && r.receivedPackets >= 100 &&
        r.lostPackets > 0 && r.lostPackets / (r.receivedPackets + r.lostPackets) >= 0.01;
      const queue = sender.sendQueueMs >= Math.max(10, frameMs * 0.75);
      const rtt = Number.isFinite(sender.rttMs) && sender.rttMs > baselineRtt + 20;
      const congested = queue || loss || rtt || sender.limitation === 'bandwidth';
      const highBuffer = r.bufferMs >= Math.max(45, frameMs * 2.5);
      const calm = r.bufferMs < Math.max(30, frameMs * 1.5) && !congested &&
        r.freezes === 0 && r.lostPackets === 0;
      recentPressure.push(highBuffer && congested);
      if (recentPressure.length > 4) recentPressure.shift();
      healthy = calm ? healthy + 1 : 0;
      reason = highBuffer ? (congested ? 'observing-congestion' : 'receiver-buffer') : 'stable';
      if (highBuffer && congested && recentPressure.filter(Boolean).length >= 3 && time - lastChange >= 6000) {
        const next = Math.max(minimum, Math.floor(current * 0.8 / 100000) * 100000);
        if (next < current) pending = { bitrate: next, reason: 'congestion' };
        else reason = 'quality-floor';
      } else if (healthy >= 8 && time - lastChange >= 16000 && current < maximum) {
        pending = { bitrate: Math.min(maximum, Math.ceil(current * 1.1 / 100000) * 100000), reason: 'recovering' };
      }
      return pending;
    }
    function commit(action, applied, time) {
      if (!pending || action !== pending) return;
      if (applied) { current = action.bitrate; reason = action.reason; changes++; }
      else { failed = true; reason = 'failed'; }
      pending = null; recentPressure = []; healthy = 0; lastChange = time;
    }
    function snapshot() {
      return { enabled: Boolean(enabled), maximumBitrate: maximum, minimumBitrate: minimum,
        currentBitrate: current, reason, changes };
    }
    return { observe, commit, snapshot };
  }
  const api = { createLatencyController };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SidepadLatency = Object.freeze(api);
})(globalThis);
