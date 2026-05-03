'use strict';

const STORAGE_KEY = 'tennis_v1';
const HISTORY_KEY = 'tennis_history_v1';
const MAX_HISTORY = 3;
const MAX_COMBOS = 50;
const APP_VERSION = '2026/5/3 10:00';
const VERSION_NOTES = '直近3セッションの履歴保存・復元機能';

// ── State ─────────────────────────────────────────
//
// players:      { [id]: { id, games, active, pairs: {[id]: n}, opponents: {[id]: n} } }
// combinations: [{ courts: [{court, team1:[id,id], team2:[id,id]}] }]
// markerPos:    number of combinations already played (0 = nothing yet)

const FRESH_STATE = () => ({
  players: {}, nextId: 1, combinations: [], maxCourts: 1,
  sessionStarted: false, markerPos: 0,
});

let state = FRESH_STATE();

// ── Persistence ───────────────────────────────────

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = { ...FRESH_STATE(), ...JSON.parse(raw) };
  } catch (_) {
    state = FRESH_STATE();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (_) { return []; }
}

function pushHistory() {
  if (!state.sessionStarted || state.markerPos === 0) return;
  const entry = {
    savedAt: new Date().toISOString(),
    maxCourts: state.maxCourts,
    playerCount: Object.keys(state.players).length,
    markerPos: state.markerPos,
    snapshot: JSON.stringify(state),
  };
  const hist = loadHistory();
  hist.unshift(entry);
  if (hist.length > MAX_HISTORY) hist.length = MAX_HISTORY;
  localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
}

// ── Player management ─────────────────────────────

function initPlayers(count, maxCourts) {
  pushHistory();
  state = FRESH_STATE();
  state.maxCourts = maxCourts;
  state.sessionStarted = true;
  for (let i = 0; i < count; i++) {
    const id = state.nextId++;
    state.players[id] = { id, games: 0, actualGames: 0, active: true, pairs: {}, opponents: {} };
  }
  regenerateCombinations();
  saveState();
  render();
}

// Current minimum priority counter (`games`) across active players.
// Used to level new joiners and returning players so they don't catch up.
function currentMinGames() {
  const others = activePlayers();
  return others.length > 0 ? Math.min(...others.map(p => p.games)) : 0;
}

function addPlayer() {
  const id = state.nextId++;
  const minGames = currentMinGames();
  state.players[id] = { id, games: minGames, actualGames: 0, active: true, pairs: {}, opponents: {} };
  regenerateCombinations();
  saveState();
  render();
}

function toggleActive(id) {
  const p = state.players[id];
  if (!p) return;
  if (!p.active) {
    // Returning: level priority counter to current min (no catch-up advantage).
    p.games = currentMinGames();
  }
  p.active = !p.active;
  regenerateCombinations();
  saveState();
  render();
}

function activePlayers() {
  return Object.values(state.players).filter(p => p.active);
}

// ── Combination generation ────────────────────────

function pairKey(a, b) {
  return Math.min(a, b) + '-' + Math.max(a, b);
}

function pairingOpts(group) {
  const [a, b, c, d] = group;
  return [
    { team1: [a.id, b.id], team2: [c.id, d.id] },
    { team1: [a.id, c.id], team2: [b.id, d.id] },
    { team1: [a.id, d.id], team2: [b.id, c.id] },
  ];
}

// All C(arr, k) combinations as arrays.
function combinations(arr, k) {
  const out = [];
  const recurse = (start, cur) => {
    if (cur.length === k) { out.push([...cur]); return; }
    for (let i = start; i <= arr.length - (k - cur.length); i++) {
      cur.push(arr[i]);
      recurse(i + 1, cur);
      cur.pop();
    }
  };
  recurse(0, []);
  return out;
}

function nCk(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

// Random sample of `count` distinct k-subsets of arr (no enumeration).
function sampleCombinations(arr, k, count) {
  const out = [];
  const seen = new Set();
  const n = arr.length;
  let attempts = 0;
  while (out.length < count && attempts < count * 6) {
    attempts++;
    const idx = new Set();
    while (idx.size < k) idx.add(Math.floor(Math.random() * n));
    const sorted = [...idx].sort((a, b) => a - b);
    const key = sorted.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sorted.map(i => arr[i]));
  }
  return out;
}

// Cap on subset enumeration. Above this we randomly sample to stay fast.
const MAX_SUBSET_SAMPLES = 200;

function fillerSubsetsFor(filler, fillerNeeded) {
  if (fillerNeeded === 0) return [[]];
  return nCk(filler.length, fillerNeeded) <= MAX_SUBSET_SAMPLES
    ? combinations(filler, fillerNeeded)
    : sampleCombinations(filler, fillerNeeded, MAX_SUBSET_SAMPLES);
}

// Sum-of-squares of court-mate counts for all pairs within a court group.
function courtMateScore(group, vcm) {
  let s = 0;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const c = vcm.get(pairKey(group[i].id, group[j].id)) || 0;
      s += c * c;
    }
  }
  return s;
}

// Pick pairing minimizing both pair (teammate) and opponent counts.
// Within a fixed 4-player group, choosing a pairing fixes 2 new pair-pairs
// and 4 new opponent-pairs. We minimize the sum across both.
// `deterministic` picks the first tied option (smallest IDs first) instead
// of random — used for the very first combo of a fresh session.
function pickFairPairing(group, vpairs, vopps, deterministic) {
  const opts = pairingOpts(group);
  let tied = [];
  let bestScore = Infinity;
  for (const opt of opts) {
    const [a, b] = opt.team1;
    const [c, d] = opt.team2;
    const pp = (vpairs.get(pairKey(a, b)) || 0) + (vpairs.get(pairKey(c, d)) || 0);
    const oo = (vopps.get(pairKey(a, c)) || 0) + (vopps.get(pairKey(a, d)) || 0) +
               (vopps.get(pairKey(b, c)) || 0) + (vopps.get(pairKey(b, d)) || 0);
    const score = pp + oo;
    if (score < bestScore) { bestScore = score; tied = [opt]; }
    else if (score === bestScore) { tied.push(opt); }
  }
  return deterministic ? tied[0] : tied[Math.floor(Math.random() * tied.length)];
}

// Required (must-play) and filler tier from virtual game counts.
function computeRF(active, vg, needed) {
  const sorted = [...active].sort((a, b) =>
    (vg.get(a.id) - vg.get(b.id)) || (a.id - b.id)
  );
  if (sorted.length < needed) return null;

  const required = [];
  let i = 0;
  while (i < sorted.length) {
    const tier = vg.get(sorted[i].id);
    const members = [];
    while (i < sorted.length && vg.get(sorted[i].id) === tier) members.push(sorted[i++]);

    if (required.length + members.length <= needed) {
      required.push(...members);
      if (required.length === needed) return { required, filler: [], fillerNeeded: 0 };
    } else {
      return { required, filler: members, fillerNeeded: needed - required.length };
    }
  }
  return null;
}

// Pick the next combo for 1 court: best filler subset by court-mate score.
function nextCombo1Court(rf, vcm, vpairs, vopps) {
  const fillerSubsets = fillerSubsetsFor(rf.filler, rf.fillerNeeded);
  let tied = [];
  let bestScore = Infinity;
  for (const sub of fillerSubsets) {
    const pool = [...rf.required, ...sub].sort((a, b) => a.id - b.id);
    const score = courtMateScore(pool, vcm);
    if (score < bestScore) { bestScore = score; tied = [pool]; }
    else if (score === bestScore) { tied.push(pool); }
  }
  if (tied.length === 0) return null;

  const best = tied[Math.floor(Math.random() * tied.length)];
  const p = pickFairPairing(best, vpairs, vopps, false);
  return { courts: [{ court: 1, team1: p.team1, team2: p.team2 }] };
}

// Pick the next combo for 2 courts: best (filler × split) by total court-mate score.
function nextCombo2Courts(rf, vcm, vpairs, vopps) {
  const fillerSubsets = fillerSubsetsFor(rf.filler, rf.fillerNeeded);

  let tiedSplits = [];
  let bestScore = Infinity;

  for (const sub of fillerSubsets) {
    const pool = [...rf.required, ...sub].sort((a, b) => a.id - b.id);
    const [anchor, ...rest] = pool;
    for (const trio of combinations(rest, 3)) {
      const c1 = [anchor, ...trio].sort((a, b) => a.id - b.id);
      const c1ids = new Set(c1.map(p => p.id));
      const c2 = pool.filter(p => !c1ids.has(p.id)).sort((a, b) => a.id - b.id);
      const score = courtMateScore(c1, vcm) + courtMateScore(c2, vcm);
      if (score < bestScore) { bestScore = score; tiedSplits = [{ c1, c2 }]; }
      else if (score === bestScore) { tiedSplits.push({ c1, c2 }); }
    }
  }
  if (tiedSplits.length === 0) return null;

  const bestSplit = tiedSplits[Math.floor(Math.random() * tiedSplits.length)];

  const p1 = pickFairPairing(bestSplit.c1, vpairs, vopps, false);
  const p2 = pickFairPairing(bestSplit.c2, vpairs, vopps, false);
  return {
    courts: [
      { court: 1, team1: p1.team1, team2: p1.team2 },
      { court: 2, team1: p2.team1, team2: p2.team2 },
    ],
  };
}

// Sequential opener: while enough 0-vg players exist, assign them in ID order
// (court1: ids[0..3], court2: ids[4..7]). Returns null when the sequential
// phase is over and the caller should switch to fair scheduling.
function sequentialCombo(active, vg, numCourts, vpairs, vopps) {
  const needed = numCourts * 4;
  const unplayed = [...active]
    .filter(p => vg.get(p.id) <= 0)
    .sort((a, b) => a.id - b.id);
  if (unplayed.length < needed) return null;

  const batch = unplayed.slice(0, needed);
  if (numCourts === 1) {
    const p = pickFairPairing(batch, vpairs, vopps, true);
    return { courts: [{ court: 1, team1: p.team1, team2: p.team2 }] };
  }
  const p1 = pickFairPairing(batch.slice(0, 4), vpairs, vopps, true);
  const p2 = pickFairPairing(batch.slice(4, 8), vpairs, vopps, true);
  return {
    courts: [
      { court: 1, team1: p1.team1, team2: p1.team2 },
      { court: 2, team1: p2.team1, team2: p2.team2 },
    ],
  };
}

// Append `count` new combinations to state.combinations, simulated from
// the current real player history (which already includes done rows).
function appendCombinations(count) {
  const active = activePlayers();
  const maxCourts = state.maxCourts ?? 1;
  const minPlayers = maxCourts * 4;
  if (active.length < minPlayers) return;
  const numCourts = maxCourts;
  const needed = numCourts * 4;

  const vg = new Map();
  for (const p of active) vg.set(p.id, p.games);

  const vpairs = new Map();
  const vopps = new Map();
  const vcm = new Map();
  for (const p of active) {
    for (const [otherIdStr, c] of Object.entries(p.pairs || {})) {
      const o = +otherIdStr;
      if (p.id < o) {
        const k = pairKey(p.id, o);
        vpairs.set(k, c);
        vcm.set(k, (vcm.get(k) || 0) + c);
      }
    }
    for (const [otherIdStr, c] of Object.entries(p.opponents || {})) {
      const o = +otherIdStr;
      if (p.id < o) {
        const k = pairKey(p.id, o);
        vopps.set(k, c);
        vcm.set(k, (vcm.get(k) || 0) + c);
      }
    }
  }

  let satOutLastRound = new Set();

  for (let i = 0; i < count; i++) {
    // Boost players who sat out last round: vg-1 so they rank below everyone else
    for (const id of satOutLastRound) vg.set(id, vg.get(id) - 1);

    // Sequential phase: assign unplayed (vg<=0) players in ID order until exhausted
    const seqCombo = sequentialCombo(active, vg, numCourts, vpairs, vopps);
    let combo;
    if (seqCombo) {
      combo = seqCombo;
    } else {
      const rf = computeRF(active, vg, needed);
      if (!rf) { for (const id of satOutLastRound) vg.set(id, vg.get(id) + 1); break; }
      combo = numCourts === 1
        ? nextCombo1Court(rf, vcm, vpairs, vopps)
        : nextCombo2Courts(rf, vcm, vpairs, vopps);
      if (!combo) { for (const id of satOutLastRound) vg.set(id, vg.get(id) + 1); break; }
    }

    // Undo boost before recording vg increments
    for (const id of satOutLastRound) vg.set(id, vg.get(id) + 1);

    state.combinations.push(combo);

    const playedIds = new Set();
    for (const court of combo.courts) {
      const ids = [...court.team1, ...court.team2];
      for (const id of ids) { vg.set(id, vg.get(id) + 1); playedIds.add(id); }
      for (let a = 0; a < ids.length; a++) {
        for (let b = a + 1; b < ids.length; b++) {
          const k = pairKey(ids[a], ids[b]);
          vcm.set(k, (vcm.get(k) || 0) + 1);
        }
      }
      const k1 = pairKey(court.team1[0], court.team1[1]);
      const k2 = pairKey(court.team2[0], court.team2[1]);
      vpairs.set(k1, (vpairs.get(k1) || 0) + 1);
      vpairs.set(k2, (vpairs.get(k2) || 0) + 1);
      for (const a of court.team1) {
        for (const b of court.team2) {
          const k = pairKey(a, b);
          vopps.set(k, (vopps.get(k) || 0) + 1);
        }
      }
    }

    satOutLastRound = new Set(active.filter(p => !playedIds.has(p.id)).map(p => p.id));
  }
}

// Keep done rows (above marker) intact, regenerate everything below to
// always have ~MAX_COMBOS rows ahead of the marker.
function regenerateCombinations() {
  if (state.markerPos > state.combinations.length) {
    state.markerPos = state.combinations.length;
  }
  state.combinations = state.combinations.slice(0, state.markerPos);
  const need = (state.markerPos + MAX_COMBOS) - state.combinations.length;
  if (need > 0) appendCombinations(need);
}

// ── Apply / revert recorded combinations ──────────

function applyCombination(combo) {
  const adj = (a, b, key, d) => {
    if (!a || !b) return;
    a[key][b.id] = Math.max(0, (a[key][b.id] ?? 0) + d);
    b[key][a.id] = Math.max(0, (b[key][a.id] ?? 0) + d);
  };
  for (const match of combo.courts) {
    const [p1, p2] = match.team1.map(id => state.players[id]);
    const [p3, p4] = match.team2.map(id => state.players[id]);
    if (!p1 || !p2 || !p3 || !p4) continue;
    for (const p of [p1, p2, p3, p4]) {
      p.games++;
      p.actualGames = (p.actualGames ?? 0) + 1;
    }
    adj(p1, p2, 'pairs', 1); adj(p3, p4, 'pairs', 1);
    adj(p1, p3, 'opponents', 1); adj(p1, p4, 'opponents', 1);
    adj(p2, p3, 'opponents', 1); adj(p2, p4, 'opponents', 1);
  }
}

function revertCombination(combo) {
  const adj = (a, b, key) => {
    if (!a || !b) return;
    a[key][b.id] = Math.max(0, (a[key][b.id] ?? 0) - 1);
    b[key][a.id] = Math.max(0, (b[key][a.id] ?? 0) - 1);
  };
  for (const match of combo.courts) {
    const [p1, p2] = match.team1.map(id => state.players[id]);
    const [p3, p4] = match.team2.map(id => state.players[id]);
    if (!p1 || !p2 || !p3 || !p4) continue;
    for (const p of [p1, p2, p3, p4]) {
      p.games = Math.max(0, p.games - 1);
      p.actualGames = Math.max(0, (p.actualGames ?? 0) - 1);
    }
    adj(p1, p2, 'pairs'); adj(p3, p4, 'pairs');
    adj(p1, p3, 'opponents'); adj(p1, p4, 'opponents');
    adj(p2, p3, 'opponents'); adj(p2, p4, 'opponents');
  }
}

function moveMarkerTo(targetIdx) {
  if (targetIdx < 0 || targetIdx >= state.combinations.length) return;
  if (targetIdx === state.markerPos) return;
  const oldPos = state.markerPos;
  state.markerPos = targetIdx;
  commitMarkerChange(oldPos, targetIdx);
}

function commitMarkerChange(oldPos, newPos) {
  if (newPos > oldPos) {
    for (let i = oldPos; i < newPos; i++) applyCombination(state.combinations[i]);
  } else if (newPos < oldPos) {
    for (let i = oldPos - 1; i >= newPos; i--) revertCombination(state.combinations[i]);
  }
  // Keep ~MAX_COMBOS rows ahead of marker; extend if running low.
  const need = (state.markerPos + MAX_COMBOS) - state.combinations.length;
  if (need > 0) appendCombinations(need);
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
  games.textContent = `${p.actualGames ?? p.games}試合`;
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

  if (!state.sessionStarted) return;

  const active = activePlayers();

  const minPlayers = (state.maxCourts ?? 1) === 2 ? 8 : 4;
  if (active.length < minPlayers) {
    const msg = el('div', 'no-match-msg');
    msg.textContent = `${minPlayers}人以上参加するとコートが表示されます`;
    container.appendChild(msg);
    return;
  }

  state.combinations.forEach((combo, idx) => {
    const card = el('div', 'combo-card');
    if (idx < state.markerPos) card.classList.add('done');

    card.addEventListener('click', () => moveMarkerTo(idx));

    const body = el('div', 'combo-body');
    const courts = el('div', 'combo-courts');
    for (const m of combo.courts) {
      courts.appendChild(makeMatchRow(m.court, m.team1, m.team2));
    }
    body.appendChild(courts);
    card.appendChild(body);
    container.appendChild(card);
  });

  // Progress marker (→ handle on the left gutter, draggable).
  const marker = el('div', 'combo-marker');
  marker.id = 'combo-marker';
  const handle = el('div', 'marker-handle');
  handle.textContent = '→';
  marker.appendChild(handle);
  container.appendChild(marker);
  setupMarkerDrag(marker, handle);
  requestAnimationFrame(() => updateMarkerPosition());
}

// ── Progress marker ──────────────────────────────

function getCardRects() {
  return [...document.querySelectorAll('#courts .combo-card')]
    .map(c => c.getBoundingClientRect());
}

// markerPos = N means rows 0..N-1 are done and row N is "current".
// Visually the marker sits at the vertical center of row N.
function calcMarkerPosFromY(y) {
  const rects = getCardRects();
  for (let i = 0; i < rects.length; i++) {
    if (y < rects[i].bottom) return i;
  }
  return Math.max(0, rects.length - 1);
}

function updateMarkerPosition() {
  const marker = document.getElementById('combo-marker');
  if (!marker) return;
  const courts = document.getElementById('courts');
  const rects = getCardRects();
  if (rects.length === 0) { marker.style.display = 'none'; return; }
  marker.style.display = '';

  const courtsRect = courts.getBoundingClientRect();
  const pos = Math.min(state.markerPos, rects.length - 1);
  const r = rects[pos];
  const y = (r.top + r.height / 2) - courtsRect.top;
  marker.style.top = y + 'px';
}

function updateDoneClasses() {
  document.querySelectorAll('#courts .combo-card').forEach((c, i) => {
    c.classList.toggle('done', i < state.markerPos);
  });
}

function setupMarkerDrag(marker, handle) {
  let active = false;
  let startPos = 0;

  handle.addEventListener('pointerdown', e => {
    if (state.combinations.length === 0) return;
    active = true;
    startPos = state.markerPos;
    handle.setPointerCapture(e.pointerId);
    marker.classList.add('dragging');
    e.preventDefault();
  });

  handle.addEventListener('pointermove', e => {
    if (!active) return;
    const newPos = calcMarkerPosFromY(e.clientY);
    if (newPos !== state.markerPos) {
      state.markerPos = newPos;
      updateDoneClasses();
      updateMarkerPosition();
    }
  });

  const finish = (e) => {
    if (!active) return;
    active = false;
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    marker.classList.remove('dragging');
    if (state.markerPos !== startPos) {
      commitMarkerChange(startPos, state.markerPos);
    }
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}

// ── Render: setup screen ─────────────────────────

function renderHistory() {
  const container = document.getElementById('session-history');
  container.innerHTML = '';
  const hist = loadHistory();
  if (hist.length === 0) return;

  const label = el('div', 'history-label');
  label.textContent = '直近のセッション';
  container.appendChild(label);

  hist.forEach((entry, idx) => {
    const d = new Date(entry.savedAt);
    const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const card = el('button', 'history-card');
    card.type = 'button';

    const left = el('div', 'history-info');
    const dateEl = el('span', 'history-date');
    dateEl.textContent = dateStr;
    const meta = el('span', 'history-meta');
    meta.textContent = `${entry.playerCount}人・${entry.maxCourts}面・${entry.markerPos}試合`;
    left.append(dateEl, meta);

    const restore = el('span', 'history-restore');
    restore.textContent = '復元';
    card.append(left, restore);

    card.addEventListener('click', () => {
      if (!confirm(`${dateStr} のセッションを復元しますか？\n現在のセッションは保存されます。`)) return;
      pushHistory();
      try {
        state = { ...FRESH_STATE(), ...JSON.parse(entry.snapshot) };
        // Remove this entry from history so it's not duplicated
        const h = loadHistory();
        h.splice(idx, 1);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
        saveState();
        render();
      } catch (_) {
        alert('復元に失敗しました');
      }
    });
    container.appendChild(card);
  });
}

function renderSetup() {
  const inSession = state.sessionStarted === true;
  document.getElementById('setup-screen').classList.toggle('hidden', inSession);
  document.getElementById('players-section').classList.toggle('hidden', !inSession);
  document.getElementById('btn-reset').classList.toggle('hidden', !inSession);
  if (!inSession) renderHistory();
}

function resetSession() {
  if (!state.sessionStarted) return;
  if (!confirm('セッションをリセットして最初の画面に戻ります。よろしいですか？')) return;
  pushHistory();
  state = FRESH_STATE();
  saveState();
  render();
}

// ── Render: players ───────────────────────────────

function makeAddChip() {
  const chip = el('button', 'chip add-chip');
  chip.setAttribute('aria-label', 'プレイヤー追加');
  chip.textContent = '＋';
  chip.addEventListener('click', addPlayer);
  return chip;
}

function renderPlayers() {
  const list = document.getElementById('players-list');
  const countEl = document.getElementById('player-count');
  const all = Object.values(state.players).sort((a, b) => a.id - b.id);

  list.innerHTML = '';
  if (!state.sessionStarted || all.length === 0) {
    countEl.textContent = '';
    return;
  }

  all.forEach(p => list.appendChild(makeChip(p)));
  list.appendChild(makeAddChip());

  const activeCount = all.filter(p => p.active).length;
  countEl.textContent = `参加 ${activeCount}人`;
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
    games.textContent = `${p.actualGames ?? p.games}試合`;
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

function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelector(`.nav-btn[data-view="${view}"]`).classList.add('active');
}

function setupNav() {
  // Seed history with main so there's always something to pop back to.
  history.replaceState({ view: 'main' }, '');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view !== 'main') history.pushState({ view }, '');
      else history.replaceState({ view: 'main' }, '');
      switchView(view);
    });
  });

  window.addEventListener('popstate', (e) => {
    // Priority 1: close open picker popup
    const popup = document.querySelector('.setup-popup');
    if (popup) {
      popup.remove();
      history.pushState({ view: 'main' }, '');
      return;
    }
    // Priority 2: stats tab → back to main
    const view = e.state?.view ?? 'main';
    if (view !== 'main') {
      switchView('main');
      history.replaceState({ view: 'main' }, '');
      return;
    }
    // Priority 3: in session on main → reset (same as reset button)
    if (state.sessionStarted) {
      history.pushState({ view: 'main' }, ''); // keep history intact for next back
      resetSession();
    }
  });
}

// ── Init ──────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  state.sessionStarted = false;

  document.getElementById('version-label').textContent =
    `${APP_VERSION} 〜 ${VERSION_NOTES}`;
  document.getElementById('version-footer').textContent = `更新 ${APP_VERSION}`;

  setupNav();
  document.getElementById('btn-reset').addEventListener('click', resetSession);

  const input = document.getElementById('setup-count');
  const btnStart = document.getElementById('btn-start');
  let selectedCourts = 1;

  const minCount = () => selectedCourts === 2 ? 8 : 4;

  const validate = () => {
    const v = parseInt(input.dataset.value, 10);
    btnStart.disabled = !(v >= minCount() && v <= 20);
  };

  const setCount = (v) => {
    input.dataset.value = v == null ? '' : String(v);
    input.textContent = v == null ? '—' : String(v);
    validate();
  };

  document.querySelectorAll('.court-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.court-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedCourts = parseInt(btn.dataset.courts, 10);
      // Reset count if it's now below the new minimum
      const cur = parseInt(input.dataset.value, 10);
      if (cur < minCount()) setCount(null);
      else validate();
    });
  });

  validate();

  let popup = null;
  const closePopup = () => {
    if (popup) { popup.remove(); popup = null; }
    document.removeEventListener('pointerdown', onOutside, true);
  };
  const onOutside = (e) => {
    if (popup && !popup.contains(e.target) && e.target !== input) closePopup();
  };

  input.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popup) { closePopup(); return; }
    popup = document.createElement('div');
    popup.className = 'setup-popup';
    for (let i = minCount(); i <= 20; i++) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'setup-popup-item';
      item.textContent = String(i);
      if (String(i) === input.dataset.value) item.classList.add('selected');
      item.addEventListener('click', () => { setCount(i); closePopup(); });
      popup.appendChild(item);
    }
    const r = input.getBoundingClientRect();
    popup.style.top = (r.bottom + 8) + 'px';
    popup.style.left = (r.left + r.width / 2) + 'px';
    document.body.appendChild(popup);
    const pr = popup.getBoundingClientRect();
    if (pr.left < 8) popup.style.left = (8 + pr.width / 2) + 'px';
    else if (pr.right > window.innerWidth - 8)
      popup.style.left = (window.innerWidth - 8 - pr.width / 2) + 'px';
    const maxH = window.innerHeight - 16;
    if (pr.bottom > maxH) {
      const newTop = Math.max(8, r.top - 8 - pr.height);
      popup.style.top = newTop + 'px';
      popup.style.maxHeight = Math.min(300, r.top - 16) + 'px';
    }
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  });

  btnStart.addEventListener('click', () => {
    const count = parseInt(input.dataset.value, 10);
    if (count >= minCount() && count <= 20) {
      setCount(null);
      initPlayers(count, selectedCourts);
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  render();
});
