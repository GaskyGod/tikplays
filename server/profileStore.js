// server/profileStore.js
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.TIKPLAYS_DATA_DIR || process.cwd(); // fallback
const ROOT = path.join(DATA_DIR, 'tikplays');                    // contenedor
const PROFILE_FILE = path.join(ROOT, 'profiles.json');

const DEFAULT_PROFILE_ID = 'default';

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJSON(file, fb) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; }
}
function writeJSON(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function init() {
  ensureDir(ROOT);
  let data = readJSON(PROFILE_FILE, null);
  if (!data) {
    // primer arranque
    data = {
      active: DEFAULT_PROFILE_ID,
      list: [{ id: DEFAULT_PROFILE_ID, name: 'Perfil principal' }]
    };
    writeJSON(PROFILE_FILE, data);
  }
  // carpeta del perfil por si no existe
  ensureDir(path.join(ROOT, 'profiles', data.active));
  return data;
}

let state = init();

function getActiveId() { return state.active; }
function getActiveDir() {
  const id = getActiveId();
  const dir = path.join(ROOT, 'profiles', id);
  ensureDir(dir);
  return dir;
}

// Ruta a archivo del perfil actual (o de un perfil concreto)
function resolvePath(filename, profileId = null) {
  const id = profileId || getActiveId();
  const dir = path.join(ROOT, 'profiles', id);
  ensureDir(dir);
  return path.join(dir, filename);
}

// Cambia perfil activo
function switchProfile(id) {
  const exists = (state.list || []).some(p => p.id === id);
  if (!exists) throw new Error('PROFILE_NOT_FOUND');
  state.active = id;
  writeJSON(PROFILE_FILE, state);
  ensureDir(path.join(ROOT, 'profiles', id));
  return state;
}

function createProfile(name) {
  const id = String(name || '').toLowerCase().replace(/[^a-z0-9\-]+/g, '-').replace(/^-+|-+$/g,'') || ('p-' + Date.now());
  if ((state.list||[]).some(p=>p.id===id)) throw new Error('PROFILE_ID_EXISTS');
  const entry = { id, name: name || id };
  state.list.push(entry);
  writeJSON(PROFILE_FILE, state);
  ensureDir(path.join(ROOT, 'profiles', id));
  return entry;
}

function renameProfile(id, newName) {
  const p = (state.list||[]).find(p=>p.id===id);
  if (!p) throw new Error('PROFILE_NOT_FOUND');
  p.name = newName || p.name;
  writeJSON(PROFILE_FILE, state);
  return p;
}

function deleteProfile(id) {
  if (id === DEFAULT_PROFILE_ID) throw new Error('CANT_DELETE_DEFAULT');
  const idx = (state.list||[]).findIndex(p=>p.id===id);
  if (idx === -1) throw new Error('PROFILE_NOT_FOUND');
  state.list.splice(idx,1);
  // si borramos el activo, volvemos al default
  if (state.active === id) state.active = DEFAULT_PROFILE_ID;
  writeJSON(PROFILE_FILE, state);
  // (opcional) no borrar datos físicos para evitar pérdidas accidentales
  return state;
}

function listProfiles() { return { active: state.active, list: state.list || [] }; }

// Export/Import de un perfil (ZIP simple opcional; aquí JSON plano)
function exportProfile(id) {
  const dir = path.join(ROOT, 'profiles', id);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const bundle = {};
  for (const f of files) {
    if (f.endsWith('.json')) {
      bundle[f] = readJSON(path.join(dir, f), {});
    }
  }
  return { id, meta: (state.list||[]).find(p=>p.id===id) || { id, name:id }, data: bundle };
}

function importProfile(payload) {
  const src = payload || {};
  const id = src.id || ('imp-' + Date.now());
  const name = src.meta?.name || id;
  if ((state.list||[]).some(p=>p.id===id)) throw new Error('PROFILE_ID_EXISTS');
  ensureDir(path.join(ROOT, 'profiles', id));
  for (const [fname, json] of Object.entries(src.data || {})) {
    writeJSON(path.join(ROOT, 'profiles', id, fname), json || {});
  }
  state.list.push({ id, name });
  writeJSON(PROFILE_FILE, state);
  return { id, name };
}

module.exports = {
  ROOT, PROFILE_FILE,
  getActiveId, getActiveDir, resolvePath,
  switchProfile, createProfile, renameProfile, deleteProfile, listProfiles,
  exportProfile, importProfile
};
