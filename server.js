import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFile, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = resolve(process.env.DB_PATH || './data/solves.db');
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY = 10 * 1024;

// Version asset URLs by content hash so Cloudflare/browser caches never serve stale CSS/JS
const hashOf = (f) => createHash('sha256').update(readFileSync(join(PUBLIC_DIR, f))).digest('hex').slice(0, 10);
const INDEX_HTML = Buffer.from(readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace(/(href|src)="(style\.css|app\.js)"/g, (_, attr, f) => `${attr}="${f}?v=${hashOf(f)}"`));

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS solves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_ms INTEGER NOT NULL,
  scramble TEXT NOT NULL,
  penalty TEXT CHECK (penalty IN ('+2','DNF')),
  created_at INTEGER NOT NULL
)`);
// Columns added for blindfolded mode; ALTER only when missing so existing DBs migrate in place
const cols = new Set(db.prepare('PRAGMA table_info(solves)').all().map((c) => c.name));
for (const [name, def] of [['mode', "TEXT NOT NULL DEFAULT '333'"], ['memo_ms', 'INTEGER'], ['edges', 'TEXT'], ['corners', 'TEXT']]) {
  if (!cols.has(name)) db.exec(`ALTER TABLE solves ADD COLUMN ${name} ${def}`);
}

const MODES = new Set(['333', 'bld']);
const q = {
  list: db.prepare('SELECT * FROM solves WHERE mode = ? ORDER BY id DESC'),
  get: db.prepare('SELECT * FROM solves WHERE id = ?'),
  insert: db.prepare('INSERT INTO solves (time_ms, scramble, penalty, created_at, mode, memo_ms, edges, corners) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  patch: db.prepare('UPDATE solves SET penalty = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM solves WHERE id = ?'),
  clear: db.prepare('DELETE FROM solves WHERE mode = ?'),
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((ok, fail) => {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { fail(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { ok(JSON.parse(Buffer.concat(chunks).toString() || 'null')); }
    catch { fail(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
  });
  req.on('error', fail);
});

const validPenalty = (p) => p === null || p === '+2' || p === 'DNF';
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

const optLetters = (v, name) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 200) throw bad(`${name} must be a string (max 200 chars)`);
  return v;
};

async function handleApi(req, res, path) {
  const m = path.match(/^\/api\/solves(?:\/(\d+))?$/);
  if (!m) return json(res, 404, { error: 'Not found' });
  const id = m[1] ? Number(m[1]) : null;

  if (!id) {
    const mode = new URL(req.url, 'http://localhost').searchParams.get('mode') || '333';
    if (!MODES.has(mode)) throw bad('mode must be "333" or "bld"');
    if (req.method === 'GET') return json(res, 200, q.list.all(mode));
    if (req.method === 'DELETE') { q.clear.run(mode); return json(res, 200, { ok: true }); }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (!b || typeof b !== 'object') throw bad('Body must be an object');
      const { time_ms, scramble } = b;
      const penalty = b.penalty ?? null;
      if (!Number.isInteger(time_ms) || time_ms < 0 || time_ms > 1e9) throw bad('time_ms must be a non-negative integer');
      if (typeof scramble !== 'string' || scramble.length > 500) throw bad('scramble must be a string (max 500 chars)');
      if (!validPenalty(penalty)) throw bad('penalty must be null, "+2" or "DNF"');
      const mode = b.mode ?? '333';
      if (!MODES.has(mode)) throw bad('mode must be "333" or "bld"');
      const memo = b.memo_ms ?? null;
      if (memo !== null && (!Number.isInteger(memo) || memo < 0 || memo > time_ms)) throw bad('memo_ms must be an integer between 0 and time_ms');
      const r = q.insert.run(time_ms, scramble, penalty, Date.now(), mode, memo, optLetters(b.edges, 'edges'), optLetters(b.corners, 'corners'));
      return json(res, 201, q.get.get(r.lastInsertRowid));
    }
  } else {
    if (req.method === 'PATCH') {
      const b = await readBody(req);
      if (!b || typeof b !== 'object' || !('penalty' in b) || !validPenalty(b.penalty)) throw bad('penalty must be null, "+2" or "DNF"');
      if (!q.get.get(id)) return json(res, 404, { error: 'Solve not found' });
      q.patch.run(b.penalty, id);
      return json(res, 200, q.get.get(id));
    }
    if (req.method === 'DELETE') {
      const r = q.del.run(id);
      return r.changes ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Solve not found' });
    }
  }
  json(res, 405, { error: 'Method not allowed' });
}

function serveStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(path); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end('Bad request'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = resolve(PUBLIC_DIR, '.' + rel);
  // Reject anything that resolves outside public/
  if (!file.startsWith(PUBLIC_DIR + sep)) { res.writeHead(403); return res.end('Forbidden'); }
  const versioned = new URL(req.url, 'http://localhost').searchParams.has('v');
  const send = (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  };
  if (file === join(PUBLIC_DIR, 'index.html')) return send(null, INDEX_HTML);
  readFile(file, send);
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (path === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (path.startsWith('/api/')) return await handleApi(req, res, path);
    serveStatic(req, res, path);
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
    if (!e.status) console.error(e);
  }
});

server.listen(PORT, () => console.log(`Listening on :${PORT}, db ${DB_PATH}`));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { server.close(); db.close(); process.exit(0); });
