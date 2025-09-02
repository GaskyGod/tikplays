const path = require('path');
const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const { keyboard, Key } = require('@nut-tree-fork/nut-js'); // ✅ pulsaciones
const say = require('say');
const axios = require('axios');          // 👈 ServerTap
const qs = require('qs');                // 👈 x-www-form-urlencoded
const streakState = new Map();           // `${uniqueId}:${giftId}` -> número
const countdown = require('./server/countdown'); 
const giftBattle = require('./server/giftBattle');
const coinBoard = require('./server/coinBoard');
const wins = require('./server/wins');
const profileStore = require('./server/profileStore'); // 👈 NUEVO

// ====== Firebase Admin para licencias ======
const admin = require('firebase-admin');
try {
  if (!admin.apps.length) {
    const serviceAccount = require('./serviceAccount.json'); // ruta relativa a server.js
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
} catch (e) {
  console.warn('⚠️ Firebase Admin no inicializado (serviceAccount.json faltante o inválido). Endpoints /license/* fallarán.');
}
const fdb = admin.apps?.length ? admin.firestore() : null;




// ---- middlewares opcionales ----
let compression = () => (req, res, next) => next();
let helmet = () => (req, res, next) => next();
let morgan = () => (req, res, next) => next();
try { compression = require('compression'); } catch {}
try { helmet = require('helmet'); } catch {}
try { morgan = require('morgan'); } catch {}

// fetch para Node <18
if (typeof fetch === 'undefined') {
  global.fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
}



const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });





// ---- middlewares base ----

// ===== Perfiles =====
app.get('/profiles', (_req,res)=>{
  res.json(profileStore.listProfiles());
});

app.post('/profiles/create', express.json(), (req,res)=>{
  try { const p = profileStore.createProfile(String(req.body?.name||'').trim()); return res.json({ ok:true, profile:p }); }
  catch(e){ return res.status(400).json({ ok:false, error:e.message }); }
});

app.post('/profiles/rename', express.json(), (req,res)=>{
  try { const p = profileStore.renameProfile(String(req.body?.id||''), String(req.body?.name||'')); return res.json({ ok:true, profile:p }); }
  catch(e){ return res.status(400).json({ ok:false, error:e.message }); }
});

app.post('/profiles/switch', express.json(), (req,res)=>{
  try {
    profileStore.switchProfile(String(req.body?.id||''));

    topGift     = safeReadJSON(PATHS.TOP_GIFT_FILE(), { diamondCount:0, giftName:'', giftImage:'', username:'', coins:0 });
    giftCatalog = safeReadJSON(PATHS.GIFTS_FILE(), {});
    goals       = ensureGoalsShape(safeReadJSON(PATHS.GOALS_FILE(), {}));
    prefs       = safeReadJSON(PATHS.PREFS_FILE(), prefs || {});

    io.emit('topGiftUpdate', topGift);
    io.emit('giftCatalog', giftCatalog);
    io.emit('goals', goals);
    io.emit('winsHotkeys', prefs.winsHotkeys || {});
    return res.json({ ok:true, active: profileStore.getActiveId() });
  } catch(e){
    return res.status(400).json({ ok:false, error:e.message });
  }
});


app.post('/profiles/delete', express.json(), (req,res)=>{
  try { const s = profileStore.deleteProfile(String(req.body?.id||'')); return res.json({ ok:true, state:s }); }
  catch(e){ return res.status(400).json({ ok:false, error:e.message }); }
});

app.get('/profiles/export', (req,res)=>{
  try {
    const id = String(req.query?.id || profileStore.getActiveId());
    const pkg = profileStore.exportProfile(id);
    res.json({ ok:true, pkg });
  } catch(e){ res.status(400).json({ ok:false, error:e.message }); }
});

app.post('/profiles/import', express.json({limit:'5mb'}), (req,res)=>{
  try { const r = profileStore.importProfile(req.body?.pkg); return res.json({ ok:true, profile:r }); }
  catch(e){ return res.status(400).json({ ok:false, error:e.message }); }
});



app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '256kb' }));

giftBattle.init({ app, io });
countdown.init({ app, io });
coinBoard.init({ app, io });
wins.init({ app, io });

// ⬇️ Rutas estáticas robustas para build
const PUBLIC_DIR = path.join(__dirname, 'public');
// --- NO CACHE para HTML y APIs (evita tener que hacer Ctrl+F5)
app.use((req, res, next) => {
  const isHTML =
    req.path === '/' ||
    req.path.endsWith('.html');

  const isAPI =
    req.path.startsWith('/get') ||
    req.path.startsWith('/set') ||
    req.path === '/connect' ||
    req.path === '/disconnect' ||
    req.path === '/testGift';

  if (isHTML || isAPI) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

app.use(express.static(PUBLIC_DIR, { maxAge: '1d', etag: true }));

// ---- archivos persistentes ----
// Rutas dinámicas basadas en el perfil activo
const PATHS = {
  WEBHOOKS_FILE: () => profileStore.resolvePath('webhooks.json'),
  TOP_GIFT_FILE: () => profileStore.resolvePath('topGift.json'),
  GIFTS_FILE:    () => profileStore.resolvePath('giftCatalog.json'),
  GOALS_FILE:    () => profileStore.resolvePath('goals.json'),
  PREFS_FILE:    () => profileStore.resolvePath('prefs.json'),
};

// Carpeta de videos por perfil (p.ej. .../profiles/<id>/videos)
const VIDEOS_DIR = profileStore.resolvePath('videos');
try { fs.mkdirSync(VIDEOS_DIR, { recursive: true }); } catch {}

// Multer storage: guarda el archivo con timestamp para evitar colisiones
const multer = require('multer');
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, VIDEOS_DIR),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.mp4').toLowerCase();
      const safe = path.basename(file.originalname, path.extname(file.originalname))
                    .replace(/[^a-z0-9\-_.]+/gi, '_')
                    .slice(0, 60);
      cb(null, `${Date.now()}_${safe}${ext}`);
    }
  }),
  fileFilter: (_req, file, cb) => {
    const ok = /video\//i.test(file.mimetype) || /\.(mp4|webm|ogg)$/i.test(file.originalname);
    cb(ok ? null : new Error('Tipo de archivo no soportado'), ok);
  },
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB
});


// Sirve index.html explícitamente
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Endpoint de salud
app.get('/health', (_req, res) => res.json({ ok: true }));

app.use(morgan('tiny'));

// Servir videos del perfil activo (URL base /videos/)
app.use('/videos', express.static(VIDEOS_DIR, { maxAge: '365d', etag: true }));

// Subir video (form field: "video")
app.post('/uploadVideo', upload.single('video'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'Archivo requerido' });
    const url = `/videos/${req.file.filename}`;  // URL pública para el overlay
    return res.json({ ok:true, url, name: req.file.originalname });
  } catch (e) {
    return res.status(500).json({ ok:false, error:'Error al subir video' });
  }
});







// ---- utils persistencia ----
function safeReadJSON(pathFile, fallback = {}) {
  try {
    if (!fs.existsSync(pathFile)) return fallback;
    const txt = fs.readFileSync(pathFile, 'utf8').trim();
    if (!txt) return fallback;
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}
function saveJSON(pathFile, data) {
  fs.writeFileSync(pathFile, JSON.stringify(data, null, 2));
}
function ensureGoalsShape(input) {
  const def = { likes: { target: 1000, current: 0 }, followers: { target: 10, current: 0 } };
  const g = (input && typeof input === 'object') ? input : {};
  g.likes = g.likes && typeof g.likes === 'object' ? g.likes : {};
  g.followers = g.followers && typeof g.followers === 'object' ? g.followers : {};
  g.likes.target = +g.likes.target > 0 ? +g.likes.target : def.likes.target;
  g.likes.current = +g.likes.current >= 0 ? +g.likes.current : def.likes.current;
  g.followers.target = +g.followers.target > 0 ? +g.followers.target : def.followers.target;
  g.followers.current = +g.followers.current >= 0 ? +g.followers.current : def.followers.current;
  return g;
}

// ---- estado ----
let tiktokLiveConnection = null;
let connectedUser = null;


let topGift = safeReadJSON(PATHS.TOP_GIFT_FILE(), {
  diamondCount: 0, giftName: '', giftImage: '', username: '', coins: 0
});
let giftCatalog = safeReadJSON(PATHS.GIFTS_FILE(), {});
let goals = ensureGoalsShape(safeReadJSON(PATHS.GOALS_FILE(), {}));
let prefs = safeReadJSON(PATHS.PREFS_FILE(), {
  ttsEnabled: true,
  ttsVoice: 'default',
  serverTapHost: '',
  serverTapPort: 4570,
  winsHotkeys: { inc: 'CommandOrControl+Up', dec: 'CommandOrControl+Down', reset: 'CommandOrControl+0' }
});

// para no perder conteo entre eventos like del mismo runtime
let lastLikesCount = goals?.likes?.current || 0;

// Helper para resolver la URL base de ServerTap (pref > env > default)
function getServerTapBase() {
  const host = (prefs.serverTapHost || '').trim();
  const port = parseInt(prefs.serverTapPort, 10) || 4570;

  if (host) return `http://${host}:${port}`;            // preferir lo guardado en prefs
  if (process.env.SERVER_TAP_URL)                       // fallback a ENV si existe
    return process.env.SERVER_TAP_URL.replace(/\/+$/,'');
  return 'http://localhost:4570';                       // default
}


// ---- Webhooks persistentes ----
function readWebhooks() { return safeReadJSON(PATHS.WEBHOOKS_FILE(), {}); }
function writeWebhooks(obj) {
  const clean = {};
  for (const [id, v] of Object.entries(obj || {})) {
    if (!id) continue;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) clean[id] = s;
      continue;
    }
    const it = {};
    if (v.webhook)       it.webhook     = String(v.webhook).trim();
    if (v.key)           it.key         = String(v.key).trim();
    if (v.mcCommand)     it.mcCommand   = String(v.mcCommand).trim();
    if (v.repeat != null) it.repeat     = Math.max(1, parseInt(v.repeat, 10) || 1);

    // sonido
    if (v.soundUrl)        it.soundUrl    = String(v.soundUrl).trim();
    if (v.soundVolume!=null) {
      const vol = Math.max(0, Math.min(1, parseFloat(v.soundVolume) || 0));
      it.soundVolume = vol;
    }

    // ✨ NUEVO: video para overlay
if (v.videoUrl)       it.videoUrl    = String(v.videoUrl).trim();
if (v.videoVolume != null) {
  const vol = Math.max(0, Math.min(1, parseFloat(v.videoVolume) || 0));
  it.videoVolume = vol;
}
if (v.videoLoop != null) it.videoLoop = !!v.videoLoop;


    if (Object.keys(it).length) clean[id] = it;
  }
  saveJSON(PATHS.WEBHOOKS_FILE(), clean);
  return clean;
}



// ---- rutas ----
app.get('/getWebhooks', (_req, res) => res.json(readWebhooks()));
app.post('/setWebhooks', (req, res) => { writeWebhooks(req.body); res.sendStatus(200); });

app.post('/testGift', (req, res) => {
  const { giftId = '', username = 'tester', quantity = 1, displayName, avatar } = req.body || {};
  if (!giftId) return res.status(400).json({ error: 'giftId requerido' });

  handleGift(String(giftId), username, Math.max(1, +quantity || 1), { displayName, avatar });
  res.json({ ok: true });
});


app.get('/getGiftCatalog', (_req, res) => res.json(giftCatalog));
app.get('/getGoals', (_req, res) => res.json(goals));
app.post('/setGoals', (req, res) => {
  goals = ensureGoalsShape(req.body);
  saveJSON(PATHS.GOALS_FILE(), goals);
  io.emit('goals', goals);
  res.json({ ok: true, goals });
});

// Preferencias (TTS)
app.get('/getPrefs', (_req, res) => res.json(prefs));
app.post('/setPrefs', (req, res) => {
  const b = req.body || {};

  if (typeof b.ttsEnabled === 'boolean') prefs.ttsEnabled = b.ttsEnabled;
  if (typeof b.ttsVoice === 'string')    prefs.ttsVoice   = b.ttsVoice;

  if (typeof b.serverTapHost === 'string') {
    prefs.serverTapHost = b.serverTapHost.trim().replace(/[^a-zA-Z0-9\.\-:]/g, '');
  }
  if (b.serverTapPort != null) {
    const port = parseInt(b.serverTapPort, 10);
    if (port >= 1 && port <= 65535) prefs.serverTapPort = port;
  }

  if (b.winsHotkeys && typeof b.winsHotkeys === 'object') {
    const hk = b.winsHotkeys;
    prefs.winsHotkeys = {
      inc: String(hk.inc || 'CommandOrControl+Up'),
      dec: String(hk.dec || 'CommandOrControl+Down'),
      reset: String(hk.reset || 'CommandOrControl+0')
    };
  }

  saveJSON(PATHS.PREFS_FILE(), prefs);
  io.emit('log', `🛠️ ServerTap apuntando a: ${getServerTapBase()}`);
  io.emit('winsHotkeys', prefs.winsHotkeys); // informativo
  return res.json({ ok: true, prefs });
});


// ====== Sound Library (proxy a MyInstants) ======
const cheerio = require('cheerio'); // <== instala: npm i cheerio

// GET /soundlib?q=boom
// Devuelve [{title, mp3, page}] con hasta 30 resultados
app.get('/soundlib', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [] });

  try {
    // 1) Buscar en MyInstants
    const searchUrl = `https://www.myinstants.com/en/search/?name=${encodeURIComponent(q)}`;
    const html = await (await fetch(searchUrl)).text();
    const $ = cheerio.load(html);

    // Cada resultado tiene link a /en/instant/<slug>/
    const instantLinks = [];
    $('a.instant-link, a[href*="/instant/"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (href.includes('/instant/')) {
        const page = new URL(href, 'https://www.myinstants.com').toString();
        const title = $(a).text().trim() || $(a).attr('title') || 'Sound';
        instantLinks.push({ title, page });
      }
    });

    // 2) Abrir cada página y extraer el enlace del MP3 (/media/sounds/xxx.mp3)
    const items = [];
    for (const it of instantLinks.slice(0, 30)) {
      try {
        const ph = await (await fetch(it.page)).text();
        const $$ = cheerio.load(ph);
        // botón "Download MP3"
        let mp3 = null;

        // Buscar href a /media/sounds/*.mp3
        $$('a').each((_, a) => {
          const href = $$(a).attr('href') || '';
          if (href.endsWith('.mp3') && href.includes('/media/sounds/')) {
            mp3 = new URL(href, 'https://www.myinstants.com').toString();
          }
        });

        if (mp3) items.push({ title: it.title, mp3, page: it.page });
      } catch {}
    }

    res.json({ items });
  } catch (e) {
    res.status(500).json({ items: [], error: 'Soundlib fetch error' });
  }
});

// ---- helpers ----
async function safeFetch(url, payload) {
  try { await fetch(url, payload); }
  catch (err) { io.emit('log', `⚠️ Error en webhook: ${err}`); }
}

// ⛏️ Enviar comando a Minecraft (ServerTap)
async function sendMinecraftCommand(command) {
  try {
    await axios.post(
      `${getServerTapBase()}/v1/server/exec`,
      qs.stringify({ command }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    io.emit('log', `🎮 Comando MC ejecutado: ${command}`);
  } catch (err) {
    io.emit('log', `❌ Error comando MC: ${err.response?.status} - ${err.response?.data?.title || err.message}`);
  }
}

// mapear teclas de texto a nut-js
const nutKeyMap = {
  a: Key.A, b: Key.B, c: Key.C, d: Key.D, e: Key.E, f: Key.F, g: Key.G,
  h: Key.H, i: Key.I, j: Key.J, k: Key.K, l: Key.L, m: Key.M, n: Key.N,
  o: Key.O, p: Key.P, q: Key.Q, r: Key.R, s: Key.S, t: Key.T, u: Key.U,
  v: Key.V, w: Key.W, x: Key.X, y: Key.Y, z: Key.Z,
  '0': Key.Num0, '1': Key.Num1, '2': Key.Num2, '3': Key.Num3, '4': Key.Num4,
  '5': Key.Num5, '6': Key.Num6, '7': Key.Num7, '8': Key.Num8, '9': Key.Num9,
  enter: Key.Enter, space: Key.Space, esc: Key.Escape,
  up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right
};
async function pressKey(keyName) {
  const k = nutKeyMap[keyName.toLowerCase()];
  if (!k) throw new Error(`Tecla no soportada: ${keyName}`);
  await keyboard.pressKey(k);
  await keyboard.releaseKey(k);
}

function runEntry(entry) {
  // 🎬 NUEVO: reproducir video en overlay (browser source)
if (entry.videoUrl) {
  const volume = Math.max(0, Math.min(1, parseFloat(entry.videoVolume ?? 1) || 1));
  const loop   = !!entry.videoLoop;
  io.emit('playVideo', { url: entry.videoUrl, volume, loop });
  io.emit('log', `🎬 Video: ${entry.videoUrl} (vol ${volume * 100 | 0}%${loop ? ', loop' : ''})`);
}

  if (!entry) return;

  const repeat = Math.max(1, parseInt((entry.repeat || 1), 10) || 1);
  for (let r = 0; r < repeat; r++) {
    if (entry.webhook && typeof entry.webhook === 'string' && entry.webhook.startsWith('http')) {
      safeFetch(entry.webhook, {
        method: 'POST',
        body: JSON.stringify({ trigger: 'special' }),
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (entry.key) {
      pressKey(entry.key)
        .then(() => io.emit('log', `🎹 Pulsada la tecla: ${entry.key}`))
        .catch(e => io.emit('log', `⚠️ Error simulando tecla "${entry.key}": ${e}`));
    }
    if (entry.mcCommand) {
      sendMinecraftCommand(entry.mcCommand);
    }
  }
}
function checkLikeStepRules(prevLikes, nowLikes) {
  if (nowLikes <= 0) return;
  const webhooks = readWebhooks();

  for (const [id, raw] of Object.entries(webhooks)) {
    if (!id.startsWith('LIKES:')) continue;
    const step = parseInt(id.split(':')[1], 10);
    if (!step || step < 1) continue;

    // baldes cruzados: de ⌊prev/step⌋ a ⌊now/step⌋
    const prevBucket = Math.floor((prevLikes || 0) / step);
    const nowBucket  = Math.floor((nowLikes  || 0) / step);

    if (nowBucket > prevBucket) {
      const entry = (typeof raw === 'string') ? { webhook: raw } : (raw || {});
      for (let b = prevBucket + 1; b <= nowBucket; b++) {
        runEntry(entry);
        io.emit('log', `💥 Regla LIKES:${step} disparada (bucket ${b})`);
      }
    }
  }
}


// ---- handler principal de regalos ----
function handleGift(giftId, username, quantity, extras = {}) {
  const { displayName = username, avatar = '' } = extras;

  const webhooks = readWebhooks();
  const giftInfo = giftCatalog[giftId] || {};
  const entryRaw = webhooks[giftId];

  const entry = (typeof entryRaw === 'string')
    ? { webhook: entryRaw }
    : (entryRaw || {});

    // 🎬 Video
if (entry.videoUrl) {
  const volume = Math.max(0, Math.min(1, parseFloat(entry.videoVolume ?? 1) || 1));
  const loop   = !!entry.videoLoop;
  io.emit('playVideo', { url: entry.videoUrl, volume, loop });
}


  if (entry && (entry.webhook || entry.key || entry.mcCommand || entry.soundUrl)) {
    const repeat = Math.max(1, parseInt((entry.repeat || 1), 10) || 1);

    for (let i = 0; i < quantity; i++) {
      for (let r = 0; r < repeat; r++) {
        if (entry.webhook && typeof entry.webhook === 'string' && entry.webhook.startsWith('http')) {
          safeFetch(entry.webhook, {
            method: 'POST',
            body: JSON.stringify({ giftId }),
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (entry.key) {
          pressKey(entry.key)
            .then(() => io.emit('log', `🎹 Pulsada la tecla: ${entry.key}`))
            .catch(e => io.emit('log', `⚠️ Error simulando tecla "${entry.key}": ${e}`));
        }

        if (entry.mcCommand) {
          sendMinecraftCommand(entry.mcCommand);
        }

        // 🔊 Sonido
        if (entry.soundUrl) {
          const volume = Math.max(0, Math.min(1, parseFloat(entry.soundVolume ?? 1) || 1));
          io.emit('playSound', { url: entry.soundUrl, volume });
        }
      }
    }
    io.emit('log', `🔗 Acción ejecutada para regalo ID ${giftId} (${quantity}x, repeat ${repeat})`);
  }

  // Notificar al cliente
  io.emit('newGift', { giftId, username, quantity });

  // ⏱️ Cuenta regresiva extensible (por monedas)
  const coinsPerGift = giftInfo.diamondCount || 0;
  countdown.onGiftAddSeconds({ coins: coinsPerGift, quantity });

  // ⚔️ Guerra de regalos
  giftBattle.onGift({ giftId, quantity, coinsPerGift });

  // 🏆 CoinBoard: acumular y mantener avatar / displayName
  // Asegúrate de tener: const coinBoard = require('./server/coinBoard');
  coinBoard.onGift({
    uniqueId: username,
    displayName,
    avatar,                // <— ahora sí lo mandamos
    coinsPerGift,
    quantity
  });

  // 👑 Top Gift (mayor valor unitario visto)
  const currentCoins = coinsPerGift;
  if (currentCoins > (topGift.diamondCount || 0)) {
    topGift = {
      diamondCount: currentCoins,
      giftName: giftInfo.name || 'Regalo',
      giftImage: giftInfo.image || '',
      username: displayName || username,
      coins: currentCoins
    };
    saveJSON(PATHS.TOP_GIFT_FILE(), topGift);
    io.emit('topGiftUpdate', topGift);
  }
}



// ---- conexión TikTok ----
app.post('/connect', async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username requerido' });
  if (tiktokLiveConnection) return res.status(400).json({ error: 'Ya hay conexión activa' });

  tiktokLiveConnection = new WebcastPushConnection(username, {
    processInitialData: true,
    enableExtendedGiftInfo: true
  });
  connectedUser = username;

  try {
    const state = await tiktokLiveConnection.connect();
    io.emit('log', `✅ Conectado a la sala de ${username} (RoomID: ${state.roomId})`);
    io.emit('connected', true);

// ---- catálogo de regalos ----
try {
  const getGiftsFn =
    tiktokLiveConnection.getAvailableGifts?.bind(tiktokLiveConnection) ||
    tiktokLiveConnection.fetchAvailableGifts?.bind(tiktokLiveConnection);

  const giftList = await getGiftsFn();

  // 👉 ORDENAR por diamond_count asc, luego nombre, luego id
  const sorted = [...giftList].sort((a, b) => {
    const da = a.diamond_count ?? a.diamondCount ?? 0;
    const db = b.diamond_count ?? b.diamondCount ?? 0;
    if (da !== db) return da - db;
    const na = (a.name || '').toLowerCase();
    const nb = (b.name || '').toLowerCase();
    if (na !== nb) return na < nb ? -1 : 1;
    return (a.id || 0) - (b.id || 0);
  });

  giftCatalog = {};
  for (const gift of sorted) {
    giftCatalog[gift.id] = {
      name: gift.name,
      image: gift.image?.url_list?.[0] || gift.image?.uri || '',
      diamondCount: gift.diamond_count || gift.diamondCount || 0
    };
  }

  saveJSON(PATHS.GIFTS_FILE(), giftCatalog);
  io.emit('giftCatalog', giftCatalog);
} catch (e) {
  io.emit('log', `⚠️ No se pudo cargar catálogo: ${e}`);
}


    // ---- eventos ----
    tiktokLiveConnection.on('gift', (d) => {
  io.emit('log', '📦 GIFT RAW: ' + JSON.stringify({
    giftId: d.giftId,
    giftName: d.giftName,
    giftType: d.giftType,
    repeatCount: d.repeatCount,
    repeatEnd: d.repeatEnd,
    uniqueId: d.uniqueId,
    nickname: d.nickname || d.user?.nickname,
    avatar: d.profilePictureUrl
      || d.user?.profilePictureUrl
      || d.user?.avatarThumb?.url_list?.[0]
      || d.user?.avatarLarger?.url_list?.[0]
      || ''
  }));

  const giftId = String(d.giftId);
  const userId = d.uniqueId || 'anon';
  const key = `${userId}:${giftId}`;

  // 👤 Datos de presentación
  const displayName = d.nickname || d.user?.nickname || d.uniqueId;
  const avatar =
    d.profilePictureUrl ||
    d.user?.profilePictureUrl ||
    d.user?.avatarThumb?.url_list?.[0] ||
    d.user?.avatarLarger?.url_list?.[0] ||
    '';

  if (d.giftType === 1) {
    // Modo streak/combo
    const curr = Math.max(1, parseInt(d.repeatCount, 10) || 1);
    const prev = streakState.get(key) || 0;
    const inc  = Math.max(0, curr - prev);

    if (inc > 0) {
      handleGift(giftId, userId, inc, { displayName, avatar }); // 👈 pasa extras
      io.emit('log', `⚡ ${userId} avanzó combo ${d.giftName}: +${inc} (total x${curr})`);
    }

    streakState.set(key, curr);
    if (d.repeatEnd === true) {
      io.emit('log', `✅ Combo finalizado: ${d.giftName} x${curr}`);
      streakState.delete(key);
    }
    return;
  }

  // Regalo normal (no streak)
  const qty = Math.max(1, parseInt(d.repeatCount, 10) || 1);
  handleGift(giftId, userId, qty, { displayName, avatar }); // 👈 pasa extras
  io.emit('log', `🎁 ${userId} envió ${d.giftName} x${qty} (no streak)`);
});


    tiktokLiveConnection.on('chat', d => {
      const text = `${d.uniqueId} dice: ${d.comment}`;
      if (prefs.ttsEnabled && d.userSceneTypes?.includes(10)) {
        try { say.speak(text); } catch {}
      }
    });

    tiktokLiveConnection.on('like', d => {
      goals.likes.current += (Number(d?.likeCount) || 1);
      saveJSON(PATHS.GOALS_FILE(), goals);
      io.emit('likeProgress', goals.likes);

        // 👇 dispara reglas LIKES:<paso>
      checkLikeStepRules(lastLikesCount, goals.likes.current);
      lastLikesCount = goals.likes.current;
    });

    tiktokLiveConnection.on('follow', () => {
      goals.followers.current += 1;
      saveJSON(PATHS.GOALS_FILE(), goals);
      io.emit('followersProgress', goals.followers);

      // 👇 si hay regla FOLLOW, ejecutarla
      const raw = readWebhooks()['FOLLOW'];
      if (raw) {
        const entry = (typeof raw === 'string') ? { webhook: raw } : raw;
        runEntry(entry);
        io.emit('log', '💥 Regla FOLLOW disparada (nuevo seguidor)');
  }
    });

    return res.sendStatus(200);
  } catch (err) {
    io.emit('log', `❌ Error al conectar: ${err}`);
    try { tiktokLiveConnection?.disconnect?.(); } catch {}
    tiktokLiveConnection = null;
    connectedUser = null;
    io.emit('connected', false);
    return res.status(500).json({ error: 'No se pudo conectar' });
  }
});

app.post('/disconnect', (_req, res) => {
  if (!tiktokLiveConnection) return res.status(400).json({ error: 'No hay conexión activa' });
  try { tiktokLiveConnection.disconnect(); } catch {}
  tiktokLiveConnection = null;
  connectedUser = null;
  io.emit('log', '❌ Desconectado de TikTok Live');
  io.emit('connected', false);
  coinBoard.onDisconnect(); // opcional: limpia si resetOnDisconnect=true
  res.sendStatus(200);
});

// ---- sockets ----
io.on('connection', socket => {
  socket.emit('topGiftUpdate', topGift);
  socket.emit('giftCatalog', giftCatalog);
  socket.emit('goals', goals);

  // 👉 añade esto:
  try {
    const gbState = require('./server/giftBattle'); // mismo módulo
    gbState.broadcast?.(); // emite a todos (incluye al nuevo)
    // o si prefieres sólo al nuevo, expón una función getState() en giftBattle y haz socket.emit('giftBattle', getState());
  } catch {}
  try { socket.emit('wins', wins.getState()); } catch {}
});


// ---- shutdown ----
function shutdown() {
  try { tiktokLiveConnection?.disconnect?.(); } catch {}
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const PORT = process.env.PORT || 3000;

// ====== Endpoints de licencia (ligadas a 1 PC) ======
app.post('/license/validate', async (req, res) => {
  if (!fdb) return res.status(500).json({ ok: false, reason: 'Servidor sin Firebase Admin' });
  const { key, deviceId } = req.body || {};
  if (!key || !deviceId) return res.status(400).json({ ok:false, reason:'key & deviceId requeridos' });

  try {
    const snap = await fdb.collection('licenses').doc(key).get();
    if (!snap.exists) return res.json({ ok:false, reason:'La licencia no existe' });
    const data = snap.data() || {};
    if (data.active !== true) return res.json({ ok:false, reason:'Licencia inactiva' });

    // No reclamada aún
    if (!data.deviceId) return res.json({ ok:true, status:'UNCLAIMED' });

    // Reclamada por esta misma PC
    if (data.deviceId === deviceId) {
      await snap.ref.update({ lastSeen: admin.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
      return res.json({ ok:true, status:'MATCH' });
    }

    // Reclamada por otra PC
    return res.json({ ok:false, reason:'Licencia ya reclamada por otra PC' });
  } catch (e) {
    return res.status(500).json({ ok:false, reason:'Error servidor' });
  }
});

app.post('/license/claim', async (req, res) => {
  if (!fdb) return res.status(500).json({ ok: false, reason: 'Servidor sin Firebase Admin' });
  const { key, deviceId } = req.body || {};
  if (!key || !deviceId) return res.status(400).json({ ok:false, reason:'key & deviceId requeridos' });

  try {
    const ref = fdb.collection('licenses').doc(key);
    await fdb.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('NO_LICENSE');
      const data = snap.data() || {};
      if (data.active !== true) throw new Error('INACTIVE');

      // Ya reclamada por otra PC
      if (data.deviceId && data.deviceId !== deviceId) throw new Error('ALREADY_CLAIMED');

      // Reclamar si está libre
      if (!data.deviceId) {
        tx.update(ref, {
          deviceId,
          claimedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastSeen: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        // Si coincide, solo refrescamos lastSeen
        tx.update(ref, { lastSeen: admin.firestore.FieldValue.serverTimestamp() });
      }
    });

    return res.json({ ok:true });
  } catch (e) {
    if (e.message === 'NO_LICENSE') return res.json({ ok:false, reason:'La licencia no existe' });
    if (e.message === 'INACTIVE') return res.json({ ok:false, reason:'Licencia inactiva' });
    if (e.message === 'ALREADY_CLAIMED') return res.json({ ok:false, reason:'Licencia ya reclamada por otra PC' });
    return res.status(500).json({ ok:false, reason:'Error servidor' });
  }
});


server.listen(PORT, () => console.log(`🚀 Servidor en http://localhost:${PORT}`));
