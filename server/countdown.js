// server/countdown.js
const fs = require('fs');
const path = require('path');

const COUNTDOWN_FILE = path.join(process.cwd(), 'countdown.json');

// -------------------- persistencia --------------------
function readJSON(fallback = {}) {
  try {
    if (!fs.existsSync(COUNTDOWN_FILE)) return fallback;
    const txt = fs.readFileSync(COUNTDOWN_FILE, 'utf8').trim();
    if (!txt) return fallback;
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}
function saveJSON(data) {
  try { fs.writeFileSync(COUNTDOWN_FILE, JSON.stringify(data, null, 2)); }
  catch {}
}

// -------------------- estado --------------------
let state = readJSON({
  enabled: true,            // si está activo el sistema extensible
  running: false,           // si el contador está corriendo
  secondsLeft: 0,           // segundos restantes
  secondsPerCoin: 1,        // cuánto suma por moneda/diamante
  title: 'Tiempo restante', // título configurable
  maxSeconds: 0,            // 0 = sin tope; >0 = máximo acumulable
});

let ioRef = null;
let tick = null;

// Normalizamos antes de emitir (por si el JSON trae basura)
function sanitize(s) {
  const out = { ...s };
  out.enabled       = !!out.enabled;
  out.running       = !!out.running;
  out.secondsLeft   = Math.max(0, parseInt(out.secondsLeft, 10) || 0);
  out.secondsPerCoin= Math.max(0, parseFloat(out.secondsPerCoin) || 0);
  out.title         = String(out.title || 'Tiempo restante').slice(0, 120);
  out.maxSeconds    = Math.max(0, parseInt(out.maxSeconds, 10) || 0);
  return out;
}

// Emitimos el estado a todos los clientes
function broadcast() {
  ioRef?.emit('countdown', sanitize(state));
}

function clampToMax(seconds) {
  if ((state.maxSeconds || 0) > 0) return Math.min(seconds, state.maxSeconds);
  return seconds;
}

// Suma segundos y emite también el delta para el “+Xs”
function addSeconds(n, source = 'manual') {
  n = Math.max(0, parseInt(n, 10) || 0);
  if (!n) return;
  state.secondsLeft = clampToMax((state.secondsLeft || 0) + n);
  saveJSON(state);
  broadcast();
  // 👇 evento usado por el overlay para mostrar "+Xs"
  ioRef?.emit('countdown:add', { amount: n, source, at: Date.now() });
}

// Intervalo de 1s si está corriendo
function ensureTick() {
  if (tick) { clearInterval(tick); tick = null; }
  if (!state.running) return;

  tick = setInterval(() => {
    if (!state.running) { clearInterval(tick); tick = null; return; }

    if ((state.secondsLeft || 0) > 0) {
      state.secondsLeft = Math.max(0, (state.secondsLeft || 0) - 1);
      saveJSON(state);
      broadcast();
    } else {
      state.running = false;
      saveJSON(state);
      broadcast();
      clearInterval(tick);
      tick = null;
    }
  }, 1000);
}

// -------------------- API del módulo --------------------
module.exports = {
  init({ app, io }) {
    ioRef = io;

    // Estado actual
    app.get('/getCountdown', (_req, res) => res.json(sanitize(state)));

    // Control y configuración
    // body:
    // { action: 'start'|'pause'|'reset'|'add'|'set'|'startAt', seconds?:number }
    // { config: { secondsPerCoin, title, maxSeconds, enabled } }
    app.post('/setCountdown', (req, res) => {
      const b = req.body || {};

      // ---- Configuración ----
      if (b.config && typeof b.config === 'object') {
        const c = b.config;
        if (c.secondsPerCoin != null)
          state.secondsPerCoin = Math.max(0, parseFloat(c.secondsPerCoin) || 0);
        if (c.title != null)
          state.title = String(c.title).slice(0, 120);
        if (c.maxSeconds != null)
          state.maxSeconds = Math.max(0, parseInt(c.maxSeconds, 10) || 0);
        if (typeof c.enabled === 'boolean')
          state.enabled = c.enabled;
      }

      // ---- Acciones ----
      if (b.action) {
        switch (b.action) {
          case 'start':
            state.running = true;
            ensureTick();
            break;

          case 'pause':
            state.running = false;
            ensureTick();
            break;

          case 'reset':
            state.secondsLeft = 0;
            state.running = false;
            ensureTick();
            break;

          case 'add': {
            const s = Math.max(0, parseInt(b.seconds, 10) || 0);
            if (s > 0) addSeconds(s, 'manual');
            break;
          }

          // fija segundos exactos sin arrancar
          case 'set': {
            const s = Math.max(0, parseInt(b.seconds, 10) || 0);
            state.secondsLeft = clampToMax(s);
            break;
          }

          // fija segundos y arranca
          case 'startAt': {
            const s = Math.max(0, parseInt(b.seconds, 10) || 0);
            state.secondsLeft = clampToMax(s);
            state.running = true;
            ensureTick();
            break;
          }
        }
      }

      saveJSON(state);
      broadcast();
      res.json({ ok: true, state: sanitize(state) });
    });

    // Cuando un cliente se conecta, enviamos estado
    io.on('connection', () => broadcast());

    // Si estaba corriendo al guardar, reanuda
    ensureTick();
  },

  // Llama esto desde tu handler de regalos
  onGiftAddSeconds({ coins = 0, quantity = 1 } = {}) {
    if (!state.enabled) return;
    const totalCoins = Math.max(0, parseInt(coins, 10) || 0) * Math.max(1, parseInt(quantity, 10) || 1);
    const toAdd = Math.round(totalCoins * (state.secondsPerCoin || 0));
    if (toAdd > 0) addSeconds(toAdd, 'gift');
  },

  // (opcional) por si quieres usarlo desde otros módulos
  addSeconds
};
