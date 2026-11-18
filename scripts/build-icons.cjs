// Render the repo-native SVG once, then package PNG-backed Windows ICO sizes.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
app.setPath('userData', path.join(root, '.runtime', 'icon-builder'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 512, height: 512, transparent: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
  try {
    const svg = fs.readFileSync(path.join(root, 'src', 'assets', 'sidepad.svg'), 'utf8');
    const painted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Icon render timed out')), 15000);
      win.webContents.once('paint', (_event, _dirty, bitmap) => { clearTimeout(timer); resolve(bitmap); });
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>html,body{margin:0;background:transparent}svg{width:512px;height:512px;display:block}</style>${svg}`));
    const source = (await painted).resize({ width: 512, height: 512, quality: 'best' });
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const images = sizes.map(size => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
    const header = Buffer.alloc(6 + sizes.length * 16);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    sizes.forEach((size, index) => {
      const entry = 6 + index * 16;
      header[entry] = header[entry + 1] = size === 256 ? 0 : size;
      header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(images[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
      offset += images[index].length;
    });
    fs.writeFileSync(path.join(root, 'src', 'assets', 'sidepad.ico'), Buffer.concat([header, ...images]));
    fs.writeFileSync(path.join(root, 'src', 'assets', 'sidepad.png'), source.toPNG());
    fs.writeFileSync(path.join(root, 'src', 'assets', 'sidepad-180.png'), source.resize({ width: 180, height: 180, quality: 'best' }).toPNG());
    console.log('Sidepad SVG rendered to PNG, Apple touch icon and 7-size Windows ICO.');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
