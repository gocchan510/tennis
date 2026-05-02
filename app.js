'use strict';

const STORAGE_KEY = 'tennis_v1';
const MAX_COMBOS = 50;

// ── State ─────────────────────────────────────────
//
// players:      { [id]: { id, games, active, pairs: {[id]: n}, opponents: {[id]: n} } }
// combinations: [{ courts: [{court, team1:[id,id], team2:[id,id]}] }]

let state = { players: {}, nextId: 1, combinations: [], maxCourts: 1, sessionStarted: false };

// ── Persistence ───────────────────────────────────

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (_) {
    state = { players: {}, nextId: 1, combinations: [], maxCourts: 1, sessionStarted: false };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ── Player management ─────────────────────────────

function initPlayers(count, maxCourts) {
  state.players = {};
  state.nextId = 1;
  state.combinations = [];
  state.maxCourts = maxCourts;
  state.sessionStarted = true;
  for (let i = 0; i < count; i++) {
    const id = state.nextId++;
    state.players[id] = { id, games: 0, active: true, pairs: {}, opponents: {} };
  }
  regenerateCombinations();
  saveState();
  render();
}

function addPlayer() {
  const id = state.nextId++;
  state.players[id] = { id, games: 0, active: true, pairs: {}, opponents: {} };
  regenerateCombinations();
  saveState();
  render();
}

function toggleActive(id) {
  const p = state.players[id];
  if (!p) return;
  p.active = !p.active;
  regenerateCombinations();
  saveState();
  render();
}

function activePlayers() {
  return Object.values(state.players).filter(p => p.active);
}

// ── Combination generation ────────────────────────

// Priority pool: expand tiers (fewest games first) until we have enough players.
function buildPool(active, numCourts) {
  const needed = numCourts * 4;
  const sorted = [...active].sort((a, b) => a.games - b.games || a.id - b.id);
  if (sorted.length < needed) return [];

  const pool = [];
  let i = 0;
  while (pool.length < needed && i < sorted.length) {
    const tier = sorted[i].games;
    while (i < sorted.length && sorted[i].games === tier) pool.push(sorted[i++]);
  }
  return pool.sort((a, b) => a.id - b.id);
}

// Generator: choose k items from arr (yields arrays of objects).
function* choose(arr, k) {
  if (k === 0) { yield []; return; }
  if (arr.length < k) return;
  const [head, ...tail] = arr;
  for (const rest of choose(tail, k - 1)) yield [head, ...rest];
  yield* choose(tail, k);
}

// All 3 pairings for a group of 4 players.
function pairingOpts(group) {
  const [a, b, c, d] = group;
  return [
    { team1: [a.id, b.id], team2: [c.id, d.id] },
    { team1: [a.id, c.id], team2: [b.id, d.id] },
    { team1: [a.id, d.id], team2: [b.id, c.id] },
  ];
}

// Generator: all 1-court combinations from pool.
function* gen1Court(pool) {
  for (const group of choose(pool, 4)) {
    for (const { team1, team2 } of pairingOpts(group)) {
      yield { courts: [{ court: 1, team1, team2 }] };
    }
  }
}

// Generator: all 2-court combinations from pool.
// Fix: smallest-ID player always goes to court 1 to avoid duplicate splits.
function* gen2Courts(pool) {
  const [anchor, ...rest] = pool;
  for (const trio of choose(rest, 3)) {
    const court1 = [anchor, ...trio].sort((a, b) => a.id - b.id);
    const c1ids = new Set(court1.map(p => p.id));
    const remaining = pool.filter(p => !c1ids.has(p.id));
    for (const court2 of choose(remaining, 4)) {
      for (const p1 of pairingOpts(court1)) {
        for (const p2 of pairingOpts(court2)) {
          yield {
            courts: [
              { court: 1, team1: p1.team1, team2: p1.team2 },
              { court: 2, team1: p2.team1, team2: p2.team2 },
            ],
          };
        }
      }
    }
  }
}

function regenerateCombinations() {
  const active = activePlayers();
  const numCourts = Math.min(state.maxCourts ?? 1, Math.floor(active.length / 4));
  state.combinations = [];
  if (!numCourts) return;

  const pool = buildPool(active, numCourts);
  if (pool.length < numCourts * 4) return;

  const gen = numCourts === 1 ? gen1Court(pool) : gen2Courts(pool);
  for (const combo of gen) {
    state.combinations.push(combo);
    if (state.combinations.length >= MAX_COMBOS) break;
  }
}

// ── Record a combination ──────────────────────────

function recordCombination(idx) {
  const combo = state.combinations[idx];
  if (!combo) return;

  const inc = (a, b) => {
    a.pairs[b.id] = (a.pairs[b.id] ?? 0) + 1;
    b.pairs[a.id] = (b.pairs[a.id] ?? 0) + 1;
  };
  const incOpp = (a, b) => {
    a.opponents[b.id] = (a.opponents[b.id] ?? 0) + 1;
    b.opponents[a.id] = (b.opponents[a.id] ?? 0) + 1;
  };

  for (const match of combo.courts) {
    const [p1, p2] = match.team1.map(id => state.players[id]);
    const [p3, p4] = match.team2.map(id => state.players[id]);
    if (!p1 || !p2 || !p3 || !p4) continue;
    for (const p of [p1, p2, p3, p4]) p.games++;
    inc(p1, p2); inc(p3, p4);
    incOpp(p1, p3); incOpp(p1, p4);
    incOpp(p2, p3); incOpp(p2, p4);
  }

  regenerateCombinations();
  saveState();
  render();
}

// ── DOM helpers ───────────────────────────────────

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function makeChip(p) {
  const chip = el('div', `chip${p.active ? '' : ' inactive'}`);
  const id = el('span', 'chip-id');
  id.textContent = String(p.id);
  const games = el('span', 'chip-games');
  games.textContent = `${p.games}試合`;
  chip.append(id, games);
  chip.addEventListener('click', () => toggleActive(p.id));
  return chip;
}

function makeMatchRow(courtNum, team1, team2) {
  const row = el('div', 'combo-court-row');

  const label = el('span', 'combo-court-label');
  label.textContent = `${courtNum}面`;
  row.appendChild(label);

  const matchDiv = el('div', 'combo-match');

  const renderTeam = (ids) => {
    const team = el('div', 'team');
    ids.forEach((id, i) => {
      if (i > 0) {
        const amp = el('span', 'team-amp');
        amp.textContent = '＆';
        team.appendChild(amp);
      }
      const badge = el('div', 'player-badge sm');
      badge.textContent = String(id);
      team.appendChild(badge);
    });
    return team;
  };

  const vs = el('span', 'vs-label');
  vs.textContent = 'vs';

  matchDiv.append(renderTeam(team1), vs, renderTeam(team2));
  row.appendChild(matchDiv);
  return row;
}

// ── Render: combinations ──────────────────────────

function renderCourts() {
  const container = document.getElementById('courts');
  container.innerHTML = '';

  const active = activePlayers();

  if (active.length < 4) {
    const msg = el('div', 'no-match-msg');
    msg.textContent = '4人以上参加するとコートが表示されます';
    container.appendChild(msg);
    renderWaiting(new Set());
    return;
  }

  const allIds = state.combinations.length > 0
    ? new Set(state.combinations[0].courts.flatMap(m => [...m.team1, ...m.team2]))
    : new Set();

  state.combinations.forEach((combo, idx) => {
    const card = el('div', 'combo-card');
    const body = el('div', 'combo-body');

    const courts = el('div', 'combo-courts');
    for (const m of combo.courts) {
      courts.appendChild(makeMatchRow(m.court, m.team1, m.team2));
    }
    body.appendChild(courts);

    const btn = el('button', 'btn-record');
    btn.textContent = '終了';
    btn.addEventListener('click', () => recordCombination(idx));
    body.appendChild(btn);

    card.appendChild(body);
    container.appendChild(card);
  });

  renderWaiting(allIds);
}

function renderWaiting(inMatchIds) {
  const section = document.getElementById('waiting-section');
  const list = document.getElementById('waiting-list');
  const waiting = activePlayers().filter(p => !inMatchIds.has(p.id));

  if (waiting.length === 0) {
    section.classList.add('hidden');
    return;
  }

  list.innerHTML = '';
  waiting.forEach(p => {
    const chip = el('div', 'chip waiting-chip');
    const id = el('span', 'chip-id');
    id.textContent = String(p.id);
    const games = el('span', 'chip-games');
    games.textContent = `${p.games}試合`;
    chip.append(id, games);
    list.appendChild(chip);
  });
  section.classList.remove('hidden');
}

// ── Render: setup screen ─────────────────────────

function renderSetup() {
  const inSession = state.sessionStarted === true;
  document.getElementById('setup-screen').classList.toggle('hidden', inSession);
  document.getElementById('players-section').classList.toggle('hidden', !inSession);
}

// ── Render: players ───────────────────────────────

function renderPlayers() {
  const list = document.getElementById('players-list');
  const countEl = document.getElementById('player-count');
  const all = Object.values(state.players).sort((a, b) => a.id - b.id);

  list.innerHTML = '';
  if (all.length === 0) { countEl.textContent = ''; return; }

  all.forEach(p => list.appendChild(makeChip(p)));
  const activeCount = all.filter(p => p.active).length;
  countEl.textContent = `参加中 ${activeCount}人`;
}

// ── Render: stats ─────────────────────────────────

function formatHistory(map) {
  const entries = Object.entries(map)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (entries.length === 0) return '—';
  return entries.map(([id, c]) => `${id}番 (${c}回)`).join('　');
}

function renderStats() {
  const container = document.getElementById('stats-container');
  const noStats = document.getElementById('no-stats');
  const players = Object.values(state.players).sort((a, b) => a.id - b.id);

  if (players.length === 0) {
    container.innerHTML = '';
    noStats.classList.remove('hidden');
    return;
  }

  noStats.classList.add('hidden');
  container.innerHTML = '';

  players.forEach(p => {
    const card = el('div', 'stat-card');

    const header = el('div', 'stat-card-header');
    const badge = el('div', `stat-player-badge${p.active ? '' : ' inactive'}`);
    badge.textContent = String(p.id);
    const games = el('span', 'stat-games');
    games.textContent = `${p.games}試合`;
    header.append(badge, games);
    if (!p.active) {
      const label = el('span', 'stat-inactive-label');
      label.textContent = '退場中';
      header.appendChild(label);
    }
    card.appendChild(header);

    const rows = el('div', 'stat-rows');

    const pairRow = el('div', 'stat-row');
    const pairLabel = el('span', 'stat-row-label');
    pairLabel.textContent = 'ペア';
    const pairVal = el('span', 'stat-row-value');
    pairVal.textContent = formatHistory(p.pairs);
    pairRow.append(pairLabel, pairVal);

    const oppRow = el('div', 'stat-row');
    const oppLabel = el('span', 'stat-row-label');
    oppLabel.textContent = '対戦';
    const oppVal = el('span', 'stat-row-value');
    oppVal.textContent = formatHistory(p.opponents);
    oppRow.append(oppLabel, oppVal);

    rows.append(pairRow, oppRow);
    card.appendChild(rows);
    container.appendChild(card);
  });
}

// ── Full render ───────────────────────────────────

function render() {
  renderSetup();
  renderCourts();
  renderPlayers();
  renderStats();
}

// ── Navigation ────────────────────────────────────

function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.getElementById(`view-${view}`).classList.add('active');
      btn.classList.add('active');
    });
  });
}

// ── Init ──────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  state.sessionStarted = false;
  document.getElementById('btn-add').addEventListener('click', addPlayer);
  setupNav();

  const input = document.getElementById('setup-count');
  const btnStart = document.getElementById('btn-start');
  let selectedCourts = 1;

  document.querySelectorAll('.court-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.court-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedCourts = parseInt(btn.dataset.courts, 10);
    });
  });

  const validate = () => {
    const v = parseInt(input.value, 10);
    btnStart.disabled = !(v >= 1 && v <= 99);
  };
  input.addEventListener('input', validate);
  validate();

  btnStart.addEventListener('click', () => {
    const count = parseInt(input.value, 10);
    if (count >= 1 && count <= 99) {
      input.value = '';
      validate();
      initPlayers(count, selectedCourts);
    }
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !btnStart.disabled) btnStart.click();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  render();
});
