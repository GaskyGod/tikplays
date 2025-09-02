// server/giftBattle.js
const fs = require('fs');
const path = require('path');

const FILE = path.join(process.cwd(), 'giftBattleState.json');

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const txt = fs.readFileSync(file, 'utf8').trim();
    if (!txt) return fallback;
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let io = null;

const DEFAULT = {
  titleLeft: 'Me reinicias',
  titleRight: 'Me salvas',
  pointsPerCoin: 1,        // cuántos puntos por cada coin (diamante)
  leadCountdown: 10,       // se lo mandamos al overlay (lo usa cliente)
  autoResetOnWin: false,   // si quieres autorreinicio cuando alguno gane
  left:  { points: 0, gifts: [] },  // gifts = IDs que suman a este lado
  right: { points: 0, gifts: [] },

  // 👇 NUEVO: preferencias de visualización (para overlay v2)
  display: {
    mode: 'grid',          // 'grid' | 'rotate'
    intervalMs: 1200       // intervalo del rotador (solo cuando mode='rotate')
  }
};

// merge con lo persistido sin romper defaults
let state = Object.assign({}, DEFAULT, readJSON(FILE, {}));
state.display = Object.assign({}, DEFAULT.display, state.display || {});

// normaliza el objeto display
function cleanDisplay(d = {}) {
  const mode = (d.mode === 'rotate') ? 'rotate' : 'grid';
  const intervalMs = Math.max(400, parseInt(d.intervalMs, 10) || 1200);
  return { mode, intervalMs };
}

// emite estado limpio (sin nada extra)
function broadcast() {
  if (!io) return;
  io.emit('giftBattle', {
    titleLeft: state.titleLeft,
    titleRight: state.titleRight,
    leadCountdown: state.leadCountdown,
    leftPoints: state.left.points,
    rightPoints: state.right.points,
    left: { points: state.left.points, gifts: state.left.gifts },
    right:{ points: state.right.points, gifts: state.right.gifts },
    display: state.display   // 👈 overlay v2 lo usa; v1 lo ignora
  });
  saveJSON(FILE, state);
}

function resetPoints() {
  state.left.points = 0;
  state.right.points = 0;
  broadcast();
}

function init({ app, io: _io }) {
  io = _io;

  // -- APIs para la app
  app.get('/getGiftBattle', (_req, res) => {
    res.json({
      titleLeft: state.titleLeft,
      titleRight: state.titleRight,
      pointsPerCoin: state.pointsPerCoin,
      leadCountdown: state.leadCountdown,
      autoResetOnWin: !!state.autoResetOnWin,
      left: { points: state.left.points, gifts: state.left.gifts },
      right:{ points: state.right.points, gifts: state.right.gifts },
      display: state.display // 👈 nuevo campo
    });
  });

  app.post('/setGiftBattle', (req, res) => {
    const b = req.body || {};

    // acciones simples
    if (b.action === 'reset') {
      resetPoints();
      return res.json({ ok: true, state });
    }

    // guardar configuración
    if (b.config && typeof b.config === 'object') {
      const c = b.config;

      if (typeof c.titleLeft === 'string')  state.titleLeft  = c.titleLeft.trim() || DEFAULT.titleLeft;
      if (typeof c.titleRight === 'string') state.titleRight = c.titleRight.trim() || DEFAULT.titleRight;

      if (Array.isArray(c.leftGifts))  state.left.gifts  = c.leftGifts.map(String);
      if (Array.isArray(c.rightGifts)) state.right.gifts = c.rightGifts.map(String);

      if (!isNaN(c.pointsPerCoin))  state.pointsPerCoin  = Math.max(0, parseFloat(c.pointsPerCoin) || 0);
      if (!isNaN(c.leadCountdown))  state.leadCountdown  = Math.max(3, parseInt(c.leadCountdown, 10) || 10);
      if (typeof c.autoResetOnWin === 'boolean') state.autoResetOnWin = c.autoResetOnWin;

      // 👇 NUEVO: preferencias de visualización
      if (c.display) {
        state.display = cleanDisplay(c.display);
      }

      saveJSON(FILE, state);
      broadcast(); // para que el overlay vea títulos/ajustes al dar “Guardar”
      return res.json({ ok: true, state });
    }

    res.status(400).json({ error: 'Bad request' });
  });
}

// sumar puntos cuando llega un gift
function onGift({ giftId, quantity = 1, coinsPerGift = 0 }) {
  giftId = String(giftId);
  const coins = Math.max(0, Number(coinsPerGift) || 0);
  const q = Math.max(1, Number(quantity) || 1);

  if (!state.left.gifts.length && !state.right.gifts.length) return; // sin configuración, no sumamos

  const add = coins * state.pointsPerCoin * q;

  let touched = false;
  if (state.left.gifts.includes(giftId)) {
    state.left.points += add;
    touched = true;
  }
  if (state.right.gifts.includes(giftId)) {
    state.right.points += add;
    touched = true;
  }
  if (!touched) return;

  // auto-reset opcional si alguno “gana”
  if (state.autoResetOnWin && (state.left.points !== state.right.points)) {
    // aquí podrías programar reset según tu regla
  }

  broadcast();
}

module.exports = { init, onGift, resetPoints, broadcast };
