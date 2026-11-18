const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, shell, clipboard, powerSaveBlocker } = require('electron');
const { networkInterfaces } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const QRCode = require('qrcode');
const { DisplayServer } = require('./server.cjs');

const projectRoot = path.join(__dirname, '..');
const smoke = process.argv.includes('--smoke-test');
const preview = process.argv.includes('--preview');
app.setPath('userData', path.join(projectRoot, '.runtime', ...(smoke ? ['smoke'] : preview ? ['preview'] : [])));
const hostFile = path.join(__dirname, 'host', 'index.html');
const hostUrl = pathToFileURL(hostFile).href;
let win, server, selectedId = null, blocker = null;
let driverProcess = null;

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
  const port = smoke ? 0 : preview ? 3212 : Number(process.env.SIDEPAD_PORT || process.env.IPAD_DISPLAY_PORT || 3210);
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
    return { links, port: server.port, displays: await displays(), peerId: server.peerId, active: server.active, preview };
  });
  handle('display:list', displays);
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
  handle('display:install-driver', () => {
    if (driverProcess) return { started: false };
    driverProcess = spawn('powershell.exe', ['-NoProfile', '-File', path.join(projectRoot, 'scripts', 'install-driver.ps1')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    driverProcess.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-10000); });
    driverProcess.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-10000); });
    driverProcess.on('error', error => { driverProcess = null; send('display:driver-result', { ok: false, message: error.message }); });
    driverProcess.on('close', code => {
      driverProcess = null;
      send('display:driver-result', { ok: code === 0, message: code === 0 ? '설치 명령이 완료되었습니다. Windows 디스플레이 설정에서 확장을 선택해 주세요.' : `설치가 완료되지 않았습니다. 공식 다운로드에서 설치할 수 있습니다.\n${output}` });
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
    title: 'Sidepad · Wi-Fi 확장 모니터', backgroundColor: '#f4f5f1', show: !smoke,
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
  if (smoke) await require('../test/smoke.cjs').run({ app, win, server, displays });
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
