const { BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const assert = require('node:assert/strict');

async function verifyMode(win, viewer, lowLatency) {
  const sender = await win.webContents.executeJavaScript(`({
    contentHint: stream.getVideoTracks()[0].contentHint,
    settings: activeSettings,
    parameters: peer.getSenders().find(s => s.track?.kind === 'video').getParameters(),
    previewPlaying: Boolean(document.getElementById('preview').srcObject),
    tuning: senderTuning
  })`);
  assert.equal(sender.contentHint, 'detail');
  assert.equal(sender.settings.lowLatency, lowLatency);
  assert.equal(sender.parameters.encodings[0].maxFramerate, lowLatency ? 60 : 30);
  assert.equal(sender.parameters.encodings[0].maxBitrate, lowLatency ? 12000000 : 3000000);
  assert.equal(sender.parameters.degradationPreference, 'maintain-resolution');
  assert.equal(sender.previewPlaying, !lowLatency);
  assert.equal(sender.tuning.applied, true);
  const receiver = await viewer.webContents.executeJavaScript(`({
    tuning: receiverTuning,
    target: peer.getReceivers().find(r => r.track.kind === 'video').jitterBufferTarget,
    mode: document.getElementById('mode-status').textContent
  })`);
  assert.equal(receiver.tuning.applied, true);
  assert.equal(receiver.target, lowLatency ? 0 : null);
  assert.equal(receiver.mode, lowLatency ? '저지연' : '표준');
  return { contentHint: sender.contentHint, fpsLimit: sender.parameters.encodings[0].maxFramerate, bufferTarget: receiver.target };
}

async function until(window, expression, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await window.webContents.executeJavaScript(expression);
    if (result) return result;
    await delay(200);
  }
  throw new Error(`Timed out: ${expression}`);
}

async function run({ app, win, server, displays }) {
  let viewer;
  const issues = [];
  win.webContents.on('console-message', event => { if (['warning', 'error'].includes(event.level)) issues.push(event.message); });
  try {
    await until(win, "document.getElementById('status').textContent === '준비됨'");
    const controls = await win.webContents.executeJavaScript(`(() => {
      const quality = document.getElementById('quality');
      const fps = document.getElementById('fps');
      const toggle = document.getElementById('low-latency');
      const defaults = { quality: quality.value, fps: fps.value, low: toggle.checked };
      quality.value = 'sharp'; fps.value = '30';
      const selections = [];
      for (const low of [false, true]) {
        toggle.checked = low; toggle.dispatchEvent(new Event('change'));
        selections.push({ quality: quality.value, fps: fps.value, enabled: !quality.disabled && !fps.disabled });
      }
      quality.value = defaults.quality; fps.value = defaults.fps;
      return { defaults, selections };
    })()`);
    assert.deepEqual(controls.defaults, { quality: 'balanced', fps: '60', low: true });
    assert.deepEqual(controls.selections, Array(2).fill({ quality: 'sharp', fps: '30', enabled: true }));
    const artifacts = path.join(__dirname, '..', 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, 'windows-app.png'), (await win.webContents.capturePage()).toPNG());
    const available = (await displays()).filter(item => item.available);
    if (!available.length) throw new Error('No accessible desktop source. Run smoke test in an interactive Windows session.');
    const requestedX = process.env.SIDEPAD_SMOKE_DISPLAY_X;
    const matches = requestedX === undefined ? [] : available.filter(item => item.x === Number(requestedX));
    if (requestedX !== undefined && matches.length !== 1) throw new Error('The requested display position does not identify one capture source.');
    const chosen = matches[0] || available.find(item => !item.primary) || available[0];
    viewer = new BrowserWindow({ show: false, width: 1194, height: 834, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'smoke-viewer' } });
    viewer.webContents.on('console-message', event => { if (['warning', 'error'].includes(event.level)) issues.push(event.message); });
    await viewer.loadURL(`http://127.0.0.1:${server.port}/#${server.token}`);
    writeFileSync(path.join(artifacts, 'device-viewer.png'), (await viewer.webContents.capturePage()).toPNG());
    await viewer.webContents.executeJavaScript("document.getElementById('join').click()", true);
    await until(viewer, "document.getElementById('status').textContent === 'PC 연결됨'");
    await win.webContents.executeJavaScript(`{
      const select = document.getElementById('display');
      select.add(new Option('Smoke test source', ${JSON.stringify(chosen.id)}));
      select.value = ${JSON.stringify(chosen.id)};
      document.getElementById('quality').value = 'balanced';
      document.getElementById('start').disabled = false;
      document.getElementById('start').click();
    }`, true);
    const video = await until(viewer, `(() => {
      const video = document.getElementById('screen');
      return video.videoWidth > 0 && video.currentTime > 0.25 && { width: video.videoWidth, height: video.videoHeight, time: video.currentTime };
    })()`);
    const lowMode = await verifyMode(win, viewer, true);
    if (chosen.width === 1920 && chosen.height === 1080) {
      assert.equal(video.width, 1920, 'Low latency must deliver the full HD source without downscaling');
      assert.equal(video.height, 1080);
    }
    const measurement = await until(win, `(() => {
      const report = diagnosticReport();
      return report.sender?.encodeMs !== null && report.sender?.encodeMs !== undefined &&
        report.receiver?.decodeMs !== null && report.receiver?.decodeMs !== undefined && report;
    })()`);
    assert.equal(measurement.sender.width, video.width);
    assert.equal(measurement.receiver.width, video.width);
    assert.ok(measurement.sender.sendQueueMs === null || measurement.sender.sendQueueMs >= 0);
    assert.ok(measurement.receiver.bufferMs >= 0);
    assert.ok(!JSON.stringify(measurement).includes(server.token));
    writeFileSync(path.join(artifacts, 'diagnostics.json'), JSON.stringify(measurement, null, 2));
    await win.webContents.executeJavaScript("document.getElementById('diagnostics').open = true");
    win.setContentSize(1150, 1500);
    writeFileSync(path.join(artifacts, 'diagnostics-ui.png'), (await win.webContents.capturePage()).toPNG());
    if (process.argv.includes('--benchmark')) {
      const comparison = await require('./benchmark.cjs').run({ win, viewer, until, chosen, expectedWidth: video.width, expectedHeight: video.height });
      writeFileSync(path.join(artifacts, comparison.animatedPattern ? 'benchmark-pattern.json' : 'benchmark.json'), JSON.stringify(comparison, null, 2));
    }
    const before = await viewer.webContents.executeJavaScript("document.getElementById('screen').currentTime");
    await delay(1000);
    const after = await viewer.webContents.executeJavaScript("document.getElementById('screen').currentTime");
    if (after <= before) throw new Error('Video frame playback did not advance');
    await viewer.webContents.executeJavaScript("for (let i = 0; i < 3; i++) document.getElementById('retry').click()", true);
    await until(viewer, "document.getElementById('screen').videoWidth > 0 && document.getElementById('screen').currentTime > 0.25");
    await win.webContents.executeJavaScript("document.getElementById('stop').click()", true);
    await until(viewer, "document.getElementById('screen').srcObject === null && document.getElementById('status').textContent === '전송 대기'");
    assert.equal(await win.webContents.executeJavaScript('diagnosticReport().receiver'), null);
    // Repeat capture with the same paired viewer to check stop/start negotiation.
    await win.webContents.executeJavaScript("document.getElementById('start').click()", true);
    await until(viewer, "document.getElementById('screen').videoWidth > 0 && document.getElementById('screen').currentTime > 0.25");
    await viewer.loadURL(`http://127.0.0.1:${server.port}/#${server.token}`);
    await until(viewer, "document.getElementById('join') !== null");
    await viewer.webContents.executeJavaScript("document.getElementById('join').click()", true);
    await until(viewer, "document.getElementById('screen').videoWidth > 0 && document.getElementById('screen').currentTime > 0.25");
    await win.webContents.executeJavaScript("document.getElementById('stop').click()", true);
    await until(viewer, "document.getElementById('screen').srcObject === null && document.getElementById('status').textContent === '전송 대기'");
    await win.webContents.executeJavaScript(`{
      const toggle = document.getElementById('low-latency');
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      document.getElementById('quality').value = 'light';
      document.getElementById('fps').value = '30';
      document.getElementById('start').click();
    }`, true);
    await until(viewer, "document.getElementById('screen').videoWidth > 0 && document.getElementById('screen').currentTime > 0.25");
    const standardMode = await verifyMode(win, viewer, false);
    await win.webContents.executeJavaScript("document.getElementById('stop').click()", true);
    console.log(JSON.stringify({ ok: true, capture: { label: chosen.label, x: chosen.x, primary: chosen.primary, width: video.width, height: video.height }, lowMode, standardMode, measurement, checks: ['native desktop capture', 'WebRTC video frames', 'low-latency sender and receiver settings', 'receiver diagnostics delivery and reset', 'viewer retry', 'stop', 'restart', 'viewer reload', 'restore standard mode'], issues }, null, 2));
    viewer.destroy();
    await server.close();
    app.exit(0);
  } catch (error) {
    const hostState = await win.webContents.executeJavaScript("({ status: document.getElementById('status').textContent, message: document.getElementById('message').textContent })").catch(() => ({}));
    console.error(JSON.stringify({ ok: false, error: error.message, hostState, issues }, null, 2));
    viewer?.destroy();
    await server.close();
    app.exit(1);
  }
}
module.exports = { run };
