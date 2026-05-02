'use strict';

const STORAGE_KEY = 'tennis_v1';

// ── State ─────────────────────────────────────────
//
// players:      { [id]: { id, games, active, pairs: {[id]: n}, opponents: {[id]: n} } }
// combinations: [{ courts: [{court, team1:[id,id], team2:[id,id]}], score }]

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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickByPriority(players, n) {
  const byGames = {};
  for (const p of players) {
    (byGames[p.games] ??= []).push(p);
  }
  const result = [];
  for (const g of Object.keys(byGames).map(Number).sort((a, b) => a - b)) {
    for (const p of shuffle(byGames[g])) {
      result.push(p);
      if (result.length >= n) return result;
    }
  }
  return result;
}

function scorePairing(p1, p2, p3, p4) {
  const pair =
    (p1.pairs[p2.id] ?? 0) +
    (p3.pairs[p4.id] ?? 0);
  const opp =
    (p1.opponents[p3.id] ?? 0) + (p1.opponents[p4.id] ?? 0) +
    (p2.opponents[p3.id] ?? 0) + (p2.opponents[p4.id] ?? 0);
  return pair * 3 + opp;
}

// Returns all 3 pairings for a group of 4 players, with scores.
function allPairings(group) {
  const [a, b, c, d] = group;
  return [
    { team1: [a.id, b.id], team2: [c.id, d.id], score: scorePairing(a, b, c, d) },
    { team1: [a.id, c.id], team2: [b.id, d.id], score: scorePairing(a, c, b, d) },
    { team1: [a.id, d.id], team2: [b.id, c.id], score: scorePairing(a, d, b, c) },
  ];
}

function regenerateCombinations() {
  const active = activePlayers();
  const max = state.maxCourts ?? 1;
  const numCourts = Math.min(Math.floor(active.length / 4), max);
  state.combinations = [];
  if (!numCourts) return;

  const selected = pickByPriority(active, numCourts * 4)
    .sort((a, b) => a.id - b.id);

  // All pairings per court slot
  const courtOptions = [];
  for (let c = 0; c < numCourts; c++) {
    const group = selected.slice(c * 4, c * 4 + 4);
    courtOptions.push(
      allPairings(group).map(p => ({ court: c + 1, team1: p.team1, team2: p.team2, score: p.score }))
    );
  }

  // Cross product across courts
  const combos = [];
  const build = (idx, current) => {
    if (idx === courtOptions.length) {
      const score = current.reduce((s, c) => s + c.score, 0);
      combos.push({
        courts: current.map(({ score: _s, ...rest }) => rest),
        score,
      });
      return;
    }
    for (const opt of courtOptions[idx]) build(idx + 1, [...current, opt]);
  };
  build(0, []);

  state.combinations = combos;
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
    inc(p1, p2);
    inc(p3, p4);
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

    const header = el('div', 'combo-header');
    header.textContent = `パターン ${idx + 1}`;
    card.appendChild(header);

    const body = el('div', 'combo-body');

    for (const m of combo.courts) {
      body.appendChild(makeMatchRow(m.court, m.team1, m.team2));
    }

    const btn = el('button', 'btn-record');
    btn.textContent = '記録する';
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
