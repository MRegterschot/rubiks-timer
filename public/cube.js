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

  // ---------- 3D view ----------
  const REAL = { U: 'var(--w)', D: 'var(--y)', F: 'var(--g)', B: 'var(--b)', R: 'var(--r)', L: 'var(--o)' };
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const mul = (a, k) => a.map((v) => v * k);
  const r2 = (n) => Math.round(n * 1000) / 1000;
  // Orthographic camera: azimuth from the front towards the right, elevation above the horizon
  function camera(az, el) {
    const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
    return {
      d: [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)],
      r: [Math.cos(a), 0, -Math.sin(a)],
      u: [-Math.sin(a) * Math.sin(e), Math.cos(e), -Math.cos(a) * Math.sin(e)],
    };
  }
  const FRONT = camera(32, 28), BACK = camera(212, -28);
  const project = (cam, p) => [dot(p, cam.r), -dot(p, cam.u)];
  const tangents = (n) => [[1, 0, 0], [0, 1, 0], [0, 0, 1]].filter((t) => !dot(t, n));
  const poly = (cam, pts) => pts.map((p) => project(cam, p).map(r2).join(',')).join(' ');

  // Arrow along the turning layer's band on the visible faces, pointing the way the layer moves
  function arrow(cam, tok) {
    const { a, layers, k } = parseMove(tok);
    const h = layers.length === 3 ? 0 : layers.reduce((x, y) => x + y, 0) / layers.length;
    const u = a[0] ? [0, 1, 0] : [1, 0, 0], w = cross(a, u); // u × w = a, so increasing angle turns anticlockwise about a
    const pts = [], vis = [];
    for (let deg = 0; deg < 360; deg += 3) {
      const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), m = Math.max(Math.abs(c), Math.abs(s));
      const normal = Math.abs(c) >= Math.abs(s) ? mul(u, Math.sign(c)) : mul(w, Math.sign(s));
      pts.push(add(mul(a, h), mul(add(mul(u, c / m), mul(w, s / m)), 1.58)));
      vis.push(dot(normal, cam.d) > 0.05);
    }
    // Rotate so the visible stretch doesn't wrap past 360°, then trim its ends
    const first = vis.findIndex((v, i) => v && !vis[(i - 1 + vis.length) % vis.length]);
    let arc = [];
    for (let i = 0; i < pts.length; i++) { const j = (first + i) % pts.length; if (!vis[j]) break; arc.push(pts[j]); }
    const trim = Math.floor(arc.length * 0.12);
    arc = arc.slice(trim, arc.length - trim).map((p) => project(cam, p));
    if (k === 1) arc.reverse(); // clockwise runs towards decreasing angle
    const head = (tip, from) => {
      const dx = tip[0] - from[0], dy = tip[1] - from[1], l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, s = 0.3;
      return [[tip[0] + ux * s * 0.6, tip[1] + uy * s * 0.6], [tip[0] - ux * s * 0.7 - uy * s * 0.75, tip[1] - uy * s * 0.7 + ux * s * 0.75],
        [tip[0] - ux * s * 0.7 + uy * s * 0.75, tip[1] - uy * s * 0.7 - ux * s * 0.75]].map((p) => p.map(r2).join(',')).join(' ');
    };
    const d = 'M' + arc.map((p) => p.map(r2).join(',')).join('L');
    const heads = [head(arc.at(-1), arc.at(-4))];
    if (k === 2) heads.push(head(arc[0], arc[3]));
    return `<g class="cube-arrow"><path class="halo" d="${d}"/>${heads.map((hd) => `<polygon class="halo" points="${hd}"/>`).join('')}
      <path d="${d}"/>${heads.map((hd) => `<polygon points="${hd}"/>`).join('')}</g>`;
  }

  // Cube seen from the front-top-right (or from behind and below with back), optional move arrow
  function cubeSvg(state, { size = 170, back = false, move = null } = {}) {
    const cam = back ? BACK : FRONT;
    let g = '';
    for (const f of FACES) {
      const n = NORMAL[f];
      if (dot(n, cam.d) <= 0) continue;
      const [t1, t2] = tangents(n), c = mul(n, 1.5);
      g += `<polygon class="cube-face" points="${poly(cam, [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([x, y]) => add(c, add(mul(t1, 1.5 * x), mul(t2, 1.5 * y)))))}"/>`;
      for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) {
        const i = at(f, r, col), m = add(STICKERS[i].p, mul(n, 0.5));
        const pts = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([x, y]) => add(m, add(mul(t1, 0.42 * x), mul(t2, 0.42 * y))));
        g += `<polygon class="cube-st" points="${poly(cam, pts)}" fill="${REAL[colorOf(state[i])]}"/>`;
      }
    }
    if (move) { try { g += arrow(cam, move); } catch { /* unknown token: no arrow */ } }
    // Fit the view to the projected cube (plus room for arrows)
    const corners = [];
    for (const x of [-1.5, 1.5]) for (const y of [-1.5, 1.5]) for (const z of [-1.5, 1.5]) corners.push(project(cam, [x, y, z]));
    const pad = 0.35, xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
    const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, w = Math.max(...xs) - x0 + pad, h = Math.max(...ys) - y0 + pad;
    return `<svg class="cube3d" viewBox="${r2(x0)} ${r2(y0)} ${r2(w)} ${r2(h)}" width="${size}" height="${Math.round((size * h) / w)}" role="img" aria-label="${back ? 'Back of the cube' : 'Cube'}">${g}</svg>`;
  }

  return { cubeSvg, solved, apply, faceMoves, fmtMoves, invert, simplify, setup, memo, memoSolves, llSvg, colorOf, at };
})();
if (typeof module !== 'undefined') module.exports = Cube;
