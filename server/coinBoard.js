// server/coinBoard.js
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'coinBoard.json');

function read() {
  try { 
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // sanea defaults por si el archivo viene viejo/incompleto
    return {
      users: j.users || {},
      topN: Math.max(1, parseInt(j.topN, 10) || 10),
      title: typeof j.title === 'string' ? j.title : 'Top Monedas',
      unit: typeof j.unit === 'string' && j.unit.trim() ? j.unit : '💎',
       coinIconUrl: typeof j.coinIconUrl === 'string' ? j.coinIconUrl : '',
      resetOnDisconnect: !!j.resetOnDisconnect
    };
  } catch {
     return { users: {}, topN: 10, title: 'Top Monedas', unit: '💎', coinIconUrl: '', resetOnDisconnect: false };
  }
}
function save(state) { fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); }

let io = null;
let app = null;
let state = read(); // { users: {uniqueId:{id,name,avatar,coins}}, topN, title, unit, resetOnDisconnect }

function broadcast() {
  if (!io) return;
  const rows = Object.values(state.users)
    .sort((a, b) => b.coins - a.coins)
    .slice(0, state.topN);
  io.emit('coinBoard', { title: state.title, unit: state.unit, coinIconUrl: state.coinIconUrl, rows });
}

module.exports = {
  init({ app: _app, io: _io }) {
    app = _app; io = _io;

    // REST: leer configuraciones / estado completo (útil para pantallas de config)
    app.get('/getCoinBoard', (_req, res) => res.json(state));

    // REST: setear config / reset
    app.post('/setCoinBoard', (req, res) => {
      const b = req.body || {};
      if (b.action === 'reset') {
        state.users = {};
        save(state); broadcast();
        return res.json({ ok: true });
      }
      if (b.config) {
        const c = b.config;
        if (c.topN != null) state.topN = Math.max(1, parseInt(c.topN, 10) || 10);
        if (typeof c.title === 'string') state.title = c.title.trim() || 'Top Monedas';
        if (typeof c.unit === 'string') state.unit = (c.unit.trim() || '💎'); // 🪙, 💎, etc.
         if (typeof c.coinIconUrl === 'string') state.coinIconUrl = c.coinIconUrl.trim();
        if (typeof c.resetOnDisconnect === 'boolean') state.resetOnDisconnect = c.resetOnDisconnect;
        save(state); broadcast();
        return res.json({ ok: true, state });
      }
      res.json({ ok: true });
    });

    // cuando un cliente se conecta, mándale el estado actual
    io.on('connection', () => broadcast());
  },

  /**
   * Llamar desde handleGift:
   * coinBoard.onGift({ uniqueId, displayName, avatar, coinsPerGift, quantity })
   */
  onGift({ uniqueId, displayName, avatar, coinsPerGift = 0, quantity = 1 }) {
    if (!uniqueId) return;
    const inc = Math.max(0, Number(coinsPerGift) || 0) * Math.max(1, Number(quantity) || 1);
    if (!inc) return;

    const u = state.users[uniqueId] || { id: uniqueId, name: displayName || uniqueId, avatar: '', coins: 0 };
    // actualiza nombre y avatar si llegan (para que no se queden vacíos)
    if (displayName && displayName !== u.name) u.name = displayName;
    if (avatar && avatar !== u.avatar) u.avatar = avatar;

    u.coins += inc;
    state.users[uniqueId] = u;

    save(state);
    broadcast();
  },

  // Llamar opcionalmente al desconectar el Live
  onDisconnect() {
    if (state.resetOnDisconnect) {
      state.users = {};
      save(state);
      broadcast();
    }
  },

  // Exponer para debug
  getState() { return state; },
  broadcast
};
