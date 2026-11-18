const { setTimeout: delay } = require('node:timers/promises');
const assert = require('node:assert/strict');
const { BrowserWindow, screen } = require('electron');
const path = require('node:path');

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function summarize(samples) {
  const fields = { sender: ['encodeMs', 'sendQueueMs', 'encodedFps', 'bitrateMbps', 'rttMs'], receiver: ['bufferMs', 'decodeMs', 'receiveProcessMs', 'minimumBufferMs', 'decodedFps'], resources: ['cpuPercent'] };
  return Object.fromEntries(Object.entries(fields).map(([group, keys]) => [group,
    Object.fromEntries(keys.map(key => [key, median(samples.map(sample => sample[group]?.[key]))]))
  ]));
}
async function run(options) {
  let pattern;
  try {
    if (process.argv.includes('--pattern')) {
      const display = screen.getAllDisplays().find(item => String(item.id) === options.chosen.id);
      assert.ok(display && !options.chosen.primary, 'The animated benchmark requires a secondary display');
      pattern = new BrowserWindow({ ...display.bounds, frame: false, show: false, focusable: false, skipTaskbar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      await pattern.loadFile(path.join(__dirname, 'benchmark-pattern.html'));
      pattern.setAlwaysOnTop(true);
      pattern.showInactive();
    }
    return await compare(options, Boolean(pattern));
  } finally { pattern?.destroy(); }
}
async function compare({ win, viewer, until, expectedWidth, expectedHeight }, animatedPattern) {
  const modes = [];
  const originalAdaptive = await win.webContents.executeJavaScript("document.getElementById('adaptive-bitrate').checked");
  for (const lowLatency of [true, false]) {
    await win.webContents.executeJavaScript('stop()', true);
    await until(viewer, "document.getElementById('screen').srcObject === null");
    await win.webContents.executeJavaScript(`{
      const toggle = document.getElementById('low-latency');
      toggle.checked = ${lowLatency}; toggle.dispatchEvent(new Event('change'));
      document.getElementById('quality').value = 'balanced';
      document.getElementById('fps').value = '60';
      document.getElementById('adaptive-bitrate').checked = false;
      document.getElementById('start').click();
    }`, true);
    await until(viewer, "document.getElementById('screen').videoWidth > 0 && document.getElementById('screen').currentTime > 0.25");
    await delay(8000);
    const samples = [];
    for (let i = 0; i < 8; i++) {
      await delay(2100);
      const sample = await win.webContents.executeJavaScript('diagnosticReport()');
      assert.equal(sample.settings.lowLatency, lowLatency);
      assert.equal(sample.settings.fps, 60);
      assert.equal(sample.settings.bitrate, 12000000);
      assert.equal(sample.latencyControl.enabled, false);
      assert.equal(sample.sender?.width, expectedWidth);
      assert.equal(sample.receiver?.width, expectedWidth);
      assert.equal(sample.receiver?.height, expectedHeight);
      samples.push(sample);
    }
    modes.push({ lowLatency, medianOfIntervals: summarize(samples), samples });
    console.log(JSON.stringify({ benchmarkMode: lowLatency ? 'minimum-buffer' : 'automatic-buffer', medianOfIntervals: modes.at(-1).medianOfIntervals }));
  }
  // Leave the caller in its original low-latency mode for lifecycle smoke checks.
  await win.webContents.executeJavaScript('stop()', true);
  await until(viewer, "document.getElementById('screen').srcObject === null");
  await win.webContents.executeJavaScript(`{
    const toggle = document.getElementById('low-latency');
    toggle.checked = true; toggle.dispatchEvent(new Event('change'));
    document.getElementById('adaptive-bitrate').checked = ${originalAdaptive};
    document.getElementById('start').click();
  }`, true);
  await until(viewer, "document.getElementById('screen').videoWidth > 0 && document.getElementById('screen').currentTime > 0.25");
  return {
    recordedAt: new Date().toISOString(), transport: 'loopback', animatedPattern, adaptiveBitrate: false, warmupSeconds: 8, samplesPerMode: 8,
    caveat: 'Sequential measurements on the same PC, including sender, receiver and optional pattern renderer CPU. Background load may vary. Does not measure real Wi-Fi or capture-to-display latency.',
    modes
  };
}
module.exports = { run };
