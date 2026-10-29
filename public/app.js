'use strict';

const HOLD_MS = 300;
const INSPECT_S = 15;
const $ = (id) => document.getElementById(id);
const timerEl = $('timer');

let solves = [];
let scramble = '';
let state = 'idle'; // idle | holding | ready | inspecting | running | stopped
let inspecting = false; // whether inspection is active before a run
let inspectStart = 0;
let inspectTimer = null;
let holdTimer = null;
let startTime = 0;
let raf = 0;
let inspectPenalty = null;
let lastStop = 0;

// ---------- formatting ----------
function fmt(ms) {
  const cs = Math.floor(ms / 10);
  const s = Math.floor(cs / 100);
  const c = String(cs % 100).padStart(2, '0');
  if (s >= 60) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${c}`;
  return `${s}.${c}`;
}
// Effective time: null means DNF
const eff = (s) => (s.penalty === 'DNF' ? null : s.time_ms + (s.penalty === '+2' ? 2000 : 0));
const fmtSolve = (s) => (s.penalty === 'DNF' ? 'DNF' : fmt(eff(s)) + (s.penalty === '+2' ? '+' : ''));

// ---------- scramble ----------
function genScramble() {
  const faces = ['U', 'D', 'L', 'R', 'F', 'B'];
  const axis = { U: 0, D: 0, L: 1, R: 1, F: 2, B: 2 };
  const mods = ['', "'", '2'];
  const moves = [];
  let last = -1, prev = -1; // last face, face before it
  while (moves.length < 20) {
    const f = faces[Math.floor(Math.random() * 6)];
    if (f === last) continue;
    // Skip e.g. "U D U": same axis as last two moves
    if (last !== -1 && prev !== -1 && axis[f] === axis[last] && axis[f] === axis[prev]) continue;
    moves.push(f + mods[Math.floor(Math.random() * 3)]);
    prev = last === -1 ? -1 : axis[last] === axis[f] ? last : -1;
    last = f;
  }
  return moves.join(' ');
}
function newScramble() {
  scramble = genScramble();
  $('scramble').textContent = scramble;
}

// ---------- stats ----------
// WCA trimmed mean of the last n solves; null if fewer than n or 2+ DNFs.
function avgOf(list, n) {
  if (list.length < n) return null;
  const vals = list.slice(0, n).map(eff).map((v) => (v === null ? Infinity : v));
  vals.sort((a, b) => a - b);
  const trim = n === 5 ? 1 : Math.ceil(n * 0.05);
  const kept = vals.slice(trim, n - trim);
  if (kept.some((v) => v === Infinity)) return null;
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}
function renderStats() {
  const valid = solves.map(eff).filter((v) => v !== null);
  const best = valid.length ? Math.min(...valid) : null;
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  const f = (v) => (v === null ? '-' : fmt(v));
  const items = [
    ['Best', f(best)], ['ao5', f(avgOf(solves, 5))], ['ao12', f(avgOf(solves, 12))],
    ['ao100', f(avgOf(solves, 100))], ['Mean', f(mean)], ['Solves', solves.length],
  ];
  $('stats').innerHTML = items.map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('');
}

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}
async function load() {
  solves = await api('GET', '/api/solves');
  render();
}

// ---------- list ----------
function render() {
  renderStats();
  const ul = $('list');
  if (!solves.length) { ul.innerHTML = '<li class="empty">No solves yet</li>'; return; }
  ul.innerHTML = '';
  solves.forEach((s, i) => {
    const li = document.createElement('li');
    li.title = s.scramble;
    const cls = s.penalty === 'DNF' ? 'dnf' : s.penalty === '+2' ? 'p2' : '';
    li.innerHTML = `<span class="n">${solves.length - i}.</span><span class="t ${cls}">${fmtSolve(s)}</span>`;
    for (const p of ['+2', 'DNF']) {
      const b = document.createElement('button');
      b.textContent = p;
      b.className = s.penalty === p ? 'on' : '';
      b.onclick = () => setPenalty(s.id, s.penalty === p ? null : p);
      li.appendChild(b);
    }
    const del = document.createElement('button');
    del.textContent = '✕';
    del.className = 'danger';
    del.setAttribute('aria-label', 'Delete solve');
    del.onclick = () => removeSolve(s.id);
    li.appendChild(del);
    ul.appendChild(li);
  });
}
async function setPenalty(id, penalty) {
  try {
    const upd = await api('PATCH', `/api/solves/${id}`, { penalty });
    solves = solves.map((s) => (s.id === id ? upd : s));
    render();
  } catch (e) { alert(e.message); }
}
async function removeSolve(id) {
  try { await api('DELETE', `/api/solves/${id}`); solves = solves.filter((s) => s.id !== id); render(); }
  catch (e) { alert(e.message); }
}
$('clear').onclick = async () => {
  if (!solves.length || !confirm('Delete ALL solves? This cannot be undone.')) return;
  try { await api('DELETE', '/api/solves'); solves = []; render(); } catch (e) { alert(e.message); }
};

// ---------- timer ----------
const setState = (s) => {
  state = s;
  timerEl.className = { holding: 'holding', ready: 'ready', inspecting: 'inspecting', running: 'running' }[s] || '';
};
const useInspection = () => $('inspection').checked;

function tick() {
  timerEl.textContent = fmt(performance.now() - startTime);
  raf = requestAnimationFrame(tick);
}

function tickInspection() {
  const el = (performance.now() - inspectStart) / 1000;
  if (el >= INSPECT_S + 2) { inspectPenalty = 'DNF'; timerEl.textContent = 'DNF'; }
  else if (el >= INSPECT_S) { inspectPenalty = '+2'; timerEl.textContent = '+2'; }
  else { inspectPenalty = null; timerEl.textContent = String(Math.ceil(INSPECT_S - el)); }
}

function startInspection() {
  inspectStart = performance.now();
  inspectPenalty = null;
  setState('inspecting');
  tickInspection();
  inspectTimer = setInterval(tickInspection, 100);
}

function startRun() {
  clearInterval(inspectTimer);
  startTime = performance.now();
  setState('running');
  raf = requestAnimationFrame(tick);
}

async function stopRun() {
  cancelAnimationFrame(raf);
  const ms = Math.round(performance.now() - startTime);
  lastStop = performance.now();
  setState('stopped');
  timerEl.textContent = fmt(ms);
  const penalty = inspectPenalty;
  const sc = scramble;
  newScramble();
  try {
    const s = await api('POST', '/api/solves', { time_ms: ms, scramble: sc, penalty });
    solves.unshift(s);
    render();
    if (penalty === 'DNF') timerEl.textContent = 'DNF';
    else if (penalty === '+2') timerEl.textContent = fmt(ms + 2000) + '+';
  } catch (e) { alert('Failed to save solve: ' + e.message); }
  setState('idle');
}

// Press: begin hold, or stop a running timer.
function press() {
  if (state === 'running') { stopRun(); return; }
  if (performance.now() - lastStop < 250) return; // swallow stop-press bounce
  if (state === 'idle' || state === 'inspecting') {
    inspecting = state === 'inspecting';
    const prev = state;
    setState('holding');
    timerEl.dataset.prev = prev;
    holdTimer = setTimeout(() => { if (state === 'holding') setState('ready'); }, HOLD_MS);
  }
}
// Release: start if ready; otherwise cancel the hold.
function release() {
  if (state === 'ready') {
    clearTimeout(holdTimer);
    startRun();
  } else if (state === 'holding') {
    clearTimeout(holdTimer);
    if (timerEl.dataset.prev === 'inspecting') { setState('inspecting'); }
    else if (useInspection()) { startInspection(); }
    else setState('idle');
  }
}

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (['INPUT', 'BUTTON', 'TEXTAREA'].includes(document.activeElement?.tagName) && e.code === 'Space' && state === 'idle') {
    document.activeElement.blur();
  }
  if (state === 'running') { e.preventDefault(); press(); return; }
  if (e.code === 'Space') { e.preventDefault(); press(); }
  else if (e.code === 'Escape' && (state === 'inspecting')) { clearInterval(inspectTimer); setState('idle'); timerEl.textContent = '0.00'; }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { e.preventDefault(); release(); }
});

// Touch: whole timer area; any touch stops a running timer.
timerEl.addEventListener('touchstart', (e) => { e.preventDefault(); press(); }, { passive: false });
timerEl.addEventListener('touchend', (e) => { e.preventDefault(); release(); }, { passive: false });
document.addEventListener('touchstart', (e) => { if (state === 'running') { e.preventDefault(); press(); } }, { passive: false });

// ---------- settings / init ----------
$('inspection').checked = localStorage.getItem('inspection') === '1';
$('inspection').onchange = (e) => localStorage.setItem('inspection', e.target.checked ? '1' : '0');

newScramble();
load().catch((e) => { $('list').innerHTML = `<li class="empty">Failed to load: ${e.message}</li>`; });
