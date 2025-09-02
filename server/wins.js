// server/wins.js
const fs = require('fs');
const path = require('path');

const WINS_FILE = path.join(__dirname, '..', 'wins.json');

function safeReadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const txt = fs.readFileSync(file, 'utf8').trim();
    return txt ? JSON.parse(txt) : fallback;
  } catch { return fallback; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let ioRef = null;
let state = safeReadJSON(WINS_FILE, { wins: 0, title: 'WINS', accent: '#22c55e' });

function broadcast() {
  ioRef?.emit('wins', state);
}

function setWins(n) {
  const v = parseInt(n, 10);
  state.wins = Number.isFinite(v) ? v : 0;  // sin clamp
  saveJSON(WINS_FILE, state);
  broadcast();
}
function inc() { setWins((state.wins || 0) + 1); }
function dec() { setWins((state.wins || 0) - 1); }

function reset() { setWins(0); }

module.exports = {
  init({ app, io }) {
    ioRef = io;
    // GET estado
    app.get('/getWins', (_req, res) => res.json(state));
    // POST acciones/config
    app.post('/setWins', (req, res) => {
      const b = req.body || {};
      if (b.config && typeof b.config === 'object') {
        if (typeof b.config.title === 'string') state.title = b.config.title.slice(0, 60);
        if (typeof b.config.accent === 'string') state.accent = b.config.accent;
        saveJSON(WINS_FILE, state);
        broadcast();
        return res.json({ ok: true, state });
      }
      if (b.action === 'inc') { inc(); return res.json({ ok: true, state }); }
      if (b.action === 'dec') { dec(); return res.json({ ok: true, state }); }
      if (b.action === 'reset') { reset(); return res.json({ ok: true, state }); }
      if (b.action === 'set' && b.value != null) { setWins(b.value); return res.json({ ok: true, state }); }
      return res.status(400).json({ ok: false, error: 'bad_request' });
    });
  },
  getState: () => state,
  broadcast,
  inc, dec, reset, setWins
};
