'use strict';

// Sticker-level 3x3 model. State = array of 54 sticker ids; id / 9 is the home face in URFDLB order.
const Cube = (() => {
  const FACES = 'URFDLB';
  const NORMAL = { U: [0, 1, 0], R: [1, 0, 0], F: [0, 0, 1], D: [0, -1, 0], L: [-1, 0, 0], B: [0, 0, -1] };
  // Cubie position of (row, col) on each face, read as in the standard net
  const GRID = {
    U: (r, c) => [c - 1, 1, r - 1],
    R: (r, c) => [1, 1 - r, 1 - c],
    F: (r, c) => [c - 1, 1 - r, 1],
    D: (r, c) => [c - 1, -1, 1 - r],
    L: (r, c) => [-1, 1 - r, c - 1],
    B: (r, c) => [1 - c, 1 - r, -1],
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // Clockwise quarter turn of v as seen looking at the face with outward normal a
  const rot = (v, a) => { const c = cross(a, v), d = dot(a, v); return [a[0] * d - c[0], a[1] * d - c[1], a[2] * d - c[2]]; };
  const key = (p, n) => `${p.join()}|${n.join()}`;

  const STICKERS = [];
  for (const f of FACES) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) STICKERS.push({ p: GRID[f](r, c), n: NORMAL[f], f });
  const INDEX = new Map(STICKERS.map((s, i) => [key(s.p, s.n), i]));
  const faceOfNormal = (n) => [...FACES].find((f) => NORMAL[f].join() === n.join());
  const solved = () => STICKERS.map((_, i) => i);
  const colorOf = (id) => FACES[Math.floor(id / 9)];

  const perms = new Map();
  function perm(a, layers) {
    const k = a.join() + layers.join();
    if (!perms.has(k)) {
      perms.set(k, STICKERS.map((s, i) => (layers.includes(dot(s.p, a)) ? INDEX.get(key(rot(s.p, a), rot(s.n, a))) : i)));
    }
    return perms.get(k);
  }

  // Move token -> { a: axis normal, layers along a, k: quarter turns }
  function parseMove(tok) {
    const m = /^([UDLRFBudlrfbMESxyz])(w?)(2'?|'|3)?$/.exec(tok);
    if (!m) throw new Error(`Bad move: ${tok}`);
    const [, f, w, suf] = m;
    const k = !suf ? 1 : suf[0] === '2' ? 2 : 3;
    if ('MES'.includes(f)) return { a: NORMAL[{ M: 'L', E: 'D', S: 'F' }[f]], layers: [0], k };
    if ('xyz'.includes(f)) return { a: NORMAL[{ x: 'R', y: 'U', z: 'F' }[f]], layers: [-1, 0, 1], k };
    const wide = !!w || f !== f.toUpperCase();
    return { a: NORMAL[f.toUpperCase()], layers: wide ? [1, 0] : [1], k };
  }
  const parse = (alg) => alg.trim().split(/\s+/).filter(Boolean).map(parseMove);

  function turn(state, { a, layers, k }) {
    const to = perm(a, layers);
    for (let i = 0; i < k; i++) {
      const next = new Array(54);
      state.forEach((x, j) => { next[to[j]] = x; });
      state = next;
    }
    return state;
  }
  const apply = (state, alg) => parse(alg).reduce(turn, state);

  // ---------- alg rewriting ----------
  // Rewrites any alg (wide, slice, rotations) to outer face turns only, dropping the net cube rotation
  function faceMoves(alg) {
    const rots = [], out = [];
    const unrotate = (n) => rots.reduceRight((v, a) => rot(rot(rot(v, a), a), a), n);
    const emit = (n, k) => out.push([faceOfNormal(unrotate(n)), ((k % 4) + 4) % 4]);
    for (const { a, layers, k } of parse(alg)) {
      const neg = a.map((x) => -x);
      if (layers.length === 1 && layers[0] === 1) emit(a, k);
      else if (layers.length === 3) for (let i = 0; i < k; i++) rots.push(a);
      else {
        // Wide/slice = whole-cube rotation plus counter-turning the untouched outer layers
        if (!layers.includes(1)) emit(a, -k);
        emit(neg, k);
        for (let i = 0; i < k; i++) rots.push(a);
      }
    }
    return simplify(out);
  }
  function simplify(moves) {
    const out = [];
    for (const [f, k] of moves) {
      const last = out.at(-1);
      if (last && last[0] === f) { last[1] = (last[1] + k) % 4; if (!last[1]) out.pop(); }
      else if (k % 4) out.push([f, k % 4]);
    }
    return out;
  }
  const invert = (moves) => moves.slice().reverse().map(([f, k]) => [f, 4 - k]);
  const fmtMoves = (moves) => moves.map(([f, k]) => f + ['', '', '2', "'"][k]).join(' ');

  // Face-turn setup that creates the case solved by alg, with random-looking AUFs
  function setup(alg, pre = 0, post = 0) {
    return fmtMoves(simplify([['U', pre], ...invert(faceMoves(alg)), ['U', post]]));
  }

  // ---------- blindfolded (Old Pochmann, Speffz lettering) ----------
  const SPEFFZ = 'ULFRBD';
  const LETTER = { c: {}, e: {} }; // letter -> sticker index
  const NAME = { c: {}, e: {} }; // sticker index -> letter
  [...SPEFFZ].forEach((f, fi) => {
    [0, 2, 8, 6].forEach((pos, k) => { const l = String.fromCharCode(65 + fi * 4 + k), i = FACES.indexOf(f) * 9 + pos; LETTER.c[l] = i; NAME.c[i] = l; });
    [1, 5, 7, 3].forEach((pos, k) => { const l = String.fromCharCode(65 + fi * 4 + k), i = FACES.indexOf(f) * 9 + pos; LETTER.e[l] = i; NAME.e[i] = l; });
  });
  const BUFFER = { e: LETTER.e.B, c: LETTER.c.A }; // UR and ULB
  const pieceKey = (i) => STICKERS[i].p.join();
  // Stickers of i's piece starting at i, corners in a fixed rotational order so swaps keep twists right
  function pieceFrom(i) {
    const p = STICKERS[i].p, others = STICKERS.map((s, j) => j).filter((j) => j !== i && pieceKey(j) === pieceKey(i));
    if (others.length < 2) return [i, ...others];
    const next = others.find((j) => dot(cross(STICKERS[i].n, STICKERS[j].n), p) > 0);
    return [i, next, others.find((j) => j !== next)];
  }
  function swap(state, b, t) {
    const B = pieceFrom(b), T = pieceFrom(t), next = state.slice();
    B.forEach((bi, k) => { next[T[k]] = state[bi]; next[bi] = state[T[k]]; });
    return next;
  }
  const pieceSolved = (state, i) => pieceFrom(i).every((j) => state[j] === j);

  // Letters an OP solver would memo for this scramble; cycle breaks go to the lowest unsolved letter
  function memo(scramble, type) {
    let state = apply(solved(), scramble);
    const buf = BUFFER[type], order = Object.values(LETTER[type]), out = [];
    for (let guard = 0; guard < 40; guard++) {
      let t = state[buf];
      if (pieceKey(t) === pieceKey(buf)) {
        t = order.find((s) => pieceKey(s) !== pieceKey(buf) && !pieceSolved(state, s));
        if (t === undefined) break;
      }
      out.push(NAME[type][t]);
      state = swap(state, buf, t);
    }
    return out.join('');
  }
  // Whether shooting these letters in order solves every piece of that type (any valid cycle breaks pass)
  function memoSolves(scramble, type, letters) {
    let state = apply(solved(), scramble);
    for (const l of letters) {
      const t = LETTER[type][l];
      if (t === undefined || pieceKey(t) === pieceKey(BUFFER[type])) return false;
      state = swap(state, BUFFER[type], t);
    }
    return Object.values(LETTER[type]).every((s) => pieceSolved(state, s));
  }

  // ---------- last-layer diagrams ----------
  const COLORS = { U: 'var(--y)', D: 'var(--w)', F: 'var(--g)', B: 'var(--b)', R: 'var(--r)', L: 'var(--o)' };
  const at = (f, r, c) => FACES.indexOf(f) * 9 + r * 3 + c;
  const GREY = '#2a2e3a';
  // Top view of the U layer plus side stickers. Styles: pll (all colours), oll (top colour only),
  // eo / cp (2-look first steps: like oll / pll but corners / edges greyed out)
  function llSvg(state, style, size = 96) {
    const corner = (i) => (i % 9) % 2 === 0 && i % 9 !== 4, edge = (i) => (i % 9) % 2 === 1;
    const fill = (i) => {
      if ((style === 'eo' && corner(i)) || (style === 'cp' && edge(i))) return GREY;
      const c = colorOf(state[i]);
      return style === 'oll' || style === 'eo' ? (c === 'U' ? 'var(--y)' : GREY) : COLORS[c];
    };
    const u = size / 5.2, gap = u * 0.08, side = u * 0.42, o = side + gap * 2;
    let g = '';
    const sq = (x, y, w, h, i) => { g += `<rect x="${x + gap / 2}" y="${y + gap / 2}" width="${w - gap}" height="${h - gap}" rx="${u * 0.12}" fill="${fill(i)}"/>`; };
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) sq(o + c * u, o + r * u, u, u, at('U', r, c));
    for (let k = 0; k < 3; k++) {
      sq(o + k * u, 0, u, side, at('B', 0, 2 - k));
      sq(o + k * u, o + 3 * u + gap, u, side, at('F', 0, k));
      sq(0, o + k * u, side, u, at('L', 0, k));
      sq(o + 3 * u + gap, o + k * u, side, u, at('R', 0, 2 - k));
    }
    const w = o * 2 + 3 * u - gap;
    return `<svg class="ll" viewBox="0 0 ${w} ${w}" width="${size}" height="${size}" aria-hidden="true">${g}</svg>`;
  }

  // Unfolded net (U on top, L F R B across, D below) in real WCA colours; hi outlines the face just turned
  const NET = { U: [3, 0], L: [0, 3], F: [3, 3], R: [6, 3], B: [9, 3], D: [3, 6] };
  const REAL = { U: 'var(--w)', D: 'var(--y)', F: 'var(--g)', B: 'var(--b)', R: 'var(--r)', L: 'var(--o)' };
  function netSvg(state, cell = 16, hi = null) {
    let g = '';
    for (const f of FACES) {
      const [fx, fy] = NET[f];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        g += `<rect x="${(fx + c) * cell + 1}" y="${(fy + r) * cell + 1}" width="${cell - 2}" height="${cell - 2}" rx="${cell * 0.18}" fill="${REAL[colorOf(state[at(f, r, c)])]}"/>`;
      }
      if (f === hi) g += `<rect class="net-hi" x="${fx * cell - 1}" y="${fy * cell - 1}" width="${3 * cell + 2}" height="${3 * cell + 2}" rx="${cell * 0.3}"/>`;
    }
    return `<svg class="net" viewBox="-3 -3 ${12 * cell + 6} ${9 * cell + 6}" width="${12 * cell + 6}" height="${9 * cell + 6}" role="img" aria-label="Cube net">${g}</svg>`;
  }

  return { netSvg, solved, apply, faceMoves, fmtMoves, invert, simplify, setup, memo, memoSolves, llSvg, colorOf, at };
})();
if (typeof module !== 'undefined') module.exports = Cube;
