'use strict';

const HOLD_MS = 300;
const INSPECT_S = 15;
const BOUNCE_MS = 250;
const PARITY_ALG = "R U R' F' R U2 R' U2 R' F R U R U2 R' U'";
const $ = (id) => document.getElementById(id);
const timerEl = $('timer');

let mode = location.hash === '#bld' ? 'bld' : '333';
let solves = [];
let scramble = '';
let state = 'idle'; // idle | holding | ready | inspecting | running | stopped
let inspectStart = 0;
let inspectTimer = null;
let holdTimer = null;
let startTime = 0;
let raf = 0;
let inspectPenalty = null;
let lastStop = 0;
let memoAt = null; // BLD memo split (ms since start)
let splitAt = 0;
let isPb = false;

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
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const chips = (alg) => alg.split(' ').map((m, i) => `<span data-f="${m[0]}" style="animation-delay:${i * 18}ms">${m}</span>`).join('');

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
  $('scramble').innerHTML = chips(scramble);
}

// ---------- stats ----------
const bestSolve = () => solves.reduce((b, s) => (eff(s) !== null && (!b || eff(s) < eff(b)) ? s : b), null);
// WCA trimmed mean of the last n solves; 'DNF' if too many DNFs, null if not enough solves.
function avgOf(n) {
  if (solves.length < n) return null;
  const vals = solves.slice(0, n).map(eff).map((v) => (v === null ? Infinity : v)).sort((a, b) => a - b);
  const trim = n === 5 ? 1 : Math.ceil(n * 0.05);
  const kept = vals.slice(trim, n - trim);
  if (kept.some((v) => v === Infinity)) return 'DNF';
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}
// Plain mean of the last n (mo3); any DNF makes it DNF.
function meanOf(n) {
  if (solves.length < n) return null;
  const vals = solves.slice(0, n).map(eff);
  return vals.includes(null) ? 'DNF' : vals.reduce((a, b) => a + b, 0) / n;
}
function renderStats() {
  const valid = solves.map(eff).filter((v) => v !== null);
  const best = valid.length ? Math.min(...valid) : null;
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  const f = (v) => (v === null ? '-' : v === 'DNF' ? 'DNF' : fmt(v));
  const items = mode === 'bld'
    ? [['Best', f(best)], ['mo3', f(meanOf(3))], ['ao5', f(avgOf(5))],
       ['Success', solves.length ? `${valid.length}/${solves.length}` : '-'], ['Mean', f(mean)], ['Solves', solves.length]]
    : [['Best', f(best)], ['ao5', f(avgOf(5))], ['ao12', f(avgOf(12))],
       ['ao100', f(avgOf(100))], ['Mean', f(mean)], ['Solves', solves.length]];
  $('stats').innerHTML = items.map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('');
}

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && url.startsWith('/api/solves')) { showAuth(); throw new Error('Logged out'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}
async function load() {
  const m = mode;
  const list = await api('GET', `/api/solves?mode=${m}`);
  if (m !== mode) return; // tab switched while loading
  solves = list;
  render();
}

// ---------- list ----------
function render() {
  renderStats();
  const ul = $('list');
  if (!solves.length) { ul.innerHTML = '<li class="empty">No solves yet</li>'; return; }
  ul.innerHTML = '';
  const pb = bestSolve();
  solves.forEach((s, i) => {
    const li = document.createElement('li');
    if (s === pb) li.className = 'pb';
    li.title = s.scramble;
    const cls = s.penalty === 'DNF' ? 'dnf' : s.penalty === '+2' ? 'p2' : '';
    const sub = [];
    if (s.memo_ms != null) sub.push(`memo ${fmt(s.memo_ms)} · exec ${fmt(s.time_ms - s.memo_ms)}`);
    if (s.edges || s.corners) sub.push(`<span class="e">${esc(s.edges || '–')}</span> | <span class="c">${esc(s.corners || '–')}</span>`);
    li.innerHTML = `<span class="n">${solves.length - i}.</span><div class="tm"><span class="t ${cls}">${fmtSolve(s)}</span>${sub.length ? `<span class="sub">${sub.join(' · ')}</span>` : ''}</div>`;
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
  const label = mode === 'bld' ? 'blindfolded' : '3×3';
  if (!solves.length || !confirm(`Delete ALL ${label} solves? This cannot be undone.`)) return;
  try { await api('DELETE', `/api/solves?mode=${mode}`); solves = []; render(); } catch (e) { alert(e.message); }
};

// ---------- memo (BLD letters) ----------
const memoInputs = { edges: $('edges'), corners: $('corners') };
const letters = (v) => v.toUpperCase().replace(/[^A-Z]/g, '');

// Re-group letters into pairs, keeping the caret after the same letter
function formatMemo(input) {
  const before = letters(input.value.slice(0, input.selectionStart ?? input.value.length)).length;
  const pairs = letters(input.value).match(/.{1,2}/g) || [];
  const out = pairs.join(' ');
  if (out !== input.value) {
    input.value = out;
    let pos = 0;
    for (let n = 0; pos < out.length && n < before; pos++) if (out[pos] !== ' ') n++;
    input.setSelectionRange(pos, pos);
  }
  localStorage.setItem('memo-' + input.id, out);
  renderMemo();
}
function renderMemo() {
  const e = letters(memoInputs.edges.value).length;
  const c = letters(memoInputs.corners.value).length;
  $('edges-n').textContent = e;
  $('corners-n').textContent = c;
  const card = $('parity-card'), badge = $('parity-state'), check = $('memo-check');
  check.textContent = '';
  check.className = 'memo-check';
  if (!e && !c) { card.className = 'card parity'; badge.textContent = 'Enter memo'; return; }
  const odd = (e || c) % 2 === 1;
  card.className = 'card parity ' + (odd ? 'needed' : 'clear');
  badge.textContent = odd ? 'Parity needed' : 'No parity';
  if (e && c && e % 2 !== c % 2) {
    check.textContent = 'Edge and corner target counts differ in parity. Double-check your memo.';
    check.className = 'memo-check warn';
  }
}
function clearMemo() {
  for (const i of Object.values(memoInputs)) { i.value = ''; localStorage.removeItem('memo-' + i.id); }
  renderMemo();
}
for (const i of Object.values(memoInputs)) {
  i.value = localStorage.getItem('memo-' + i.id) || '';
  i.addEventListener('input', () => formatMemo(i));
}
$('memo-clear').onclick = clearMemo;
$('parity-alg').innerHTML = chips(PARITY_ALG);

// ---------- timer ----------
const setState = (s) => {
  state = s;
  document.body.dataset.state = s;
  timerEl.className = { holding: 'holding', ready: 'ready', inspecting: 'inspecting', running: 'running' }[s] || '';
};
const useInspection = () => mode === '333' && $('inspection').checked;
const setSplit = (t) => { $('split').textContent = t; };

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
  if (!useInspection()) inspectPenalty = null;
  memoAt = null;
  setSplit(mode === 'bld' ? 'memo' : '');
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
  const body = { time_ms: ms, scramble, penalty: inspectPenalty, mode };
  if (mode === 'bld') {
    body.memo_ms = memoAt;
    body.edges = memoInputs.edges.value;
    body.corners = memoInputs.corners.value;
    setSplit(memoAt === null ? '' : `memo ${fmt(memoAt)} · exec ${fmt(ms - memoAt)}`);
  }
  newScramble();
  try {
    const prevBest = bestSolve();
    const s = await api('POST', '/api/solves', body);
    isPb = eff(s) !== null && prevBest && eff(s) < eff(prevBest);
    if (s.mode === mode) { solves.unshift(s); render(); }
    if (s.mode === 'bld') clearMemo();
    if (s.penalty === 'DNF') timerEl.textContent = 'DNF';
    else if (s.penalty === '+2') timerEl.textContent = fmt(ms + 2000) + '+';
  } catch (e) { alert('Failed to save solve: ' + e.message); }
  setState('idle');
  if (isPb) { void timerEl.offsetWidth; timerEl.classList.add('pb'); isPb = false; }
}

// Press: begin hold, split memo (BLD), or stop a running timer.
function press() {
  if (state === 'running') {
    if (performance.now() - splitAt < BOUNCE_MS) return;
    if (mode === 'bld' && memoAt === null) {
      memoAt = Math.round(performance.now() - startTime);
      splitAt = performance.now();
      setSplit(`memo ${fmt(memoAt)} · executing`);
      return;
    }
    stopRun();
    return;
  }
  if (performance.now() - lastStop < BOUNCE_MS) return; // swallow stop-press bounce
  if (state === 'idle' || state === 'inspecting') {
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

const typing = () => document.activeElement?.tagName === 'INPUT' && ['text', 'password'].includes(document.activeElement.type);
const authed = () => document.body.dataset.auth === 'in';
document.addEventListener('keydown', (e) => {
  if (e.repeat || !authed() || $('invite-dialog').open) return;
  if (state === 'running') { e.preventDefault(); press(); return; }
  if (typing()) { if (e.key === 'Escape' || e.key === 'Enter') document.activeElement.blur(); return; }
  if (['BUTTON', 'INPUT'].includes(document.activeElement?.tagName) && e.code === 'Space' && state === 'idle') {
    document.activeElement.blur();
  }
  if (e.code === 'Space') { e.preventDefault(); press(); }
  else if (e.code === 'Escape' && state === 'inspecting') { clearInterval(inspectTimer); setState('idle'); timerEl.textContent = '0.00'; }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && authed() && !$('invite-dialog').open && !typing()) { e.preventDefault(); release(); }
});

// Touch: whole timer area; any touch stops a running timer.
timerEl.addEventListener('touchstart', (e) => { e.preventDefault(); press(); }, { passive: false });
timerEl.addEventListener('touchend', (e) => { e.preventDefault(); release(); }, { passive: false });
document.addEventListener('touchstart', (e) => { if (state === 'running') { e.preventDefault(); press(); } }, { passive: false });

// ---------- tabs ----------
function setMode(m) {
  if (state !== 'idle' && state !== 'stopped') return;
  mode = m;
  document.body.dataset.mode = m;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  history.replaceState(null, '', m === 'bld' ? '#bld' : location.pathname);
  timerEl.textContent = '0.00';
  setSplit('');
  solves = [];
  render();
  newScramble();
  if (authed()) load().catch((e) => { $('list').innerHTML = `<li class="empty">Failed to load: ${esc(e.message)}</li>`; });
}
document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
window.addEventListener('hashchange', () => {
  if (applyInviteLink()) return;
  setMode(location.hash === '#bld' ? 'bld' : '333');
});

// ---------- settings / init ----------
$('inspection').checked = localStorage.getItem('inspection') === '1';
$('inspection').onchange = (e) => localStorage.setItem('inspection', e.target.checked ? '1' : '0');

// ---------- accounts ----------
let authMode = 'login';
function setAuthMode(m) {
  authMode = m;
  $('auth').dataset.mode = m;
  document.querySelectorAll('[data-auth-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.authMode === m)));
  $('auth-submit').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('auth-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('auth-error').textContent = '';
}
function showAuth() {
  document.body.dataset.auth = 'out';
  solves = [];
  setTimeout(() => $('auth-user').focus(), 50);
}
function signedIn(user) {
  document.body.dataset.auth = 'in';
  $('who').textContent = user.username;
  $('user-btn').textContent = user.username[0].toUpperCase();
  $('auth-pass').value = '';
  $('auth-invite').value = '';
  setMode(mode);
}
document.querySelectorAll('[data-auth-mode]').forEach((b) => { b.onclick = () => setAuthMode(b.dataset.authMode); });
$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('auth-submit');
  btn.disabled = true;
  $('auth-error').textContent = '';
  try {
    const body = { username: $('auth-user').value.trim(), password: $('auth-pass').value };
    if (authMode === 'register') body.invite = $('auth-invite').value.trim();
    const { user } = await api('POST', `/api/${authMode}`, body);
    signedIn(user);
  } catch (err) { $('auth-error').textContent = err.message; }
  btn.disabled = false;
};
const toggleMenu = (open) => {
  $('user-menu').classList.toggle('open', open);
  $('user-btn').setAttribute('aria-expanded', String(open));
};
$('user-btn').onclick = (e) => { e.stopPropagation(); toggleMenu(!$('user-menu').classList.contains('open')); };
document.addEventListener('click', (e) => { if (!e.target.closest('.user')) toggleMenu(false); });
$('logout').onclick = async () => {
  toggleMenu(false);
  await api('POST', '/api/logout').catch(() => {});
  clearMemo(); // memo notes are per device; don't leave them for the next person
  showAuth();
};

// ---------- invites ----------
const inviteUrl = (code) => `${location.origin}/#invite=${code}`;
const daysLeft = (t) => Math.max(1, Math.ceil((t - Date.now()) / 864e5));
function renderInvites(list) {
  const ul = $('invite-list');
  if (!list.length) { ul.innerHTML = '<li class="empty">No invites yet</li>'; return; }
  ul.innerHTML = '';
  for (const inv of list) {
    const li = document.createElement('li');
    if (inv.used_at) {
      li.className = 'used';
      li.innerHTML = `<span class="inv-status">Joined</span><span class="inv-who">${esc(inv.used_by || 'deleted user')}</span>`;
    } else {
      li.innerHTML = `<span class="inv-status open">${daysLeft(inv.expires_at)}d left</span><code class="inv-link">${esc(inviteUrl(inv.code))}</code>`;
      const copy = document.createElement('button');
      copy.textContent = navigator.share ? 'Share' : 'Copy';
      copy.onclick = async () => {
        const url = inviteUrl(inv.code);
        try {
          if (navigator.share) await navigator.share({ title: 'Cube Timer invite', text: 'Join me on Cube Timer', url });
          else { await navigator.clipboard.writeText(url); copy.textContent = 'Copied!'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); }
        } catch { /* share sheet dismissed */ }
      };
      const del = document.createElement('button');
      del.textContent = '✕';
      del.className = 'danger';
      del.setAttribute('aria-label', 'Revoke invite');
      del.onclick = async () => {
        try { await api('DELETE', `/api/invites/${inv.code}`); loadInvites(); } catch (e) { $('invite-error').textContent = e.message; }
      };
      li.append(copy, del);
    }
    ul.appendChild(li);
  }
}
async function loadInvites() {
  try { renderInvites(await api('GET', '/api/invites')); } catch (e) { $('invite-error').textContent = e.message; }
}
$('invite-open').onclick = () => {
  toggleMenu(false);
  $('invite-error').textContent = '';
  $('invite-dialog').showModal();
  loadInvites();
};
$('invite-close').onclick = () => $('invite-dialog').close();
$('invite-dialog').addEventListener('click', (e) => { if (e.target === $('invite-dialog')) $('invite-dialog').close(); });
$('invite-create').onclick = async () => {
  $('invite-error').textContent = '';
  try {
    const inv = await api('POST', '/api/invites');
    await loadInvites();
    await navigator.clipboard?.writeText(inviteUrl(inv.code)).catch(() => {});
  } catch (e) { $('invite-error').textContent = e.message; }
};

// Invite links (#invite=CODE) open the sign-up form with the code filled in
function applyInviteLink() {
  const code = (location.hash.match(/^#invite=([A-Za-z0-9_-]+)$/) || [])[1];
  if (!code) return false;
  history.replaceState(null, '', location.pathname);
  if (authed()) return true; // already has an account
  setAuthMode('register');
  $('auth-invite').value = code;
  return true;
}

renderMemo();
setAuthMode('login');
applyInviteLink();
api('GET', '/api/me').then(({ user }) => signedIn(user)).catch(showAuth);
