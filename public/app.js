'use strict';

const HOLD_MS = 300;
const INSPECT_S = 15;
const BOUNCE_MS = 250;
const PARITY_ALG = "R U R' F' R U2 R' U2 R' F R U R U2 R' U'";
const EDGE_ALG = "R U R' U' R' F R2 U' R' U' R U R' F'";
const CORNER_ALG = "R U' R' U' R U R' F' R U R' U' R' F R";
const $ = (id) => document.getElementById(id);
const timerEl = $('timer');

const TRAIN = new Set(['oll2', 'pll2', 'oll', 'pll']);
let trainSet = TRAIN.has(localStorage.getItem('train-set')) ? localStorage.getItem('train-set') : 'pll';
let mode = { '#bld': 'bld', '#train': trainSet }[location.hash] || '333';
const isTrain = () => TRAIN.has(mode);
const MODE_LABEL = { 333: '3×3', bld: 'blindfolded', pll: 'PLL trainer', oll: 'OLL trainer', pll2: '2-look PLL trainer', oll2: '2-look OLL trainer' };
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
let trainCase = null; // trainer case being drilled
let challenge = null; // { kind, code, scramble } during a daily/race solve

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
const chips = (alg) => alg.split(' ').map((m, i) => `<span data-f="${m[0]}" tabindex="0" title="Show the cube after this move" style="animation-delay:${i * 18}ms">${m}</span>`).join('');

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
  closeViewer();
  let label = '';
  if (challenge && mode === '333') scramble = challenge.scramble;
  else if (isTrain()) {
    const [id, , alg] = pickCase();
    trainCase = id;
    scramble = Cube.setup(alg, Math.floor(Math.random() * 4), Math.floor(Math.random() * 4));
    label = '<em class="scr-label">Setup</em>';
  } else scramble = genScramble();
  $('scramble').innerHTML = label + chips(scramble);
  hideMemoResult();
}

// ---------- move viewer: click a move chip to see the cube after it ----------
const viewer = document.createElement('div');
viewer.className = 'mv';
viewer.hidden = true;
let mvSrc = null, mvMoves = [], mvStart = null, mvPos = 0;
const FACE_NAME = { U: 'top', D: 'bottom', L: 'left', R: 'right', F: 'front', B: 'back' };
function describeMove(m) {
  const amt = /2'?$/.test(m) ? 'half turn' : m.endsWith("'") ? 'counter-clockwise' : 'clockwise', f = m[0];
  if ('xyz'.includes(f)) return `turn the whole cube (${f} axis), ${amt}`;
  if ('MES'.includes(f)) return `${{ M: 'middle', E: 'equator', S: 'standing' }[f]} slice, ${amt}`;
  const wide = f !== f.toUpperCase() || m.includes('w');
  return `${FACE_NAME[f.toUpperCase()]} ${wide ? 'two layers' : 'face'}, ${amt}`;
}
const chipsOf = (src) => [...src.querySelectorAll(':scope > span')];
function markChips(src, pos) {
  chipsOf(src).forEach((c, i) => { c.classList.toggle('mv-on', i === pos - 1); c.classList.toggle('mv-done', i < pos - 1); });
}
function renderViewer() {
  const p = mvPos, mv = mvMoves[p - 1];
  let st;
  try { st = Cube.apply(mvStart, mvMoves.slice(0, p).join(' ')); } catch { closeViewer(); return; }
  const face = mv && /^[UDLRFBudlrfb]/.test(mv) ? mv[0].toUpperCase() : null;
  const startText = mvSrc.dataset.start ? 'The case, before the first move' : 'Solved cube: white on top, green in front';
  viewer.innerHTML = `${Cube.netSvg(st, 16, face)}
    <div class="mv-side">
      <span class="mv-step">${p ? `Move ${p} of ${mvMoves.length}` : 'Start'}</span>
      <div class="mv-move">${p ? `<b>${esc(mv)}</b><span>${describeMove(mv)}</span>` : `<span>${startText}</span>`}</div>
      <div class="mv-btns">
        <button type="button" data-mv="first" aria-label="Back to start"${p ? '' : ' disabled'}>⏮</button>
        <button type="button" data-mv="prev"${p ? '' : ' disabled'}>‹ Prev</button>
        <button type="button" data-mv="next"${p < mvMoves.length ? '' : ' disabled'}>Next ›</button>
        <button type="button" data-mv="last" aria-label="Jump to end"${p < mvMoves.length ? '' : ' disabled'}>⏭</button>
        <button type="button" data-mv="close" class="mv-x" aria-label="Close">✕</button>
      </div>
    </div>`;
  markChips(mvSrc, p);
}
function openViewer(src, i) {
  if (mvSrc && mvSrc !== src) markChips(mvSrc, 0);
  try { mvStart = Cube.apply(Cube.solved(), src.dataset.start || ''); } catch { return; }
  mvSrc = src;
  mvMoves = chipsOf(src).map((c) => c.textContent);
  mvPos = i + 1;
  src.after(viewer);
  viewer.hidden = false;
  renderViewer();
}
function closeViewer() {
  if (!mvSrc) return;
  viewer.hidden = true;
  if (mvSrc.isConnected) markChips(mvSrc, 0);
  mvSrc = null;
}
function stepViewer(act) {
  if (act === 'close') return closeViewer();
  mvPos = { first: 0, prev: Math.max(0, mvPos - 1), next: Math.min(mvMoves.length, mvPos + 1), last: mvMoves.length }[act];
  renderViewer();
}
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.moves > span');
  if (chip && (state === 'idle' || state === 'stopped')) {
    const src = chip.parentElement, i = chipsOf(src).indexOf(chip);
    if (mvSrc === src && mvPos === i + 1) closeViewer(); else openViewer(src, i);
    return;
  }
  const b = e.target.closest('[data-mv]');
  if (b && viewer.contains(b)) stepViewer(b.dataset.mv);
});

// ---------- stats ----------
const bestSolve = (list = solves) => list.reduce((b, s) => (eff(s) !== null && (!b || eff(s) < eff(b)) ? s : b), null);
// WCA trimmed mean of the last n solves; 'DNF' if too many DNFs, null if not enough solves.
function avgOf(n, list = solves) {
  if (list.length < n) return null;
  const vals = list.slice(0, n).map(eff).map((v) => (v === null ? Infinity : v)).sort((a, b) => a - b);
  const trim = n === 5 ? 1 : Math.ceil(n * 0.05);
  const kept = vals.slice(trim, n - trim);
  if (kept.some((v) => v === Infinity)) return 'DNF';
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}
// Plain mean of the last n (mo3); any DNF makes it DNF.
function meanOf(n, list = solves) {
  if (list.length < n) return null;
  const vals = list.slice(0, n).map(eff);
  return vals.includes(null) ? 'DNF' : vals.reduce((a, b) => a + b, 0) / n;
}
function statsHtml(list, m) {
  const valid = list.map(eff).filter((v) => v !== null);
  const best = valid.length ? Math.min(...valid) : null;
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  const f = (v) => (v === null ? '-' : v === 'DNF' ? 'DNF' : fmt(v));
  const items = m === 'bld'
    ? [['Best', f(best)], ['mo3', f(meanOf(3, list))], ['ao5', f(avgOf(5, list))],
       ['Success', list.length ? `${valid.length}/${list.length}` : '-'], ['Mean', f(mean)], ['Solves', list.length]]
    : [['Best', f(best)], ['ao5', f(avgOf(5, list))], ['ao12', f(avgOf(12, list))],
       ['ao100', f(avgOf(100, list))], ['Mean', f(mean)], ['Solves', list.length]];
  return items.map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('');
}
function renderStats() { $('stats').innerHTML = statsHtml(solves, mode); }

// ---------- insights (charts) ----------
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m` : `${Math.round(ms / 1000)}s`; };
const fmtAxis = (ms) => (ms >= 60000 ? fmt(ms).replace(/\.\d+$/, '') : `${+(ms / 1000).toFixed(1)}s`);
function niceStep(range, target) {
  const raw = Math.max(range, 1) / target, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}
// Like niceStep, but clock-friendly (15s, 30s, 1m…) once steps reach 10 seconds
function timeStep(range, target) {
  const step = niceStep(range, target);
  return step < 10000 ? step : [10e3, 15e3, 20e3, 30e3, 60e3, 120e3, 300e3, 600e3, 1200e3, 1800e3, 3600e3].find((t) => t >= step) || step;
}
// Column with a 4px rounded top and a square base
function colPath(x, y, w, h) {
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
const tipRow = (c, v, label) => `<div class="r"><i style="--c:${c}"></i><b>${v}</b> ${label}</div>`;

// Running averages and PB in chronological order
function series(chron, m) {
  const vals = chron.map(eff);
  const win = m === 'bld' ? 5 : chron.length >= 12 ? 12 : 5;
  const label = m === 'bld' ? 'mean of last 5 successes' : 'ao' + win;
  const ok = [];
  let best = null;
  const avg = [], pb = [];
  vals.forEach((v, i) => {
    if (v !== null) { ok.push(v); if (best === null || v < best) best = v; }
    pb.push(best);
    if (m === 'bld') { const last = ok.slice(-5); avg.push(last.length >= 3 ? last.reduce((a, b) => a + b, 0) / last.length : null); }
    else { const a = i + 1 >= win ? avgOf(win, chron.slice(i + 1 - win, i + 1)) : null; avg.push(typeof a === 'number' ? a : null); }
  });
  return { vals, avg, pb, label };
}

function insightTiles(m, chron, s) {
  const ok = s.vals.filter((v) => v !== null);
  const tiles = [];
  if (m === 'bld') {
    const last = chron.slice(-10), succ = last.filter((x) => eff(x) !== null).length;
    tiles.push(['Recent success', last.length ? `${Math.round(succ / last.length * 100)}%` : '-', `${succ} of last ${last.length}`]);
    const memo = chron.filter((x) => x.memo_ms != null).slice(-10);
    const am = memo.length ? memo.reduce((a, x) => a + x.memo_ms, 0) / memo.length : null;
    const ae = memo.length ? memo.reduce((a, x) => a + x.time_ms - x.memo_ms, 0) / memo.length : null;
    tiles.push(['Avg memo', am === null ? '-' : fmt(am), memo.length ? `exec ${fmt(ae)} · last ${memo.length}` : 'no memo splits yet']);
  } else {
    const avgs = s.avg.filter((v) => v !== null);
    let imp = ['Improvement', '-', 'needs 24 solves'];
    if (chron.length >= 24 && avgs.length >= 2) {
      const d = avgs[0] - avgs.at(-1);
      imp = ['Improvement', `<em class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '−' : '+'}${fmt(Math.abs(d))}</em>`, `${s.label} vs your first ${s.label}`];
    }
    tiles.push(imp);
    const recent = ok.slice(-50);
    const mean = recent.reduce((a, b) => a + b, 0) / (recent.length || 1);
    const sd = Math.sqrt(recent.reduce((a, v) => a + (v - mean) ** 2, 0) / (recent.length || 1));
    tiles.push(['Consistency', recent.length >= 5 ? `±${fmt(sd)}` : '-', `std. deviation, last ${Math.min(recent.length, 50)}`]);
  }
  let pbs = 0, pbAt = null, best = null;
  chron.forEach((x) => { const v = eff(x); if (v !== null && (best === null || v < best)) { best = v; pbs++; pbAt = x.created_at; } });
  tiles.push(['PBs set', pbs, pbAt ? `latest ${fmtDate(pbAt)}` : 'none yet']);
  // Day streaks in local time
  const days = new Set(chron.map((x) => dayKey(x.created_at)));
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let cur = 0;
  while (days.has(dayKey(d))) { cur++; d.setDate(d.getDate() - 1); }
  let bestRun = 0, run = 0, prev = null;
  for (const x of chron) {
    const t = new Date(x.created_at); t.setHours(0, 0, 0, 0);
    if (prev === null || t - prev > 36e5 * 30) run = 1; else if (t - prev > 0) run++;
    prev = t; bestRun = Math.max(bestRun, run);
  }
  tiles.push(['Day streak', cur ? `${cur} day${cur === 1 ? '' : 's'}` : '-', `best ${bestRun} day${bestRun === 1 ? '' : 's'}`]);
  tiles.push(['Time solving', fmtDur(chron.reduce((a, x) => a + x.time_ms, 0)), `${days.size} day${days.size === 1 ? '' : 's'} active`]);
  const p2 = chron.filter((x) => x.penalty === '+2').length, dnf = chron.filter((x) => x.penalty === 'DNF').length;
  tiles.push(m === 'bld' ? ['DNFs', dnf, `${Math.round(dnf / chron.length * 100)}% of attempts`]
    : ['Penalties', `${Math.round((p2 + dnf) / chron.length * 100)}%`, `${p2} × +2 · ${dnf} × DNF`]);
  return tiles.map(([k, v, sub]) => `<div class="ins-tile"><span>${k}</span><b>${v}</b><small>${sub}</small></div>`).join('');
}

function progressSvg(root, chron, s, w) {
  const H = 220, L = 46, R = 14, T = 12, B = 26, n = chron.length;
  const sorted = s.vals.filter((v) => v !== null).sort((a, b) => a - b);
  if (n < 2 || !sorted.length) return '<p class="ins-empty">Do a couple more solves to see your progression.</p>';
  // Cap the y-range so one disaster solve doesn't flatten everything else
  let hi = Math.min(sorted.at(-1), sorted[Math.floor((sorted.length - 1) * 0.95)] * 1.2), lo = sorted[0];
  if (hi <= lo) hi = lo + 1000;
  const step = timeStep(hi - lo, 4), y0 = Math.floor(lo / step) * step, y1 = Math.ceil(hi / step) * step;
  const x = (i) => L + (i * (w - L - R)) / (n - 1);
  const y = (v) => T + (1 - (Math.min(v, y1) - y0) / (y1 - y0)) * (H - T - B);
  let g = '';
  for (let v = y0; v <= y1 + 1; v += step) g += `<line class="grid" x1="${L}" x2="${w - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 8}" y="${y(v) + 3.5}" text-anchor="end">${fmtAxis(v)}</text>`;
  const xs = niceStep(n, Math.max(2, Math.floor((w - L - R) / 70)));
  for (let i = 0; i < n; i += xs) g += `<text class="ax" x="${x(i)}" y="${H - 6}" text-anchor="middle">${i + 1}</text>`;
  const r = n > 300 ? 1.8 : n > 80 ? 2.5 : 3.5;
  const dots = s.vals.map((v, i) => (v === null ? '' : `<circle class="dot${v > y1 ? ' clip' : ''}" cx="${x(i)}" cy="${y(v)}" r="${r}"/>`)).join('');
  const line = (arr, stepped) => {
    let d = '', open = false;
    arr.forEach((v, i) => {
      if (v === null) { open = false; return; }
      d += !open ? `M${x(i)},${y(v)}` : stepped ? `H${x(i)}V${y(v)}` : `L${x(i)},${y(v)}`;
      open = true;
    });
    return d;
  };
  const lastAvg = s.avg.findLastIndex((v) => v !== null);
  const end = lastAvg < 0 ? '' : `<circle class="end" cx="${x(lastAvg)}" cy="${y(s.avg[lastAvg])}" r="4.5"/>`;
  root._prog = { x, n, L, R, w, chron, s };
  return `<svg class="chart" width="${w}" height="${H}" role="img" aria-label="Solve times over ${n} solves">${g}${dots}
    <path class="pbl" d="${line(s.pb, true)}"/><path class="avg" d="${line(s.avg)}"/>${end}
    <line class="xh" y1="${T}" y2="${H - B}" visibility="hidden"/>
    <rect class="hit" data-prog x="${L - 6}" y="0" width="${w - L - R + 12}" height="${H}"/></svg>`;
}

function histSvg(root, s, w) {
  const ok = s.vals.filter((v) => v !== null).sort((a, b) => a - b);
  if (ok.length < 5) return '<p class="ins-empty">Needs at least 5 successful solves.</p>';
  const H = 170, T = 18, B = 24, L = 4, R = 4;
  const hi = Math.min(ok.at(-1), ok[Math.floor((ok.length - 1) * 0.95)] * 1.2);
  const step = timeStep(hi - ok[0], Math.min(16, Math.max(5, Math.floor((w - L - R) / 30))));
  const start = Math.floor(ok[0] / step) * step, nb = Math.max(1, Math.ceil((hi - start) / step) || 1);
  const counts = new Array(nb).fill(0);
  for (const v of ok) counts[Math.min(nb - 1, Math.floor((v - start) / step))]++;
  const max = Math.max(...counts), slot = (w - L - R) / nb, bw = Math.max(2, Math.min(24, slot - 2));
  const top = counts.indexOf(max), every = Math.ceil(46 / slot);
  let g = `<line class="base" x1="${L}" x2="${w - R}" y1="${H - B}" y2="${H - B}"/>`;
  counts.forEach((c, i) => {
    const bx = L + i * slot + (slot - bw) / 2, h = (c / max) * (H - T - B);
    const lo = start + i * step, label = i === nb - 1 && ok.at(-1) >= lo + step ? `${fmtAxis(lo)}+` : `${fmtAxis(lo)}–${fmtAxis(lo + step)}`;
    root._tips.push(`<div class="h">${label}</div>${tipRow('var(--g)', c, `solve${c === 1 ? '' : 's'}`)}<div class="r dim">${Math.round(c / ok.length * 100)}% of successes</div>`);
    if (c) g += `<path class="bar" d="${colPath(bx, H - B - h, bw, h)}"/>`;
    g += `<rect class="hit" data-t="${root._tips.length - 1}" x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}"/>`;
    if (i === top) g += `<text class="cap" x="${bx + bw / 2}" y="${H - B - h - 6}" text-anchor="middle">${c}</text>`;
    if (i % every === 0) g += `<text class="ax" x="${L + i * slot}" y="${H - 6}" text-anchor="${i ? 'middle' : 'start'}">${fmtAxis(lo)}</text>`;
  });
  return `<svg class="chart" width="${w}" height="${H}" role="img" aria-label="Distribution of solve times">${g}</svg>`;
}

function memoSvg(root, chron, w) {
  const list = chron.filter((x) => x.memo_ms != null).slice(-Math.max(5, Math.min(30, Math.floor(w / 20))));
  if (list.length < 2) return '<p class="ins-empty">Press once mid-solve to split memo from execution.</p>';
  const H = 170, T = 10, B = 24, L = 42, R = 4;
  const max = Math.max(...list.map((x) => x.time_ms)), step = timeStep(max, 3), y1 = Math.ceil(max / step) * step;
  const y = (v) => (v / y1) * (H - T - B), slot = (w - L - R) / list.length, bw = Math.max(3, Math.min(24, slot - 2));
  let g = '';
  for (let v = 0; v <= y1; v += step) g += `<line class="${v ? 'grid' : 'base'}" x1="${L}" x2="${w - R}" y1="${H - B - y(v)}" y2="${H - B - y(v)}"/><text class="ax" x="${L - 8}" y="${H - B - y(v) + 3.5}" text-anchor="end">${fmtAxis(v)}</text>`;
  list.forEach((s, i) => {
    const bx = L + i * slot + (slot - bw) / 2, hm = y(s.memo_ms), he = y(s.time_ms - s.memo_ms);
    root._tips.push(`<div class="h">${fmtDate(s.created_at)}${s.penalty === 'DNF' ? ' · DNF' : ''}</div>${tipRow('var(--b)', fmt(s.memo_ms), 'memo')}${tipRow('var(--g)', fmt(s.time_ms - s.memo_ms), 'exec')}<div class="r dim">${fmt(s.time_ms)} total</div>`);
    g += `<g class="${s.penalty === 'DNF' ? 'dnf' : ''}"><rect class="seg-m" x="${bx}" y="${H - B - hm}" width="${bw}" height="${hm}"/>`;
    if (he > 2) g += `<path class="seg-e" d="${colPath(bx, H - B - hm - he, bw, he - 2)}"/>`;
    g += `</g><rect class="hit" data-t="${root._tips.length - 1}" x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}"/>`;
  });
  g += `<text class="ax" x="${L}" y="${H - 6}">older</text><text class="ax" x="${w - R}" y="${H - 6}" text-anchor="end">latest</text>`;
  return `<svg class="chart" width="${w}" height="${H}" role="img" aria-label="Memo and execution time per attempt">${g}</svg>`;
}

function activitySvg(root, chron, w) {
  const counts = new Map();
  for (const x of chron) { const k = dayKey(x.created_at); counts.set(k, (counts.get(k) || 0) + 1); }
  const C = 12, S = 15, L = 28, T = 16, weeks = Math.max(8, Math.min(53, Math.floor((w - L) / S)));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7);
  const max = Math.max(1, ...counts.values());
  let g = ['Mon', '', 'Wed', '', 'Fri', '', ''].map((d, r) => (d ? `<text class="ax" x="0" y="${T + r * S + 9.5}">${d}</text>` : '')).join('');
  let lastMonth = -1;
  for (let c = 0; c < weeks; c++) {
    const wk = new Date(start); wk.setDate(wk.getDate() + c * 7);
    if (wk.getMonth() !== lastMonth && c < weeks - 2) { g += `<text class="ax" x="${L + c * S}" y="10">${wk.toLocaleDateString(undefined, { month: 'short' })}</text>`; lastMonth = wk.getMonth(); }
    for (let r = 0; r < 7; r++) {
      const d = new Date(wk); d.setDate(d.getDate() + r);
      if (d > today) break;
      const n = counts.get(dayKey(d)) || 0, lv = n ? Math.ceil((n / max) * 4) : 0;
      root._tips.push(`<div class="h">${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</div><div class="r"><b>${n}</b> solve${n === 1 ? '' : 's'}</div>`);
      g += `<rect class="cell lv${lv}" data-t="${root._tips.length - 1}" x="${L + c * S}" y="${T + r * S}" width="${C}" height="${C}" rx="3"/>`;
    }
  }
  return `<svg class="chart" width="${L + weeks * S}" height="${T + 7 * S}" role="img" aria-label="Solves per day, last ${weeks} weeks">${g}</svg>`;
}

const legend = (items) => `<div class="legend">${items.map(([c, l, kind]) => `<span><i class="${kind || 'ln'}" style="--c:${c}"></i>${l}</span>`).join('')}</div>`;

// Renders tiles and charts into root; widths are measured after the skeleton is in the DOM
function renderInsights(root, list, m) {
  root._args = [list, m];
  root._tips = [];
  root._prog = null;
  if (!list.length) { root.innerHTML = ''; return; }
  const chron = list.slice().reverse();
  const s = series(chron, m);
  const wide = root.clientWidth >= 640;
  root.innerHTML = `<div class="ins-tiles">${insightTiles(m, chron, s)}</div>
    <div class="card ins-chart"><div class="card-head"><h2>Progression</h2>${legend([['var(--dim)', 'solve', 'dt'], ['var(--b)', s.label], ['var(--y)', 'PB']])}</div><div class="plot" data-k="prog"></div></div>
    <div class="ins-grid${wide ? ' two' : ''}">
      <div class="card ins-chart"><div class="card-head"><h2>${m === 'bld' ? 'Memo vs exec' : 'Distribution'}</h2>${m === 'bld' ? legend([['var(--b)', 'memo', 'sq'], ['var(--g)', 'exec', 'sq'], ['var(--dim)', 'faded = DNF', 'sq dim']]) : ''}</div><div class="plot" data-k="${m === 'bld' ? 'memo' : 'hist'}"></div></div>
      <div class="card ins-chart"><div class="card-head"><h2>Activity</h2><div class="legend heat">less${[0, 1, 2, 3, 4].map((l) => `<i class="lv${l}"></i>`).join('')}more</div></div><div class="plot" data-k="act"></div></div>
    </div><div class="tip" hidden></div>`;
  for (const el of root.querySelectorAll('.plot')) {
    const w = Math.max(220, el.clientWidth || 600);
    el.innerHTML = { prog: () => progressSvg(root, chron, s, w), hist: () => histSvg(root, s, w), memo: () => memoSvg(root, chron, w), act: () => activitySvg(root, chron, w) }[el.dataset.k]();
  }
}

function showTip(root, html, e) {
  const tip = root.querySelector('.tip'), box = root.getBoundingClientRect();
  tip.innerHTML = html;
  tip.hidden = false;
  let left = e.clientX - box.left + 14;
  if (left + tip.offsetWidth > box.width) left = e.clientX - box.left - tip.offsetWidth - 14;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${e.clientY - box.top - tip.offsetHeight - 12}px`;
}
function hideTip(root) {
  const tip = root.querySelector('.tip');
  if (tip) tip.hidden = true;
  root.querySelector('.xh')?.setAttribute('visibility', 'hidden');
  root.querySelector('.hover')?.classList.remove('hover');
}
function onInsightPointer(e) {
  const root = e.currentTarget;
  const hit = e.target.closest?.('[data-t], [data-prog]');
  root.querySelector('.hover')?.classList.remove('hover');
  if (!hit) { hideTip(root); return; }
  if (hit.hasAttribute('data-t')) {
    if (hit.classList.contains('cell')) hit.classList.add('hover');
    else if (hit.previousElementSibling?.matches('.bar, g')) hit.previousElementSibling.classList.add('hover');
    return showTip(root, root._tips[hit.dataset.t], e);
  }
  // Crosshair snaps to the nearest solve
  const p = root._prog, svgX = e.clientX - hit.ownerSVGElement.getBoundingClientRect().left;
  const i = Math.max(0, Math.min(p.n - 1, Math.round(((svgX - p.L) / (p.w - p.L - p.R)) * (p.n - 1))));
  const xh = root.querySelector('.xh');
  xh.setAttribute('x1', p.x(i)); xh.setAttribute('x2', p.x(i)); xh.setAttribute('visibility', 'visible');
  const sv = p.chron[i], f = (v) => (v === null ? '-' : fmt(v));
  showTip(root, `<div class="h">#${i + 1} · ${fmtDate(sv.created_at)}</div>${tipRow('var(--text)', fmtSolve(sv), 'solve')}${tipRow('var(--b)', f(p.s.avg[i]), p.s.label)}${tipRow('var(--y)', f(p.s.pb[i]), 'PB')}`, e);
}
for (const id of ['insights', 'profile-insights']) {
  const root = $(id);
  root.addEventListener('pointermove', onInsightPointer);
  root.addEventListener('pointerdown', onInsightPointer);
  root.addEventListener('pointerleave', () => hideTip(root));
}
let resizeT = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { for (const id of ['insights', 'profile-insights']) { const r = $(id); if (r._args && r.offsetParent) renderInsights(r, ...r._args); } }, 150);
});

// ---------- sessions (a new one starts after an hour without solves) ----------
const SESSION_GAP = 60 * 60e3;
let showAllSessions = false;
// Newest first, like the solve list
function sessionsOf(list) {
  const out = [];
  for (const s of list) {
    const cur = out.at(-1);
    if (cur && cur.start - s.created_at <= SESSION_GAP) { cur.solves.push(s); cur.start = s.created_at; }
    else out.push({ solves: [s], start: s.created_at, end: s.created_at });
  }
  return out;
}
const fmtClock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
function sessionDay(t) {
  const d = new Date(t), now = new Date(), y = new Date(); y.setDate(y.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}
const sessionLabel = (ss) => `${sessionDay(ss.start)} · ${fmtClock(ss.start)}${ss.end - ss.start >= 60e3 ? `–${fmtClock(ss.end)}` : ''}`;
function bestRolling(n, list) {
  let best = null;
  for (let i = 0; i + n <= list.length; i++) { const a = avgOf(n, list.slice(i, i + n)); if (typeof a === 'number' && (best === null || a < best)) best = a; }
  return best;
}
function sessionSummary(ss, m) {
  const valid = ss.solves.map(eff).filter((v) => v !== null);
  return {
    n: ss.solves.length,
    ok: valid.length,
    best: valid.length ? Math.min(...valid) : null,
    mean: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
    avg: m === 'bld' ? null : bestRolling(5, ss.solves),
  };
}
function renderSessions() {
  const root = $('sessions');
  const all = sessionsOf(solves);
  if (!all.length) { root.innerHTML = ''; return; }
  const f = (v) => (v === null ? '-' : v === 'DNF' ? 'DNF' : fmt(v));
  const [cur, ...past] = all, list = cur.solves, sum = sessionSummary(cur, mode);
  const live = Date.now() - cur.end <= SESSION_GAP;
  const tiles = mode === 'bld'
    ? [['Solves', sum.n], ['Success', `${sum.ok}/${sum.n}`], ['Best', f(sum.best)], ['mo3', f(meanOf(3, list))], ['Mean', f(sum.mean)]]
    : [['Solves', sum.n], ['Best', f(sum.best)], ['ao5', f(avgOf(5, list))], ['ao12', f(avgOf(12, list))], ['Mean', f(sum.mean)]];
  const shown = showAllSessions ? past : past.slice(0, 5);
  const rows = shown.map((ss) => {
    const x = sessionSummary(ss, mode);
    const last = mode === 'bld' ? `${x.ok}/${x.n}` : f(x.avg);
    return `<tr><td>${sessionLabel(ss)}</td><td>${x.n}</td><td>${f(x.best)}</td><td>${f(x.mean)}</td><td>${last}</td></tr>`;
  }).join('');
  root.innerHTML = `<div class="card sess-card">
    <div class="card-head"><h2>${live ? 'Current session' : 'Last session'}</h2><span class="sess-when">${sessionLabel(cur)}</span></div>
    <div class="sess-cur">${tiles.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
    ${past.length ? `<div class="sess-table"><table><thead><tr><th>Earlier sessions</th><th>Solves</th><th>Best</th><th>Mean</th><th>${mode === 'bld' ? 'Success' : 'Best ao5'}</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${past.length > 5 ? `<button type="button" class="sess-more">${showAllSessions ? 'Show fewer' : `Show all ${past.length}`}</button>` : ''}` : ''}
    <p class="sess-note">A new session starts automatically after an hour without solves.</p>
  </div>`;
}
$('sessions').onclick = (e) => { if (e.target.closest('.sess-more')) { showAllSessions = !showAllSessions; renderSessions(); } };

// ---------- alg trainer ----------
const caseById = (set, id) => ALGS[set].find((c) => c[0] === id);
const diagrams = new Map();
function caseSvg(set, id, size) {
  const k = `${set}:${id}:${size}`;
  if (!diagrams.has(k)) {
    const [, , alg, style] = caseById(set, id);
    const state = Cube.apply(Cube.solved(), Cube.fmtMoves(Cube.invert(Cube.faceMoves(alg))));
    diagrams.set(k, Cube.llSvg(state, style || (set.startsWith('oll') ? 'oll' : 'pll'), size));
  }
  return diagrams.get(k);
}
function loadSel(set) {
  try { const v = JSON.parse(localStorage.getItem('train-sel-' + set)); if (Array.isArray(v)) return new Set(v); } catch { /* fall through */ }
  return new Set(ALGS[set].map((c) => c[0]));
}
const trainSel = Object.fromEntries([...TRAIN].map((set) => [set, loadSel(set)]));
const saveSel = (set) => localStorage.setItem('train-sel-' + set, JSON.stringify([...trainSel[set]]));
// Per case: attempts, best, mean of the last 5 successes, DNFs
function caseStats(list) {
  const by = new Map();
  for (const s of list) if (s.case_id) (by.get(s.case_id) || by.set(s.case_id, []).get(s.case_id)).push(s);
  const out = new Map();
  for (const [id, arr] of by) {
    const ok = arr.map(eff).filter((v) => v !== null), recent = ok.slice(0, 5);
    out.set(id, { n: arr.length, dnf: arr.length - ok.length, best: ok.length ? Math.min(...ok) : null, avg: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null });
  }
  return out;
}
// Weighted pick: untried and slow cases come up more, never the same case twice in a row
function pickCase() {
  const sel = ALGS[mode].filter((c) => trainSel[mode].has(c[0]));
  const cases = sel.length ? sel : ALGS[mode];
  const st = caseStats(solves), avgs = [...st.values()].map((x) => x.avg).filter((v) => v !== null);
  const mean = avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : 1;
  const w = cases.map(([id]) => {
    if (id === trainCase && cases.length > 1) return 0;
    const x = st.get(id);
    return !x || x.avg === null ? 2.5 : Math.min(4, (x.avg / mean) ** 2) + (x.dnf ? 0.5 : 0);
  });
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  return cases.find((_, i) => (r -= w[i]) <= 0) || cases.at(-1);
}
function renderCaseGrid() {
  const sel = trainSel[mode], total = ALGS[mode].length;
  $('train-pick').textContent = `Choose cases (${sel.size || total}/${total})`;
  $('train-count').textContent = sel.size ? `${sel.size} of ${total} selected` : `None selected: drilling all ${total}`;
  if ($('train-cases').hidden) return;
  $('train-grid').innerHTML = ALGS[mode].map(([id, name]) => `<button type="button" class="case" data-case="${id}" aria-pressed="${sel.has(id)}">${caseSvg(mode, id, 64)}<span>${name}</span></button>`).join('');
}
function renderTrainer() {
  segSelect('train-set', 'set', mode);
  renderCaseGrid();
  const st = caseStats(solves), f = (v) => (v === null ? 'DNF' : fmt(v));
  const rows = ALGS[mode].filter(([id]) => st.has(id)).map(([id, name, alg]) => ({ id, name, alg, ...st.get(id) }))
    .sort((a, b) => (b.avg ?? 1e12) - (a.avg ?? 1e12));
  const valid = solves.map(eff).filter((v) => v !== null);
  const mean = valid.length ? fmt(valid.reduce((a, b) => a + b, 0) / valid.length) : '-';
  const root = $('train-stats');
  root.innerHTML = `<div class="stats three">
      <div class="stat"><span>Attempts</span><b>${solves.length}</b></div>
      <div class="stat"><span>Cases seen</span><b>${st.size}/${ALGS[mode].length}</b></div>
      <div class="stat"><span>Mean</span><b>${mean}</b></div>
    </div>
    ${rows.length ? `<div class="card"><div class="card-head"><h2>Your cases, slowest first</h2><span class="sess-when">mean of last 5</span></div>
    <ul class="case-rows">${rows.map((r) => `<li>${caseSvg(mode, r.id, 44)}<div class="cr-name"><b>${r.name}</b><code>${esc(r.alg)}</code></div>
      <span class="cr-n">${r.n}×${r.dnf ? ` · ${r.dnf} DNF` : ''}</span><span class="cr-best">best ${r.best === null ? '-' : fmt(r.best)}</span><b class="cr-avg">${f(r.avg)}</b></li>`).join('')}</ul></div>` : ''}`;
}
function showTrainLast(s) {
  const c = caseById(s.mode, s.case_id);
  if (!c) return;
  const el = $('train-last');
  el.hidden = false;
  el.innerHTML = `<div class="card tl">${caseSvg(s.mode, c[0], 76)}<div class="tl-body"><span>That was</span><b>${c[1]}</b><div class="alg moves" data-start="${esc(Cube.fmtMoves(Cube.invert(Cube.faceMoves(c[2]))))}">${chips(c[2])}</div></div><b class="tl-time">${fmtSolve(s)}</b></div>`;
}
$('train-set').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.set === mode) return;
  trainSet = b.dataset.set;
  localStorage.setItem('train-set', trainSet);
  setMode(trainSet);
};
$('train-pick').onclick = () => {
  const open = $('train-cases').hidden;
  $('train-cases').hidden = !open;
  $('train-pick').setAttribute('aria-expanded', String(open));
  renderCaseGrid();
};
$('train-grid').onclick = (e) => {
  const b = e.target.closest('[data-case]');
  if (!b) return;
  const sel = trainSel[mode], id = b.dataset.case;
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  saveSel(mode);
  renderCaseGrid();
};
const setSel = (ids) => { trainSel[mode] = new Set(ids); saveSel(mode); renderCaseGrid(); newScramble(); };
$('train-all').onclick = () => setSel(ALGS[mode].map((c) => c[0]));
$('train-none').onclick = () => setSel([]);
$('train-slow').onclick = () => {
  const st = caseStats(solves);
  setSel(ALGS[mode].map((c) => c[0]).sort((a, b) => (st.get(b)?.avg ?? 1e12) - (st.get(a)?.avg ?? 1e12)).slice(0, 5));
};

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && url.startsWith('/api/solves')) { showAuth(); throw new Error('Logged out'); }
  if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => ({}))).error || res.statusText), { status: res.status });
  return res.json();
}
const cacheKey = (m) => `solves:${$('who').textContent}:${m}`;
async function load() {
  const m = mode;
  let list;
  try {
    list = await api('GET', `/api/solves?mode=${m}`);
    try { localStorage.setItem(cacheKey(m), JSON.stringify(list.slice(0, 2000))); } catch { /* storage full */ }
  } catch (e) {
    // Offline or mid-deploy: show the last copy we saw
    if (e.status === 401) throw e;
    try { list = JSON.parse(localStorage.getItem(cacheKey(m))); } catch { list = null; }
    if (!list) throw e;
  }
  if (m !== mode) return; // tab switched while loading
  // Keep queued solves that haven't reached the server yet on top
  const saved = new Set(list.map((s) => s.client_id).filter(Boolean));
  solves = [...pendingFor(m).filter((p) => !saved.has(p.client_id)), ...list];
  render();
}

// ---------- list ----------
function solveItem(s, n, isPb) {
  const li = document.createElement('li');
  if (isPb) li.className = 'pb';
  li.title = s.scramble;
  const cls = s.penalty === 'DNF' ? 'dnf' : s.penalty === '+2' ? 'p2' : '';
  const sub = [];
  if (s.memo_ms != null) sub.push(`memo ${fmt(s.memo_ms)} · exec ${fmt(s.time_ms - s.memo_ms)}`);
  if (s.edges || s.corners) {
    sub.push(`<span class="e">${esc(s.edges || '–')}</span> | <span class="c">${esc(s.corners || '–')}</span>`);
    const chk = memoCheck(s);
    if (chk) sub.push(chk.ok ? '<span class="memo-ok">memo ✓</span>' : `<span class="memo-bad">memo ✗ · should be ${chk.e} | ${chk.c}</span>`);
  }
  if (s.case_id) { const c = caseById(s.mode, s.case_id); if (c) sub.push(`<span class="case-name">${c[1]}</span>`); }
  li.innerHTML = `<span class="n">${n}.</span><div class="tm"><span class="t ${cls}">${fmtSolve(s)}</span>${sub.length ? `<span class="sub">${sub.join(' · ')}</span>` : ''}</div>`;
  return li;
}
function render() {
  if (isTrain()) renderTrainer();
  else {
    renderStats();
    renderInsights($('insights'), solves, mode);
    renderSessions();
  }
  const ul = $('list');
  if (!solves.length) { ul.innerHTML = '<li class="empty">No solves yet</li>'; return; }
  ul.innerHTML = '';
  const pb = isTrain() ? null : bestSolve();
  // Session dividers above the newest solve of each session
  const starts = new Map(isTrain() ? [] : sessionsOf(solves).map((ss) => [ss.solves[0], ss]));
  solves.forEach((s, i) => {
    const ss = starts.get(s);
    if (ss) {
      const x = sessionSummary(ss, mode);
      ul.insertAdjacentHTML('beforeend', `<li class="sess-div"><span>${sessionLabel(ss)}</span><span>${x.n} solve${x.n === 1 ? '' : 's'}${x.mean === null ? '' : ` · mean ${fmt(x.mean)}`}</span></li>`);
    }
    const li = solveItem(s, solves.length - i, s === pb);
    if (s.pending) {
      li.classList.add('pending');
      li.insertAdjacentHTML('beforeend', '<span class="pending-tag" title="Will be saved when the server is reachable">saving…</span>');
      ul.appendChild(li);
      return;
    }
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
    del.onclick = async () => {
      const c = s.case_id && caseById(s.mode, s.case_id);
      const what = `${fmtSolve(s)}${c ? ` (${c[1]})` : ''} from ${sessionDay(s.created_at).replace(/^(Today|Yesterday)$/, (d) => d.toLowerCase())} at ${fmtClock(s.created_at)}`;
      if (await askConfirm('Delete this solve?', `${what} will be removed for good. This can't be undone.`)) removeSolve(s.id);
    };
    li.appendChild(del);
    ul.appendChild(li);
  });
}
// Guests keep solves in memory per mode only; nothing is sent to the server
const guestSolves = {};
let guestId = 0;
const isGuest = () => document.body.dataset.auth === 'guest';
async function setPenalty(id, penalty) {
  if (isGuest()) { solves = guestSolves[mode] = solves.map((s) => (s.id === id ? { ...s, penalty } : s)); render(); return; }
  try {
    const upd = await api('PATCH', `/api/solves/${id}`, { penalty });
    solves = solves.map((s) => (s.id === id ? upd : s));
    render();
  } catch (e) { alert(e.message); }
}
async function removeSolve(id) {
  if (isGuest()) { solves = guestSolves[mode] = solves.filter((s) => s.id !== id); render(); return; }
  try { await api('DELETE', `/api/solves/${id}`); solves = solves.filter((s) => s.id !== id); render(); }
  catch (e) { alert(e.message); }
}
// In-app confirm; resolves true only when the confirm button is pressed
function askConfirm(title, text, yes = 'Delete') {
  const dlg = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-yes').textContent = yes;
  dlg.returnValue = '';
  dlg.showModal();
  $('confirm-no').focus();
  return new Promise((done) => dlg.addEventListener('close', () => done(dlg.returnValue === 'yes'), { once: true }));
}
$('confirm-yes').onclick = () => $('confirm-dialog').close('yes');
$('confirm-no').onclick = () => $('confirm-dialog').close();
$('confirm-dialog').addEventListener('click', (e) => { if (e.target === $('confirm-dialog')) $('confirm-dialog').close(); });

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

// Memo checking against the scramble (Old Pochmann, Speffz, white top green front)
const pairUp = (t) => (t.match(/.{1,2}/g) || []).join(' ') || '–';
const memoCache = new Map();
function memoCheck(s) {
  if (s.mode !== 'bld' || !s.scramble) return null;
  const k = `${s.scramble}|${s.edges}|${s.corners}`;
  if (!memoCache.has(k)) {
    try {
      const e = letters(s.edges || ''), c = letters(s.corners || '');
      const ok = Cube.memoSolves(s.scramble, 'e', e) && Cube.memoSolves(s.scramble, 'c', c);
      memoCache.set(k, { ok, e: pairUp(Cube.memo(s.scramble, 'e')), c: pairUp(Cube.memo(s.scramble, 'c')) });
    } catch { memoCache.set(k, null); } // unparseable scramble
  }
  return memoCache.get(k);
}
// The reveal button toggles, so its label follows whether the solution is what's on screen
function setRevealLabel(open) {
  $('memo-reveal').dataset.open = open ? '1' : '';
  $('memo-reveal').textContent = open ? 'Hide solution' : 'Show solution';
}
function hideMemoResult() {
  $('memo-result').hidden = true;
  setRevealLabel(false);
}
function showMemoResult(html, solution = false) {
  const el = $('memo-result');
  el.innerHTML = html;
  el.hidden = false;
  setRevealLabel(solution);
}
$('memo-verify').onclick = () => {
  const e = letters(memoInputs.edges.value), c = letters(memoInputs.corners.value);
  if (!e && !c) return showMemoResult('Type your memo first.');
  const okE = Cube.memoSolves(scramble, 'e', e), okC = Cube.memoSolves(scramble, 'c', c);
  const tag = (ok, label) => `<span class="${ok ? 'memo-ok' : 'memo-bad'}">${ok ? '✓' : '✗'} ${label}</span>`;
  showMemoResult(`${tag(okE, 'Edges')} ${tag(okC, 'Corners')}${okE && okC ? '<small>Your memo solves this scramble.</small>' : '<small>Wrong pieces or order. Try again, or show the solution.</small>'}`);
};
$('memo-reveal').onclick = () => {
  if ($('memo-reveal').dataset.open) return hideMemoResult();
  const e = Cube.memo(scramble, 'e'), c = Cube.memo(scramble, 'c');
  showMemoResult(`<span class="memo-sol e">Edges <b>${pairUp(e)}</b></span><span class="memo-sol c">Corners <b>${pairUp(c)}</b></span>
    <small>${e.length % 2 ? 'Parity needed. ' : ''}Buffers UR and ULB; cycle breaks go to the lowest free letter, so yours may differ and still be right.</small>`, true);
};
$('parity-alg').innerHTML = chips(PARITY_ALG);
$('edge-alg').innerHTML = chips(EDGE_ALG);
$('corner-alg').innerHTML = chips(CORNER_ALG);

// ---------- timer ----------
// Mid-solve the timer block is pinned to the exact centre of the screen; a spacer keeps the page from reflowing
const stage = timerEl.parentElement;
const stageSpacer = document.createElement('div');
function pinTimer(on) {
  if (on === document.body.classList.contains('pinned')) return;
  if (on) {
    timerEl.scrollIntoView({ block: 'center' });
    const r = stage.getBoundingClientRect();
    stageSpacer.style.height = `${r.height}px`;
    Object.assign(stage.style, { left: `${r.left}px`, width: `${r.width}px`, top: `calc(50% - ${timerEl.offsetTop + timerEl.offsetHeight / 2}px)` });
    stage.before(stageSpacer);
  } else {
    stageSpacer.remove();
    Object.assign(stage.style, { left: '', width: '', top: '' });
  }
  document.body.classList.toggle('pinned', on);
  if (!on) timerEl.scrollIntoView({ block: 'center' });
}
const setState = (s) => {
  if (['holding', 'ready', 'inspecting', 'running'].includes(s)) closeViewer();
  state = s;
  document.body.dataset.state = s;
  pinTimer(['holding', 'ready', 'inspecting', 'running'].includes(s));
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
  if (isTrain()) body.case_id = trainCase;
  const ch = mode === '333' ? challenge : null;
  if (ch) { challenge = null; showBanner(); }
  if (mode === 'bld') {
    body.memo_ms = memoAt;
    body.edges = memoInputs.edges.value;
    body.corners = memoInputs.corners.value;
    setSplit(memoAt === null ? '' : `memo ${fmt(memoAt)} · exec ${fmt(ms - memoAt)}`);
  }
  newScramble();
  // Queue first so the solve survives a failed request, a deploy or a reload
  const guest = isGuest();
  const p = guest ? { ...body, id: --guestId, created_at: Date.now() }
    : { ...body, client_id: newClientId(), created_at: Date.now(), user: $('who').textContent, pending: true };
  const prevBest = isTrain() ? null : bestSolve();
  isPb = eff(p) !== null && prevBest && eff(p) < eff(prevBest);
  if (!guest) savePending([...loadPending(), p]);
  solves.unshift(p);
  if (guest) guestSolves[mode] = solves;
  render();
  if (mode === 'bld') clearMemo();
  if (p.penalty === 'DNF') timerEl.textContent = 'DNF';
  else if (p.penalty === '+2') timerEl.textContent = fmt(ms + 2000) + '+';
  setState('idle');
  if (isPb) { void timerEl.offsetWidth; timerEl.classList.add('pb'); isPb = false; }
  if (isTrain()) showTrainLast(p);
  if (ch && guest) {
    saveGuestDaily({ day: ch.code.slice(6), time_ms: ms, penalty: p.penalty });
    openDaily();
  } else if (ch) queueChallenge(ch.code, { time_ms: ms, penalty: p.penalty }, true);
  if (!guest) flushPending();
}

// ---------- offline-safe saving ----------
const PENDING_KEY = 'pending-solves';
const newClientId = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
function loadPending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch { return []; } }
const savePending = (list) => localStorage.setItem(PENDING_KEY, JSON.stringify(list));
const pendingFor = (m) => loadPending().filter((p) => p.user === $('who').textContent && p.mode === m).reverse();
let flushing = false, retryT = 0, retryDelay = 2000;
async function flushPending() {
  flushChallenges();
  if (flushing || !authed()) return;
  flushing = true;
  clearTimeout(retryT);
  const me = $('who').textContent;
  try {
    for (const p of loadPending().filter((x) => x.user === me)) {
      const { pending, user, ...body } = p;
      let saved;
      try { saved = await api('POST', '/api/solves', body); }
      catch (e) {
        // A 4xx (other than auth/rate limits) will never succeed; drop it instead of retrying forever
        if (e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status)) {
          savePending(loadPending().filter((x) => x.client_id !== p.client_id));
          solves = solves.filter((s) => s.client_id !== p.client_id);
          render();
          alert('Could not save solve: ' + e.message);
          continue;
        }
        retryT = setTimeout(flushPending, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
        return;
      }
      savePending(loadPending().filter((x) => x.client_id !== p.client_id));
      const i = solves.findIndex((s) => s.client_id === p.client_id);
      if (i >= 0) solves[i] = saved;
      else if (saved.mode === mode && !solves.some((s) => s.id === saved.id)) solves.unshift(saved); // list reloaded mid-save
      render();
    }
    retryDelay = 2000;
  } finally { flushing = false; }
}
window.addEventListener('online', () => { retryDelay = 2000; flushPending(); refreshDaily(); });

// Challenge results queue the same way, so a daily attempt survives going offline
const CH_KEY = 'pending-challenges';
let chOpenAfter = null, chFlushing = false;
function loadChQueue() { try { return JSON.parse(localStorage.getItem(CH_KEY)) || []; } catch { return []; } }
const saveChQueue = (list) => localStorage.setItem(CH_KEY, JSON.stringify(list));
function queueChallenge(code, body, open) {
  saveChQueue([...loadChQueue(), { code, ...body, user: $('who').textContent }]);
  if (open) chOpenAfter = code;
}
async function flushChallenges() {
  if (chFlushing || !authed()) return;
  chFlushing = true;
  const me = $('who').textContent;
  try {
    for (const x of loadChQueue().filter((c) => c.user === me)) {
      let view;
      try { view = await api('POST', `/api/challenges/${x.code}/result`, { time_ms: x.time_ms, penalty: x.penalty }); }
      catch (e) {
        if (!(e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status))) return; // retried with the solve queue
        alert(`Could not submit to the ${x.code.startsWith('daily-') ? 'daily scramble' : 'race'}: ${e.message}`);
      }
      saveChQueue(loadChQueue().filter((c) => !(c.code === x.code && c.user === me)));
      if (view?.kind === 'daily') updateDaily(view);
      if (view && chOpenAfter === x.code) { chOpenAfter = null; openChallenge(view); }
    }
  } finally { chFlushing = false; }
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
// Timer only listens on the timer tabs with no dialog open
const timerActive = () => (authed() || isGuest()) && document.body.dataset.mode !== 'board' && !document.querySelector('dialog[open]');
document.addEventListener('keydown', (e) => {
  if (mvSrc && state === 'idle' && !typing() && !document.querySelector('dialog[open]')) {
    const act = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'first', End: 'last', Escape: 'close' }[e.key];
    if (act) { e.preventDefault(); stepViewer(act); return; }
    if (e.key === 'Enter' && e.target.closest?.('.moves > span')) { e.preventDefault(); e.target.click(); return; }
  }
  if (!timerActive()) return;
  // Auto-repeat while holding space would otherwise scroll the page
  if (e.repeat) { if (e.code === 'Space' && !typing()) e.preventDefault(); return; }
  if (state === 'running') { e.preventDefault(); press(); return; }
  if (typing()) { if (e.key === 'Escape' || e.key === 'Enter') document.activeElement.blur(); return; }
  if (['BUTTON', 'INPUT'].includes(document.activeElement?.tagName) && e.code === 'Space' && state === 'idle') {
    document.activeElement.blur();
  }
  if (e.code === 'Space') { e.preventDefault(); press(); }
  else if (e.code === 'Escape' && state === 'inspecting') { clearInterval(inspectTimer); setState('idle'); timerEl.textContent = '0.00'; }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && timerActive() && !typing()) { e.preventDefault(); release(); }
});

// Touch: whole timer area; any touch stops a running timer.
timerEl.addEventListener('touchstart', (e) => { if (timerActive()) { e.preventDefault(); press(); } }, { passive: false });
timerEl.addEventListener('touchend', (e) => { e.preventDefault(); release(); }, { passive: false });
document.addEventListener('touchstart', (e) => { if (state === 'running') { e.preventDefault(); press(); } }, { passive: false });

// ---------- tabs ----------
function setMode(m) {
  if (state !== 'idle' && state !== 'stopped') return;
  if (m === 'board') { showBoard(); return; }
  if (m === 'train') m = trainSet;
  if (m !== '333' && challenge) { challenge = null; showBanner(); }
  mode = m;
  const tab = isTrain() ? 'train' : m;
  document.body.dataset.mode = m;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === tab)));
  history.replaceState(null, '', { bld: '#bld', train: '#train' }[tab] || location.pathname);
  timerEl.textContent = '0.00';
  setSplit('');
  $('train-last').hidden = true;
  solves = [];
  render();
  newScramble();
  if (authed()) load().catch((e) => { $('list').innerHTML = `<li class="empty">Failed to load: ${esc(e.message)}</li>`; });
  else { solves = guestSolves[m] || []; render(); }
}
document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
const modeFromHash = () => ({ '#bld': 'bld', '#leaderboard': 'board', '#train': 'train' })[location.hash] || '333';
window.addEventListener('hashchange', () => {
  if (applyInviteLink() || applyRaceLink() || applyDailyLink()) return;
  setMode(modeFromHash());
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
  $('auth-submit').textContent = { login: 'Log in', register: 'Create account', reset: 'Reset password' }[m];
  $('auth-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('auth-pass-label').textContent = m === 'reset' ? 'New password' : 'Password';
  $('auth-forgot').textContent = m === 'reset' ? 'Back to log in' : 'Forgot password?';
  $('auth-error').textContent = '';
}
$('auth-forgot').onclick = () => setAuthMode(authMode === 'reset' ? 'login' : 'reset');
let meUser = null;
// Use the app without an account; solves stay in memory only
function goGuest() {
  meUser = null;
  localStorage.removeItem('me');
  $('who').textContent = '';
  document.body.dataset.auth = 'guest';
  setMode(modeFromHash() === 'board' ? 'board' : mode);
  $('daily-btn').classList.remove('done');
  refreshDaily();
  applyDailyLink();
}
// Login form; reason explains why (e.g. a race link needs an account)
function showLogin(authView = 'login', reason = '') {
  if (state !== 'idle' && state !== 'stopped') return;
  if (document.body.dataset.auth === 'in') { localStorage.removeItem('me'); solves = []; }
  setAuthMode(authView);
  $('auth-reason').textContent = reason;
  $('auth-reason').hidden = !reason;
  document.body.dataset.auth = 'out';
  window.scrollTo(0, 0);
  setTimeout(() => $('auth-user').focus(), 50);
}
const showAuth = () => showLogin('login', 'Your login expired. Log in again to keep saving solves.');
$('auth-guest').onclick = () => { sessionStorage.removeItem('race-link'); sessionStorage.removeItem('daily-link'); goGuest(); };
$('login-btn').onclick = () => showLogin();
document.addEventListener('click', (e) => { const b = e.target.closest('[data-login]'); if (b) showLogin(b.dataset.login); });
function signedIn(user) {
  meUser = user;
  localStorage.setItem('me', JSON.stringify(user));
  document.body.dataset.auth = 'in';
  $('who').textContent = user.username;
  $('user-btn').textContent = user.username[0].toUpperCase();
  $('auth-pass').value = '';
  $('auth-invite').value = '';
  $('auth-code').value = '';
  setMode(modeFromHash() === 'board' ? 'board' : mode);
  flushPending();
  refreshDaily();
  applyRaceLink();
  applyDailyLink();
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
    if (authMode === 'reset') body.code = $('auth-code').value.trim();
    const { user } = await api('POST', `/api/${authMode}`, body);
    const wasReset = authMode === 'reset';
    setAuthMode('login');
    signedIn(user);
    if (wasReset) openAccount('Password reset. That recovery code is used up, so create a new one.');
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
  for (const k of Object.keys(localStorage)) if (k.startsWith('solves:')) localStorage.removeItem(k);
  goGuest();
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
  const code = (location.hash.match(/^#invite=([A-Za-z0-9_-]+)$/) || [])[1] || sessionStorage.getItem('invite-link');
  if (!code) return false;
  if (location.hash.startsWith('#invite=')) history.replaceState(null, '', location.pathname);
  if (document.body.dataset.auth === 'pending') { sessionStorage.setItem('invite-link', code); return true; } // wait for /api/me
  sessionStorage.removeItem('invite-link');
  if (authed()) return true; // already has an account
  showLogin('register', "You've been invited! Pick a username and password.");
  $('auth-invite').value = code;
  return true;
}

// ---------- password & recovery ----------
function openAccount(note) {
  toggleMenu(false);
  for (const id of ['pw-current', 'pw-new', 'rc-current']) $(id).value = '';
  $('pw-msg').textContent = '';
  $('pw-msg').className = 'auth-error';
  $('rc-msg').textContent = note || '';
  $('rc-msg').className = note ? 'auth-ok' : 'auth-error';
  $('rc-code').hidden = true;
  $('rc-status').textContent = meUser?.hasRecovery
    ? 'You have a recovery code. Making a new one replaces it.'
    : 'With a recovery code you can reset a forgotten password yourself. Store it somewhere safe; it works once.';
  $('rc-submit').textContent = meUser?.hasRecovery ? 'Replace recovery code' : 'Create recovery code';
  $('account-dialog').showModal();
}
$('account-open').onclick = () => openAccount();
$('account-close').onclick = () => $('account-dialog').close();
$('account-dialog').addEventListener('click', (e) => { if (e.target === $('account-dialog')) $('account-dialog').close(); });
$('pw-form').onsubmit = async (e) => {
  e.preventDefault();
  const msg = $('pw-msg');
  try {
    await api('POST', '/api/password', { current: $('pw-current').value, password: $('pw-new').value });
    $('pw-current').value = $('pw-new').value = '';
    msg.className = 'auth-ok';
    msg.textContent = 'Password changed. Other devices are logged out.';
  } catch (err) { msg.className = 'auth-error'; msg.textContent = err.message; }
};
$('rc-form').onsubmit = async (e) => {
  e.preventDefault();
  const msg = $('rc-msg');
  msg.textContent = '';
  try {
    const { code } = await api('POST', '/api/recovery', { current: $('rc-current').value });
    $('rc-current').value = '';
    meUser = { ...meUser, hasRecovery: true };
    localStorage.setItem('me', JSON.stringify(meUser));
    const box = $('rc-code');
    box.innerHTML = `<code>${esc(code)}</code><button type="button">Copy</button>`;
    box.hidden = false;
    box.querySelector('button').onclick = (ev) => navigator.clipboard?.writeText(code).then(() => { ev.target.textContent = 'Copied!'; }).catch(() => {});
    msg.className = 'auth-ok';
    msg.textContent = 'Save this now. It is only shown once.';
    $('rc-submit').textContent = 'Replace recovery code';
  } catch (err) { msg.className = 'auth-error'; msg.textContent = err.message; }
};

// ---------- daily scramble & races ----------
let chView = null, chPoll = 0;
const raceUrl = (code) => `${location.origin}/#race=${code}`;
const resultMs = (r) => (r.penalty === 'DNF' ? null : r.time_ms + (r.penalty === '+2' ? 2000 : 0));
// Finished first (fastest on top, DNFs after), then people still solving
function rankResults(results) {
  return results.slice().sort((a, b) => (b.done - a.done) || ((resultMs(a) ?? 1e12) - (resultMs(b) ?? 1e12)));
}
function showBanner() {
  $('ch-banner').hidden = !challenge;
  $('challenges').hidden = !!challenge;
  if (challenge) $('ch-banner-text').innerHTML = `<b>${challenge.kind === 'daily' ? 'Daily scramble' : 'Race'}</b> · one attempt, it counts when you stop the timer`;
}
function startChallenge(v) {
  $('challenge-dialog').close();
  challenge = { kind: v.kind, code: v.code, scramble: v.scramble };
  if (mode !== '333') setMode('333');
  newScramble();
  showBanner();
  timerEl.textContent = '0.00';
  timerEl.focus();
}
$('ch-cancel').onclick = () => { challenge = null; showBanner(); newScramble(); };

// Guest daily attempts live in localStorage only: one per day, never sent to the server
const GUEST_DAILY = 'guest-daily';
function guestDaily(day) {
  try { const g = JSON.parse(localStorage.getItem(GUEST_DAILY)); return g && g.day === day ? g : null; } catch { return null; }
}
const saveGuestDaily = (g) => localStorage.setItem(GUEST_DAILY, JSON.stringify(g));
// Today's daily; for guests with a local attempt, reveal times and add their row
async function fetchDaily() {
  let v = await api('GET', '/api/daily');
  if (!isGuest()) return v;
  const g = guestDaily(v.day);
  if (!g) return v;
  v = await api('GET', '/api/daily?done=1');
  return { ...v, done: true, results: [...v.results, { username: 'You', me: true, guest: true, done: true, time_ms: g.time_ms, penalty: g.penalty }] };
}
function updateDaily(v) {
  const done = v.results.filter((r) => r.done), mine = v.results.find((r) => r.me && r.done);
  const rank = mine ? rankResults(v.results).indexOf(v.results.find((r) => r.me)) + 1 : 0;
  $('daily-sub').textContent = mine
    ? `You: ${fmtSolve(mine)} · #${rank} of ${done.length}`
    : done.length ? `${done.length} played today · your turn` : 'Same scramble for everyone today';
  $('daily-btn').classList.toggle('done', !!mine);
}
async function refreshDaily() {
  try { updateDaily(await fetchDaily()); } catch { /* offline */ }
}

function renderChallenge() {
  const v = chView, me = $('who').textContent;
  const daily = v.kind === 'daily', allDone = v.results.length > 1 && v.results.every((r) => r.done);
  $('ch-title').textContent = daily ? 'Daily scramble' : `Race${v.created_by ? ` by ${v.created_by}` : ''}`;
  $('ch-sub').textContent = daily
    ? `${new Date(v.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · one attempt each. Times show once you've done yours.${isGuest() ? " You're not logged in, so your result stays on this device and others won't see it." : ''}`
    : v.done ? (allDone ? 'Everyone finished.' : 'Waiting for the others. This updates by itself.') : 'Solve it, then see how everyone did.';
  $('ch-share').hidden = daily;
  $('ch-link').textContent = raceUrl(v.code);
  $('ch-start').hidden = v.done;
  $('ch-start').textContent = daily ? 'Start: one attempt' : 'Start solve';
  $('ch-share-daily').hidden = !daily;
  $('ch-share-daily').textContent = v.done ? 'Share my result' : 'Share with friends';
  const ranked = rankResults(v.results);
  const winner = !daily && allDone && resultMs(ranked[0]) !== null ? ranked[0] : null;
  $('ch-results').innerHTML = ranked.length ? ranked.map((r, i) => {
    const val = r.time_ms !== null ? fmtSolve(r) : r.done ? 'finished' : 'solving…';
    const pen = r.me && r.done ? ['+2', 'DNF'].map((p) => `<button type="button" data-pen="${p}" class="${r.penalty === p ? 'on' : ''}">${p}</button>`).join('') : '';
    return `<li class="${r.me ? 'me' : ''}${r === winner ? ' win' : ''}">
      <span class="rank">${r.done && r.time_ms !== null ? i + 1 : '·'}</span>
      <span class="ch-who"><span class="avatar static">${esc(r.username[0].toUpperCase())}</span>${esc(r.username)}${r.username === me ? ' (you)' : ''}${r.guest ? ' <small class="ch-guest">not saved</small>' : ''}${r === winner ? ' 🏆' : ''}</span>
      ${pen}<b class="val ${r.time_ms === null ? 'wait' : ''}">${val}</b></li>`;
  }).join('') : '<li class="empty">Nobody has done this one yet</li>';
}
async function openChallenge(v) {
  chView = v;
  $('ch-error').textContent = '';
  renderChallenge();
  if (!$('challenge-dialog').open) $('challenge-dialog').showModal();
  clearInterval(chPoll);
  chPoll = setInterval(async () => {
    if (!$('challenge-dialog').open) { clearInterval(chPoll); return; }
    try { chView = isGuest() ? await fetchDaily() : await api('GET', `/api/challenges/${chView.code}`); renderChallenge(); } catch { /* keep last view */ }
  }, 4000);
}
$('ch-close').onclick = () => $('challenge-dialog').close();
$('challenge-dialog').addEventListener('click', (e) => { if (e.target === $('challenge-dialog')) $('challenge-dialog').close(); });
$('challenge-dialog').addEventListener('close', () => clearInterval(chPoll));
$('ch-start').onclick = () => startChallenge(chView);
$('ch-copy').onclick = async () => {
  const url = raceUrl(chView.code);
  try {
    if (navigator.share) await navigator.share({ title: 'Cube Timer race', text: 'Race me on this scramble', url });
    else { await navigator.clipboard.writeText(url); $('ch-copy').textContent = 'Copied!'; setTimeout(() => { $('ch-copy').textContent = 'Copy'; }, 1500); }
  } catch { /* share sheet dismissed */ }
};
$('ch-results').onclick = async (e) => {
  const b = e.target.closest('[data-pen]');
  if (!b) return;
  const mine = chView.results.find((r) => r.me);
  const penalty = mine.penalty === b.dataset.pen ? null : b.dataset.pen;
  if (mine.guest) {
    saveGuestDaily({ ...guestDaily(chView.day), penalty });
    mine.penalty = penalty;
    renderChallenge();
    updateDaily(chView);
    return;
  }
  try {
    chView = await api('PATCH', `/api/challenges/${chView.code}/result`, { penalty });
    renderChallenge();
    if (chView.kind === 'daily') updateDaily(chView);
  } catch (err) { $('ch-error').textContent = err.message; }
};

async function openDaily() {
  try {
    const v = await fetchDaily();
    updateDaily(v);
    openChallenge(v);
  } catch (e) { alert(e.message); }
}
$('daily-btn').onclick = openDaily;
// Wordle-style share: your time and rank once done, otherwise an invite to play
function dailyShareText(v) {
  const day = new Date(v.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const mine = v.results.find((r) => r.me && r.done);
  if (!mine) return `Today's Cube Timer daily scramble (${day}): one attempt, same scramble for everyone. Join me!`;
  const done = v.results.filter((r) => r.done).length;
  const rank = rankResults(v.results).indexOf(mine) + 1;
  const time = mine.penalty === 'DNF' ? 'DNF 😬' : `⏱ ${fmtSolve(mine)}`;
  return `Cube Timer daily · ${day}\n${time}${mine.penalty === 'DNF' ? '' : ` · #${rank} of ${done}${rank === 1 ? ' 🏆' : ''}`}\nCan you beat it?`;
}
$('ch-share-daily').onclick = async () => {
  const btn = $('ch-share-daily'), text = dailyShareText(chView), url = `${location.origin}/#daily`;
  try {
    if (navigator.share) await navigator.share({ title: 'Cube Timer daily scramble', text, url });
    else {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      const label = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = label; }, 1500);
    }
  } catch { /* share sheet dismissed */ }
};
// #daily links open today's daily, after logging in if needed
function applyDailyLink() {
  const linked = location.hash === '#daily' || sessionStorage.getItem('daily-link');
  if (!linked) return false;
  if (location.hash === '#daily') history.replaceState(null, '', location.pathname);
  if (document.body.dataset.auth === 'pending') { sessionStorage.setItem('daily-link', '1'); return true; } // wait for /api/me
  sessionStorage.removeItem('daily-link');
  if (mode !== '333') setMode('333');
  openDaily();
  return true;
}
async function loadRaces() {
  const ul = $('race-list');
  try {
    const list = await api('GET', '/api/races');
    if (!list.length) { ul.innerHTML = '<li class="empty">No races yet. Start one and send the link to a friend.</li>'; return; }
    ul.innerHTML = list.map((r) => {
      const status = !r.done ? ['Your turn', 'turn'] : r.finished < r.players ? ['Waiting', 'wait'] : ['Done', 'done'];
      return `<li><button type="button" class="race-row" data-code="${esc(r.code)}">
        <span class="race-st ${status[1]}">${status[0]}</span>
        <span class="race-info"><b>${r.created_by === $('who').textContent ? 'Your race' : `${esc(r.created_by || '?')}'s race`}</b><small>${fmtDate(r.created_at)} · ${r.finished}/${r.players} finished</small></span></button></li>`;
    }).join('');
  } catch (e) { $('race-error').textContent = e.message; }
}
$('race-btn').onclick = () => {
  if (isGuest()) return showLogin('login', 'Log in or sign up to race your friends.');
  $('race-error').textContent = '';
  $('race-dialog').showModal();
  loadRaces();
};
$('race-close').onclick = () => $('race-dialog').close();
$('race-dialog').addEventListener('click', (e) => { if (e.target === $('race-dialog')) $('race-dialog').close(); });
$('race-create').onclick = async () => {
  try { const v = await api('POST', '/api/races'); $('race-dialog').close(); openChallenge(v); }
  catch (e) { $('race-error').textContent = e.message; }
};
$('race-list').onclick = async (e) => {
  const b = e.target.closest('[data-code]');
  if (!b) return;
  try { const v = await api('GET', `/api/challenges/${b.dataset.code}`); $('race-dialog').close(); openChallenge(v); }
  catch (err) { $('race-error').textContent = err.message; }
};
// Race links (#race=CODE) join the race, after logging in if needed
function applyRaceLink() {
  const code = (location.hash.match(/^#race=([A-Za-z0-9_-]{6,32})$/) || [])[1] || sessionStorage.getItem('race-link');
  if (!code) return false;
  if (location.hash.startsWith('#race=')) history.replaceState(null, '', location.pathname);
  if (!authed()) {
    sessionStorage.setItem('race-link', code);
    if (isGuest()) showLogin('login', "You've been challenged to a race! Log in or sign up to join.");
    return true;
  }
  sessionStorage.removeItem('race-link');
  api('POST', `/api/challenges/${code}/join`).then(openChallenge).catch((e) => alert(e.message));
  return true;
}

// ---------- leaderboard & profiles ----------
const CATS = {
  333: [['single', 'Single'], ['ao5', 'ao5'], ['ao12', 'ao12']],
  bld: [['single', 'Single'], ['mo3', 'mo3'], ['success', 'Success rate']],
};
let boardEvent = '333';
let boardCat = 'single';
let boardRows = [];
const segSelect = (id, attr, val) => document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute('aria-selected', String(b.dataset[attr] === val)));

function showBoard() {
  document.body.dataset.mode = 'board';
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === 'board')));
  history.replaceState(null, '', '#leaderboard');
  loadBoard();
}
async function loadBoard() {
  const ev = boardEvent;
  segSelect('board-event', 'event', ev);
  $('board-cat').innerHTML = CATS[ev].map(([k, label]) => `<button type="button" data-cat="${k}" aria-pressed="${k === boardCat}">${label}</button>`).join('');
  try {
    const { users } = await api('GET', `/api/leaderboard?mode=${ev}`);
    if (ev !== boardEvent) return;
    boardRows = users;
    renderBoard();
  } catch (e) { $('board-list').innerHTML = `<li class="empty">Failed to load: ${esc(e.message)}</li>`; }
}
function renderBoard() {
  const cat = boardCat;
  let rows;
  if (cat === 'success') {
    rows = boardRows.filter((u) => u.solves).map((u) => ({ ...u, rate: u.successes / u.solves }))
      .sort((a, b) => b.rate - a.rate || b.successes - a.successes);
  } else {
    rows = boardRows.filter((u) => u[cat] != null).sort((a, b) => a[cat] - b[cat]);
  }
  const ol = $('board-list');
  if (!rows.length) { ol.innerHTML = '<li class="empty">Nobody has a result here yet. Be the first!</li>'; return; }
  const me = $('who').textContent;
  ol.innerHTML = rows.map((u, i) => {
    const value = cat === 'success' ? `${Math.round(u.rate * 100)}%` : fmt(u[cat]);
    const extra = cat === 'success' ? `${u.successes}/${u.solves} solved` : `${u.solves} solve${u.solves === 1 ? '' : 's'}`;
    return `<li class="${u.username === me ? 'me' : ''}${i < 3 ? ' top top' + (i + 1) : ''}">
      <span class="rank">${i + 1}</span>
      <button type="button" class="who-link" data-user="${esc(u.username)}"><span class="avatar static">${esc(u.username[0].toUpperCase())}</span>${esc(u.username)}</button>
      <span class="extra">${extra}</span>
      <b class="val">${value}</b>
    </li>`;
  }).join('');
}
$('board-event').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  boardEvent = b.dataset.event;
  boardCat = 'single';
  loadBoard();
};
$('board-cat').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  boardCat = b.dataset.cat;
  document.querySelectorAll('#board-cat button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderBoard();
};
$('board-list').onclick = (e) => { const b = e.target.closest('.who-link'); if (b) openProfile(b.dataset.user, boardEvent); };

let profileUser = '';
async function openProfile(username, ev) {
  profileUser = username;
  $('profile-user').textContent = username;
  $('profile-avatar').textContent = username[0].toUpperCase();
  if (!$('profile-dialog').open) $('profile-dialog').showModal();
  segSelect('profile-event', 'event', ev);
  $('profile-list').innerHTML = '';
  $('profile-stats').innerHTML = '';
  renderInsights($('profile-insights'), [], ev);
  try {
    const data = await api('GET', `/api/users/${encodeURIComponent(username)}/solves?mode=${ev}`);
    if (profileUser !== username) return;
    $('profile-stats').innerHTML = statsHtml(data.solves, ev);
    renderInsights($('profile-insights'), data.solves, ev);
    const ul = $('profile-list');
    if (!data.solves.length) { ul.innerHTML = '<li class="empty">No solves yet</li>'; return; }
    const pb = bestSolve(data.solves);
    data.solves.forEach((s, i) => {
      const li = solveItem(s, data.solves.length - i, s === pb);
      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = new Date(s.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      li.appendChild(date);
      ul.appendChild(li);
    });
  } catch (e) { $('profile-list').innerHTML = `<li class="empty">${esc(e.message)}</li>`; }
}
$('profile-event').onclick = (e) => { const b = e.target.closest('button'); if (b) openProfile(profileUser, b.dataset.event); };
$('profile-close').onclick = () => $('profile-dialog').close();
$('profile-dialog').addEventListener('click', (e) => { if (e.target === $('profile-dialog')) $('profile-dialog').close(); });

renderMemo();
setAuthMode('login');
applyInviteLink();
applyRaceLink();
applyDailyLink();
api('GET', '/api/me').then(({ user }) => signedIn(user)).catch((e) => {
  // Offline or server restarting: keep working with the last known account; solves queue until it's back
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('me')); } catch { /* none */ }
  if (cached && e.status !== 401) signedIn(cached);
  else { goGuest(); applyInviteLink(); applyRaceLink(); }
});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
