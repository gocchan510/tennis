'use strict';

const STORAGE_KEY = 'tennis_v1';

// ── State ─────────────────────────────────────────
//
// players: { [id]: { id, games, active, pairs: {[id]: n}, opponents: {[id]: n} } }
// matches: [{ court, team1: [id,id], team2: [id,id] }]

let state = { players: {}, nextId: 1, matches: [] };

// ── Persistence ───────────────────────────────────

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (_) {
    state = { players: {}, nextId: 1, matches: [] };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ── Player management ─────────────────────────────

function initPlayers(count) {
  for (let i = 0; i < count; i++) {
    const id = state.nextId++;
    state.players[id] = { id, games: 0, active: true, pairs: {}, opponents: {} };
  }
  regenerateMatches();
  saveState();
  render();
}

function addPlayer() {
  const id = state.nextId++;
  state.players[id] = { id, games: 0, active: true, pairs: {}, opponents: {} };
  regenerateMatches();
  saveState();
  render();
}

function toggleActive(id) {
  const p = state.players[id];
  if (!p) return;
  p.active = !p.active;
  regenerateMatches();
  saveState();
  render();
}

function activePlayers() {
  return Object.values(state.players).filter(p => p.active);
}

// ── Match generation ──────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pick n players, prioritising fewest games; random within same count.
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

// Score a pairing: lower = less repetitive. Pair penalty weighted higher.
function scorePairing(p1, p2, p3, p4) {
  const pair =
    (p1.pairs[p2.id] ?? 0) +
    (p3.pairs[p4.id] ?? 0);
  const opp =
    (p1.opponents[p3.id] ?? 0) + (p1.opponents[p4.id] ?? 0) +
    (p2.opponents[p3.id] ?? 0) + (p2.opponents[p4.id] ?? 0);
  return pair * 3 + opp;
}

// Find the best split of 4 players into two teams of two.
function bestPairing(group) {
  const [a, b, c, d] = group;
  const opts = [
    { t1: [a, b], t2: [c, d], s: scorePairing(a, b, c, d) },
    { t1: [a, c], t2: [b, d], s: scorePairing(a, c, b, d) },
    { t1: [a, d], t2: [b, c], s: scorePairing(a, d, b, c) },
  ];
  opts.sort((x, y) => x.s - y.s);
  const best = opts.filter(o => o.s === opts[0].s);
  const pick = best[Math.floor(Math.random() * best.length)];
  return {
    team1: pick.t1.map(p => p.id),
    team2: pick.t2.map(p => p.id),
  };
}

function regenerateMatches() {
  const active = activePlayers();
  const numCourts = active.length >= 8 ? 2 : active.length >= 4 ? 1 : 0;
  state.matches = [];
  if (!numCourts) return;
  const selected = pickByPriority(active, numCourts * 4);
  for (let c = 0; c < numCourts; c++) {
    const group = selected.slice(c * 4, c * 4 + 4);
    state.matches.push({ court: c + 1, ...bestPairing(group) });
  }
}

// ── Record a match ────────────────────────────────

function recordMatch(courtIndex) {
  const match = state.matches[courtIndex];
  if (!match) return;

  const ids = [...match.team1, ...match.team2];
  const [p1, p2, p3, p4] = ids.map(id => state.players[id]);
  if (!p1 || !p2 || !p3 || !p4) return;

  for (const p of [p1, p2, p3, p4]) p.games++;

  const inc = (a, b) => {
    a.pairs[b.id] = (a.pairs[b.id] ?? 0) + 1;
    b.pairs[a.id] = (b.pairs[a.id] ?? 0) + 1;
  };
  inc(p1, p2);
  inc(p3, p4);

  const incOpp = (a, b) => {
    a.opponents[b.id] = (a.opponents[b.id] ?? 0) + 1;
    b.opponents[a.id] = (b.opponents[a.id] ?? 0) + 1;
  };
  incOpp(p1, p3); incOpp(p1, p4);
  incOpp(p2, p3); incOpp(p2, p4);

  regenerateMatches();
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

// ── Render: courts ────────────────────────────────

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

  const inMatchIds = new Set(state.matches.flatMap(m => [...m.team1, ...m.team2]));

  state.matches.forEach((match, idx) => {
    const card = el('div', 'court-card');

    const header = el('div', 'court-header');
    header.textContent = `${match.court}面`;
    card.appendChild(header);

    const body = el('div', 'court-body');

    // Match display
    const matchDiv = el('div', 'match-display');

    const renderTeam = (ids) => {
      const team = el('div', 'team');
      ids.forEach((id, i) => {
        if (i > 0) {
          const amp = el('span', 'team-amp');
          amp.textContent = '＆';
          team.appendChild(amp);
        }
        const badge = el('div', 'player-badge');
        badge.textContent = String(id);
        team.appendChild(badge);
      });
      return team;
    };

    const vsLabel = el('div', 'vs-label');
    vsLabel.textContent = 'vs';

    matchDiv.append(renderTeam(match.team1), vsLabel, renderTeam(match.team2));
    body.appendChild(matchDiv);

    const btn = el('button', 'btn-record');
    btn.textContent = '記録する';
    btn.addEventListener('click', () => recordMatch(idx));
    body.appendChild(btn);

    card.appendChild(body);
    container.appendChild(card);
  });

  renderWaiting(inMatchIds);
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
  const hasPlayers = Object.keys(state.players).length > 0;
  document.getElementById('setup-screen').classList.toggle('hidden', hasPlayers);
  document.getElementById('players-section').classList.toggle('hidden', !hasPlayers);
}

// ── Render: players ───────────────────────────────

function renderPlayers() {
  const list = document.getElementById('players-list');
  const countEl = document.getElementById('player-count');

  const all = Object.values(state.players).sort((a, b) => a.id - b.id);

  if (all.length === 0) {
    list.innerHTML = '';
    countEl.textContent = '';
    return;
  }

  list.innerHTML = '';
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

    // Header row
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

    // History rows
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
  document.getElementById('btn-add').addEventListener('click', addPlayer);
  setupNav();

  const input = document.getElementById('setup-count');
  const btnStart = document.getElementById('btn-start');

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
      initPlayers(count);
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
