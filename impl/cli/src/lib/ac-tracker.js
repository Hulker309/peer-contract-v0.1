// src/lib/ac-tracker.js
// In-memory AC (Acceptance Criteria) chain tracker.
// State persists in $XDG_STATE_HOME/peer-contract/ac-chain.json
// (or %APPDATA%/peer-contract/ on Windows, or ./.peer-contract-state/ as fallback).

const fs = require('fs');
const path = require('path');
const os = require('os');

function getStateDir() {
  if (process.env.PEER_CONTRACT_STATE_DIR) return process.env.PEER_CONTRACT_STATE_DIR;
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'peer-contract');
  }
  const xdg = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(xdg, 'peer-contract');
}

function getStateFile() {
  return path.join(getStateDir(), 'ac-chain.json');
}

function load() {
  const file = getStateFile();
  if (!fs.existsSync(file)) return { chains: {} };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return { chains: {}, _warning: `Could not parse ${file}: ${e.message}` };
  }
}

function save(state) {
  const dir = getStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getStateFile(), JSON.stringify(state, null, 2), 'utf-8');
}

function append(cardId, ownerSessionKey, status) {
  const state = load();
  if (!state.chains[cardId]) {
    state.chains[cardId] = {
      card_id: cardId,
      owner_session_key: ownerSessionKey,
      status: 'pending',
      history: [],
      created_at: new Date().toISOString(),
    };
  }
  const node = state.chains[cardId];
  // HR7: if status was accepted, accepted_by is immutable
  if (node.status === 'accepted' && node.owner_session_key !== ownerSessionKey) {
    return { ok: false, error: `HR7: cannot change owner after accept (current owner: ${node.owner_session_key})` };
  }
  // Status transitions: pending → accepted → in_progress → completed/rejected
  const validTransitions = {
    pending: ['accepted', 'rejected', 'cancelled'],
    accepted: ['in_progress', 'rejected', 'cancelled'],
    in_progress: ['completed', 'rejected', 'cancelled'],
    completed: [],
    rejected: [],
    cancelled: [],
  };
  if (node.status === status) {
    // no-op
    return { ok: true, card_id: cardId, status, no_change: true };
  }
  if (!validTransitions[node.status] || !validTransitions[node.status].includes(status)) {
    return { ok: false, error: `invalid transition ${node.status} → ${status}` };
  }
  const prev = { status: node.status, owner: node.owner_session_key, at: new Date().toISOString() };
  node.history.push(prev);
  node.status = status;
  if (!node.owner_session_key) node.owner_session_key = ownerSessionKey;
  save(state);
  return { ok: true, card_id: cardId, status, prev_status: prev.status };
}

function get(cardId) {
  const state = load();
  return state.chains[cardId] || null;
}

function list() {
  const state = load();
  return Object.values(state.chains);
}

module.exports = { load, save, append, get, list, getStateFile, getStateDir };
