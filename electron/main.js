// electron/main.js
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  shell,
  ipcMain,
  session,
  globalShortcut,
  nativeImage
} = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Recomendado en Windows para notificaciones y updater
app.setAppUserModelId('com.gaskygod.tikplays');

// ======== Logger & Updater ========
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'debug';
log.info('App start', app.getVersion());

// ======== Helpers de entorno ========
const isDev = !app.isPackaged;
log.info('[env] isPackaged=', isDev ? 'false' : 'true', 'platform=', process.platform, 'arch=', process.arch);
log.info('[env] currentVersion=', app.getVersion());
log.info('[env] resourcesPath=', process.resourcesPath);

// Intenta listar resources para verificar app-update.yml y public/*
try {
  const resDir = process.resourcesPath || path.join(process.cwd(), 'resources');
  const files = fs.existsSync(resDir) ? fs.readdirSync(resDir) : [];
  log.info('[env] resources files=', files);
  const updPath = path.join(resDir, 'app-update.yml');
  log.info('[env] app-update.yml exists=', fs.existsSync(updPath), '->', updPath);
} catch (e) {
  log.warn('[env] cannot list resources', e);
}

let mainWindow;
let tray;
const SERVER_URL = 'http://localhost:3000';

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
try { process.chdir(path.join(__dirname, '..')); } catch {}
process.env.TIKPLAYS_DATA_DIR = app.getPath('userData');

// Arranca el servidor Express de la app
require(path.join(__dirname, '..', 'server.js'));

// ======== Helpers ========
function cacheBustUrl(baseUrl) {
  const v = encodeURIComponent(`${(app.getVersion && app.getVersion()) || '0.0.0'}-${Date.now()}`);
  const hasQuery = baseUrl.includes('?');
  return `${baseUrl}${hasQuery ? '&' : '?'}_v=${v}`;
}

let _fetch = global.fetch;
if (typeof _fetch !== 'function') {
  _fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
}

// Localiza assets tanto en dev como empaquetado
function resolveAsset(...p) {
  // 1) resources (packaged)
  const inResources = path.join(process.resourcesPath, ...p);
  if (fs.existsSync(inResources)) return inResources;

  // 2) asar (cuando corre desde /electron)
  const inAsar = path.join(__dirname, '..', ...p);
  if (fs.existsSync(inAsar)) return inAsar;

  // 3) cwd (dev)
  const inCwd = path.join(process.cwd(), ...p);
  if (fs.existsSync(inCwd)) return inCwd;

  log.warn('[asset] not found ->', p.join('/'));
  return null;
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

  // Sin menú nativo
  Menu.setApplicationMenu(null);

  // Evita cerrar la app: oculta a bandeja
  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

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
    _v: `${(app.getVersion && app.getVersion()) || '0.0.0'}-${Date.now()}`
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
  log.info('[tray] creating tray…');

  const iconName = process.platform === 'darwin' ? 'iconTemplate.png' : 'icon.png';
  const iconPath = resolveAsset('public', iconName);
  if (!iconPath) {
    log.error('[tray] No se encontró el ícono de bandeja');
    return;
  }

  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    log.error('[tray] nativeImage vacío para', iconPath);
    return;
  }

  tray = new Tray(image);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir app', click: () => { if (!mainWindow) createMainWindow(); else mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Overlay Likes', click: () => createOverlayWindow('likes', { title: 'Meta de Likes', accent: '#22c55e', rounded: 24 }) },
    { label: 'Overlay Seguidores', click: () => createOverlayWindow('followers', { title: 'Meta de Seguidores', accent: 'deepskyblue', rounded: 24 }) },
    { label: 'Overlay Ambos', click: () => createOverlayWindow('both', { title: '¡Vamos con todo!', accent: '#a855f7', rounded: 20 }) },
    { type: 'separator' },
    {
      label: 'Buscar actualización (main)',
      click: async () => {
        try {
          log.info('[tray] manual checkForUpdates()');
          await autoUpdater.checkForUpdates();
        } catch (e) {
          log.error('[tray] checkForUpdates error', e);
        }
      }
    },
    { type: 'separator' },
    { label: 'Ir al navegador', click: () => shell.openExternal(SERVER_URL) },
    { label: 'Salir', click: () => { log.info('[tray] quit via tray'); app.quit(); } }
  ]);
  tray.setToolTip('Tikplays');
  tray.setContextMenu(contextMenu);

  // Click en el icono para mostrar la ventana
  tray.on('click', () => { if (!mainWindow) createMainWindow(); else mainWindow.show(); });
}

// ======== Single instance ========
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
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
      autoUpdater.autoDownload = true; // descarga automática
      // Nota: quitAndInstall() se llama cuando 'update-downloaded'

      // PRIMER chequeo al inicio
      log.info('[upd] calling checkForUpdatesAndNotify()');
      autoUpdater.checkForUpdatesAndNotify().catch(err => log.error('[upd] checkForUpdatesAndNotify error', err));

      // SEGUNDO chequeo a los 5s
      setTimeout(() => {
        log.info('[upd] forcing checkForUpdates() after 5s');
        autoUpdater.checkForUpdates().catch(err => log.error('[upd] checkForUpdates error', err));
      }, 5000);

      // Chequeo periódico cada 5 min
      setInterval(() => {
        log.info('[upd] periodic checkForUpdates()');
        autoUpdater.checkForUpdates().catch(err => log.error('[upd] periodic check error', err));
      }, 5 * 60 * 1000);
    }
  });
}

// Mantén el proceso vivo (bandeja) aunque se cierren las ventanas
app.on('window-all-closed', () => {
  // No salimos en Windows para mantener el tray activo
  // if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('winsHotkeys:update', () => registerWinsHotkeys());
ipcMain.handle('overlay:open', (_evt, metric, opts) => { createOverlayWindow(metric, opts); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });

// ======== AutoUpdater events ========
autoUpdater.on('checking-for-update', () => log.info('checking-for-update'));
autoUpdater.on('update-available', (info) => log.info('update-available', info));
autoUpdater.on('update-not-available', (info) => log.info('update-not-available', info));
autoUpdater.on('download-progress', (p) => log.info('download-progress', Math.round(p.percent) + '%'));
autoUpdater.on('update-downloaded', (info) => {
  log.info('update-downloaded', info);
  autoUpdater.quitAndInstall(); // instala y reinicia automáticamente
});
autoUpdater.on('error', (err) => log.error('update error', err));

ipcMain.handle('update:installNow', () => {
  autoUpdater.quitAndInstall();
});
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('update:checkNow', async () => {
  try {
    log.info('[ipc] Manual update check invoked');
    return await autoUpdater.checkForUpdates();
  } catch (e) {
    log.error('[ipc] checkForUpdates error', e);
    throw e;
  }
});
