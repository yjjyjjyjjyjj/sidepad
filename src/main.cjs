const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, shell, clipboard, powerSaveBlocker } = require('electron');
const { networkInterfaces, cpus } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { writeFile, rename, readFile, mkdir } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const QRCode = require('qrcode');
const { DisplayServer } = require('./server.cjs');

const projectRoot = path.join(__dirname, '..');
app.setName('Sidepad');
if (process.platform === 'win32') app.setAppUserModelId('com.sidepad.desktop');
const codecProbe = process.argv.includes('--codec-probe');
const smoke = process.argv.includes('--smoke-test') || codecProbe;
const hardwarePreview = process.argv.includes('--hardware-preview');
const bufferPreview = process.argv.includes('--buffer-preview');
const preview = process.argv.includes('--preview') || hardwarePreview || bufferPreview;
app.setPath('userData', path.join(projectRoot, '.runtime', ...(smoke ? ['smoke'] : bufferPreview ? ['buffer-preview'] : hardwarePreview ? ['hardware-preview'] : preview ? ['preview'] : [])));
const hostFile = path.join(__dirname, 'host', 'index.html');
const hostUrl = pathToFileURL(hostFile).href;
let win, server, selectedId = null, blocker = null;
let driverProcess = null;
let previousResources;
let diagnosticWrite = Promise.resolve();

function performanceSnapshot() {
  const now = performance.now();
  const processes = app.getAppMetrics();
  let cpuSeconds = 0, measured = false;
  const previous = previousResources;
  const totals = new Map();
  for (const item of processes) {
    const total = item.cpu.cumulativeCPUUsage;
    if (!Number.isFinite(total)) continue;
    totals.set(item.pid, total);
    const before = previous?.totals.get(item.pid);
    if (Number.isFinite(before) && total >= before) { cpuSeconds += total - before; measured = true; }
  }
  previousResources = { now, totals };
  return {
    cpuPercent: measured && now > previous.now ? cpuSeconds / ((now - previous.now) / 1000) / cpus().length * 100 : null,
    videoEncodeFeature: app.getGPUFeatureStatus().video_encode || 'unknown',
    processCount: processes.length
  };
}

function addresses() {
  return [...new Set(Object.values(networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address))];
}

async function displays() {
  const primary = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  return screen.getAllDisplays().map(display => ({
    id: String(display.id),
    label: display.label || `디스플레이 ${display.id}`,
    primary: display.id === primary.id,
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
    x: display.bounds.x, y: display.bounds.y,
    available: sources.some(source => source.display_id === String(display.id))
  }));
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function showMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  const area = screen.getPrimaryDisplay().workArea;
  const bounds = win.getBounds();
  win.setPosition(area.x + Math.max(0, Math.floor((area.width - bounds.width) / 2)),
    area.y + Math.max(0, Math.floor((area.height - bounds.height) / 2)));
  win.show();
  win.focus();
}

function stopCapture() {
  selectedId = null;
  previousResources = null;
  server?.setActive(false);
  if (blocker !== null && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
  blocker = null;
}

function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame?.url !== hostUrl) throw new Error('Unauthorized caller');
    return fn(...args);
  });
}

async function start() {
  const ips = addresses();
  // Preview and smoke tests never acquire the live app's profile or listening port.
  const port = smoke ? 0 : bufferPreview ? 3214 : hardwarePreview ? 3213 : preview ? 3212 : Number(process.env.SIDEPAD_PORT || process.env.IPAD_DISPLAY_PORT || 3210);
  server = await new DisplayServer({ port }).listen(ips);
  server.on('viewer', data => send('display:viewer', data));
  server.on('signal', data => send('display:signal', data));
  server.on('retry', data => send('display:retry', data));
  server.http.on('error', error => send('display:error', error.message));

  handle('display:config', async () => {
    const links = await Promise.all(ips.map(async ip => {
      const url = `http://${ip}:${server.port}/#${server.token}`;
      return { ip, url, qr: await QRCode.toDataURL(url, { width: 240, margin: 2, color: { dark: '#17232d', light: '#ffffff' } }) };
    }));
    return { links, port: server.port, displays: await displays(), peerId: server.peerId, active: server.active, preview, hardwarePreview, bufferPreview };
  });
  handle('display:list', displays);
  handle('display:performance', performanceSnapshot);
  handle('display:record-diagnostics', async report => {
    if ((!hardwarePreview && !bufferPreview) || !report || typeof report !== 'object') return;
    const text = JSON.stringify(report, null, 2);
    if (text.length > 50000) throw new Error('Diagnostic report too large');
    // Local, fixed destination; report contains no pairing token, IP, SDP or frames.
    const target = path.join(projectRoot, '.runtime', bufferPreview ? 'buffer-preview-diagnostics.json' : 'hardware-preview-diagnostics.json');
    diagnosticWrite = diagnosticWrite.catch(() => {}).then(async () => {
      await writeFile(`${target}.tmp`, text, 'utf8');
      await rename(`${target}.tmp`, target);
    });
    await diagnosticWrite;
  });
  handle('display:copy-diagnostics', text => {
    if (typeof text !== 'string' || text.length > 50000) throw new Error('Invalid diagnostic report');
    clipboard.writeText(text);
  });
  handle('display:select', async id => {
    const display = (await displays()).find(d => d.id === id && d.available && (!d.primary || smoke));
    if (!display) throw new Error('확장된 보조 디스플레이를 선택해 주세요.');
    selectedId = id;
    return display;
  });
  handle('display:active', active => {
    if (active && !selectedId) throw new Error('먼저 보조 디스플레이를 선택해 주세요.');
    server.setActive(Boolean(active));
    if (active && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
    if (!active) stopCapture();
  });
  handle('display:send', ({ peerId, signal } = {}) => {
    if (server.active && signal && ['offer', 'candidate'].includes(signal.type)) return server.send(signal, peerId);
    return false;
  });
  handle('display:disconnect', () => { server.disconnect(); send('display:viewer', { connected: false }); });
  handle('display:copy', ip => {
    if (!ips.includes(ip)) throw new Error('알 수 없는 주소');
    clipboard.writeText(`http://${ip}:${server.port}/#${server.token}`);
  });
  handle('display:settings', () => shell.openExternal('ms-settings:display'));
  handle('display:driver-page', () => shell.openExternal('https://github.com/VirtualDrivers/Virtual-Display-Driver/releases'));
  handle('display:install-driver', async () => {
    if (driverProcess) return { started: false };
    // Reserve before awaiting to prevent two elevated installers from racing.
    driverProcess = true;
    const resultDirectory = path.join(app.getPath('userData'), 'driver-setup');
    const resultPath = path.join(resultDirectory, `${randomUUID()}.json`);
    try { await mkdir(resultDirectory, { recursive: true }); }
    catch (error) { driverProcess = null; throw error; }
    driverProcess = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(projectRoot, 'scripts', 'install-driver.ps1'), '-ResultPath', resultPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    driverProcess.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-10000); });
    driverProcess.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-10000); });
    driverProcess.on('error', error => { settled = true; driverProcess = null; send('display:driver-result', { ok: false, message: error.message }); });
    driverProcess.on('close', async code => {
      if (settled) return;
      settled = true;
      let result;
      try { result = JSON.parse((await readFile(resultPath, 'utf8')).replace(/^\uFEFF/, '')); } catch { /* Failure details remain in process output. */ }
      driverProcess = null;
      const ok = code === 0 && result?.ok === true;
      const message = ok ? '가상 화면을 1920 × 1080 · 60 Hz 확장 모니터로 설정했습니다. 목록에서 선택해 화면 전송을 시작하세요.'
        : result?.rebootRequired ? '드라이버 설치 후 Windows 재시작이 필요합니다. 재시작한 뒤 ‘드라이버 설치 및 설정’을 다시 눌러 화면 설정을 마쳐 주세요.'
        : `설정을 완료하지 못했습니다. Windows 화면 설정이나 공식 다운로드에서 상태를 확인해 주세요.\n${result?.error || output}`;
      send('display:driver-result', { ok, message });
    });
    return { started: true };
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (request.frame?.url !== hostUrl || !selectedId) { callback({}); return; }
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => item.display_id === selectedId);
      if (!source) { callback({}); return; }
      callback({ video: source });
    } catch { callback({}); }
  });
  const allowedPermission = (contents, permission) => contents === win?.webContents && contents?.getURL() === hostUrl && permission === 'display-capture';
  session.defaultSession.setPermissionCheckHandler((contents, permission) => allowedPermission(contents, permission));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(allowedPermission(contents, permission)));
  win = new BrowserWindow({
    width: 1150, height: 880, minWidth: 860, minHeight: 700,
    title: 'Sidepad', icon: path.join(__dirname, 'assets', 'sidepad.ico'), backgroundColor: '#f4f5f1', show: !smoke,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('closed', () => { stopCapture(); win = null; });
  const changed = async () => {
    const list = await displays();
    if (selectedId && !list.some(display => display.id === selectedId && display.available)) {
      stopCapture();
      send('display:removed');
    }
    send('display:displays', list);
  };
  screen.on('display-added', changed);
  screen.on('display-removed', changed);
  screen.on('display-metrics-changed', changed);
  await win.loadFile(hostFile);
  if (!smoke) showMainWindow();
  if (smoke) await require(codecProbe ? '../test/codec-probe.cjs' : '../test/smoke.cjs').run({ app, win, server, displays });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showMainWindow);
  app.whenReady().then(start).catch(error => {
    console.error(error);
    if (!smoke) require('electron').dialog.showErrorBox('Sidepad 시작 실패', `${error.message}\n3210 포트가 다른 앱에서 사용 중인지 확인해 주세요.`);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { stopCapture(); server?.close().catch(() => {}); });
}
