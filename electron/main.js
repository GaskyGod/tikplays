// electron/main.js
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, session, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.info('App start', app.getVersion());

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let mainWindow;
let tray;
const SERVER_URL = 'http://localhost:3000';

// justo antes del primer check:
autoUpdater.setFeedURL({
  provider: 'github',
  owner: 'GaskyGod',   // respeta mayúsculas como en tu repo
  repo: 'tikplays'
});

// ======== Device ID estable ========
function getStableDeviceId() {
  const idFile = path.join(app.getPath('userData'), 'device.id');
  try {
    if (fs.existsSync(idFile)) {
      const saved = fs.readFileSync(idFile, 'utf8').trim();
      if (saved) return saved;
    }
  } catch {}
  let base = `${os.hostname()}|${os.platform()}|${os.arch()}`;
  try {
    const { machineIdSync } = require('node-machine-id');
    base = machineIdSync({ original: true }) || base;
  } catch {}
  const id = crypto.createHash('sha256').update(base).digest('hex');
  try { fs.writeFileSync(idFile, id); } catch {}
  return id;
}

let DEVICE_ID;
app.whenReady().then(() => {
  DEVICE_ID = getStableDeviceId();
});
ipcMain.handle('device:getId', () => DEVICE_ID);

// ======== Datos persistentes ========
try {
  process.chdir(path.join(__dirname, '..'));
} catch {}
process.env.TIKPLAYS_DATA_DIR = app.getPath('userData');

// Arranca el servidor Express
require(path.join(__dirname, '..', 'server.js'));

// ======== Modo dev ========
const isDev = !app.isPackaged;

// Helper cache-busting
function cacheBustUrl(baseUrl) {
  const v = encodeURIComponent(`${app.getVersion?.() || '0.0.0'}-${Date.now()}`);
  const hasQuery = baseUrl.includes('?');
  return `${baseUrl}${hasQuery ? '&' : '?'}_v=${v}`;
}

// ======== Fallback fetch ========
let _fetch = global.fetch;
if (typeof _fetch !== 'function') {
  _fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
}

// ======== Hotkeys WINS ========
async function registerWinsHotkeys() {
  try {
    const r = await _fetch(`${SERVER_URL}/getPrefs`);
    const j = await r.json();
    const hk = j?.winsHotkeys || {
      inc: 'CommandOrControl+Alt+Up',
      dec: 'CommandOrControl+Alt+Down',
      reset: 'CommandOrControl+Alt+0'
    };
    globalShortcut.unregisterAll();
    const send = (body) => _fetch(`${SERVER_URL}/setWins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(() => {});
    if (hk.inc)   globalShortcut.register(hk.inc,   () => send({ action: 'inc' }));
    if (hk.dec)   globalShortcut.register(hk.dec,   () => send({ action: 'dec' }));
    if (hk.reset) globalShortcut.register(hk.reset, () => send({ action: 'reset' }));
  } catch {}
}

// ======== Ventanas ========
async function createMainWindow () {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Tikplays',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      devTools: isDev,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadURL(cacheBustUrl(SERVER_URL));
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createOverlayWindow (metric = 'both', opts = {}) {
  const query = new URLSearchParams({
    metric,
    title: opts.title || '',
    accent: opts.accent || '',
    bg: opts.bg || 'transparent',
    rounded: String(!!opts.rounded ? opts.rounded : 20),
    compact: String(!!opts.compact),
    _v: `${app.getVersion?.() || '0.0.0'}-${Date.now()}`
  }).toString();
  const win = new BrowserWindow({
    width: metric === 'both' ? 900 : 600,
    height: 200,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    movable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setIgnoreMouseEvents(false);
  win.loadURL(`${SERVER_URL}/overlay-goals.html?${query}`);
  return win;
}

function createTray() {
  tray = new Tray(
    process.platform === 'darwin'
      ? path.join(__dirname, '..', 'public', 'iconTemplate.png')
      : path.join(__dirname, '..', 'public', 'icon.png')
  );
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir app', click: () => { if (!mainWindow) createMainWindow(); else mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Overlay Likes', click: () => createOverlayWindow('likes', { title: 'Meta de Likes', accent: '#22c55e', rounded: 24 }) },
    { label: 'Overlay Seguidores', click: () => createOverlayWindow('followers', { title: 'Meta de Seguidores', accent: 'deepskyblue', rounded: 24 }) },
    { label: 'Overlay Ambos', click: () => createOverlayWindow('both', { title: '¡Vamos con todo!', accent: '#a855f7', rounded: 20 }) },
    { label: 'Buscar actualización', click: () => autoUpdater.checkForUpdates().catch(()=>{}) },
    { type: 'separator' },
    { label: 'Ir al navegador', click: () => shell.openExternal(SERVER_URL) },
    { label: 'Salir', role: 'quit' }
  ]);
  tray.setToolTip('TikTok Live Webhooks');
  tray.setContextMenu(contextMenu);
}

// ======== Single instance ========
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try { await session.defaultSession.clearCache(); } catch {}
    try {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = details.responseHeaders || {};
        const url = details.url || '';
        const isHtml = url.endsWith('.html') || url === SERVER_URL || url.startsWith(`${SERVER_URL}/?`);
        const isIndex = url === SERVER_URL || url.startsWith(`${SERVER_URL}/?`);
        if (isHtml || isIndex) {
          headers['Cache-Control'] = ['no-store, no-cache, must-revalidate, proxy-revalidate'];
          headers['Pragma'] = ['no-cache'];
          headers['Expires'] = ['0'];
          headers['Surrogate-Control'] = ['no-store'];
        }
        callback({ responseHeaders: headers });
      });
    } catch {}
    await createMainWindow();
    createTray();
    registerWinsHotkeys();

    // ======== AutoUpdater ========
if (!isDev) {
  autoUpdater.autoDownload = true;
  // Haz un primer check con notify (por si quieres notificación del sistema)
  autoUpdater.checkForUpdatesAndNotify().catch(err => log.error('checkForUpdatesAndNotify error', err));

  // Y además fuerza un check a los 5s (a veces al inicio la red tarda)
  setTimeout(() => {
    log.info('Forcing update check (5s after start)…');
    autoUpdater.checkForUpdates().catch(err => log.error('checkForUpdates error', err));
  }, 5000);

  // Repite cada 5 minutos (opcional)
  setInterval(() => {
    log.info('Periodic update check…');
    autoUpdater.checkForUpdates().catch(err => log.error('periodic check error', err));
  }, 5 * 60 * 1000);
}

});
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
ipcMain.handle('winsHotkeys:update', () => registerWinsHotkeys());
ipcMain.handle('overlay:open', (_evt, metric, opts) => { createOverlayWindow(metric, opts); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });

// ======== AutoUpdater events ========
autoUpdater.on('update-available', (info) => {
  mainWindow?.webContents.send('update:available', info);
});
autoUpdater.on('download-progress', (p) => {
  mainWindow?.webContents.send('update:progress', {
    percent: Math.round(p.percent),
    transferred: p.transferred, total: p.total
  });
});
autoUpdater.on('update-downloaded', () => {
  autoUpdater.quitAndInstall(); // instala y reinicia automáticamente
});
autoUpdater.on('error', (err) => {
  mainWindow?.webContents.send('update:error', String(err));
});

autoUpdater.on('checking-for-update', () => log.info('checking-for-update'));
autoUpdater.on('update-available', (info) => log.info('update-available', info));
autoUpdater.on('update-not-available', (info) => log.info('update-not-available', info));
autoUpdater.on('download-progress', (p) => log.info('download-progress', Math.round(p.percent) + '%'));
autoUpdater.on('update-downloaded', (info) => log.info('update-downloaded', info));
autoUpdater.on('error', (err) => log.error('update error', err));

ipcMain.handle('update:installNow', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('update:checkNow', async () => {
  try {
    log.info('Manual update check invoked');
    return await autoUpdater.checkForUpdates(); // retorna info si hay
  } catch (e) {
    log.error('checkForUpdates error', e);
    throw e;
  }
});

