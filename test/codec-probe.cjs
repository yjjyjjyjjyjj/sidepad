const { BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function until(window, expression, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await Promise.race([window.webContents.executeJavaScript(expression), delay(5000).then(() => { throw new Error(`Renderer did not answer: ${expression}`); })]);
    if (result) return result;
    await delay(250);
  }
  throw new Error(`Timed out: ${expression}`);
}

async function run({ app, win, server, displays }) {
  let viewer;
  const artifacts = path.join(__dirname, '..', 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const trace = value => { writeFileSync(path.join(artifacts, 'codec-probe-progress.json'), JSON.stringify(value, null, 2)); console.log(JSON.stringify(value)); };
  const watchdog = setTimeout(() => { console.error('Codec probe exceeded total time limit'); app.exit(1); }, 180000);
  try {
    trace({ stage: 'host-ready' });
    await until(win, "document.getElementById('status').textContent === '준비됨'");
    const available = await displays();
    const chosen = available.find(item => item.available && !item.primary && item.label === 'VDD by MTT');
    if (!chosen) throw new Error('The codec probe needs the virtual display.');
    const capabilities = await win.webContents.executeJavaScript("RTCRtpSender.getCapabilities('video').codecs");
    const profiles = [...new Set(capabilities.filter(c => c.mimeType === 'video/H264' && /packetization-mode=1(?:;|$)/.test(c.sdpFmtpLine)).map(c => c.sdpFmtpLine.match(/profile-level-id=([a-f0-9]{6})/i)?.[1]).filter(Boolean))];
    if (capabilities.some(c => c.mimeType === 'video/H265')) profiles.push('H265');
    const result = { versions: process.versions, capabilities, profiles, measurements: [] };
    writeFileSync(path.join(artifacts, 'codec-probe.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ versions: { electron: process.versions.electron, chrome: process.versions.chrome }, profiles, capabilities }));
    for (const profile of profiles) {
      trace({ stage: 'receiver-start', profile });
      viewer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'codec-probe-viewer' } });
      await viewer.loadURL(`http://127.0.0.1:${server.port}/#${server.token}`);
      // Test-only receiver: advertise exactly one genuinely supported H.264 profile.
      await viewer.webContents.executeJavaScript(`(() => {
        const original = RTCRtpReceiver.getCapabilities.bind(RTCRtpReceiver);
        RTCRtpReceiver.getCapabilities = kind => {
          const caps = original(kind);
          if (kind !== 'video') return caps;
          const codecs = caps.codecs.filter(c => ${JSON.stringify(profile)} === 'H265'
            ? c.mimeType === 'video/H265'
            : c.mimeType === 'video/H264' && c.sdpFmtpLine.includes('profile-level-id=${profile.slice(0, 4)}') && /packetization-mode=1(?:;|$)/.test(c.sdpFmtpLine));
          if (!codecs.length) throw new Error('Receiver profile unavailable');
          return { ...caps, codecs };
        };
      })()`);
      await viewer.webContents.executeJavaScript("document.getElementById('join').click()", true);
      await until(viewer, "document.getElementById('status').textContent === 'PC 연결됨'");
      await win.webContents.executeJavaScript(`{
        document.getElementById('display').value = ${JSON.stringify(chosen.id)};
        document.getElementById('quality').value = 'sharp';
        document.getElementById('fps').value = '60';
        document.getElementById('start').click();
      }`, true);
      try {
        await until(viewer, "document.getElementById('screen').videoWidth > 0 && document.getElementById('screen').currentTime > 0.25");
        const measurement = await until(win, "(() => { const r = diagnosticReport(); return r.sender?.encodeMs != null && r.receiver?.decodeMs != null && r; })()");
        result.measurements.push({ profile, ...measurement });
        console.log(JSON.stringify({ profile, sender: measurement.sender }));
      } catch (error) {
        result.measurements.push({ profile, error: error.message });
        console.log(JSON.stringify({ profile, error: error.message }));
      }
      writeFileSync(path.join(artifacts, 'codec-probe.json'), JSON.stringify(result, null, 2));
      trace({ stage: 'stopping', profile });
      await win.webContents.executeJavaScript('stop()', true);
      viewer.destroy(); viewer = null;
      await until(win, 'peerId === null');
    }
    result.ok = result.measurements.every(measurement => !measurement.error);
    writeFileSync(path.join(artifacts, 'codec-probe.json'), JSON.stringify(result, null, 2));
    trace({ stage: 'completed', ok: result.ok });
    clearTimeout(watchdog);
    await server.close(); app.exit(result.ok ? 0 : 1);
  } catch (error) {
    trace({ stage: 'failed', error: error.message });
    clearTimeout(watchdog);
    viewer?.destroy(); await server.close(); app.exit(1);
  }
}
module.exports = { run };
