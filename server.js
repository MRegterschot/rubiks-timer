import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFile, readFileSync } from 'node:fs';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = resolve(process.env.DB_PATH || './data/solves.db');
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY = 10 * 1024;
const INVITE_CODE = process.env.INVITE_CODE || '';
const SESSION_DAYS = 365;
const INVITE_DAYS = 7;
const MAX_OPEN_INVITES = 5;
const DAY = 86400e3;

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
for (const [name, def] of [['mode', "TEXT NOT NULL DEFAULT '333'"], ['memo_ms', 'INTEGER'], ['edges', 'TEXT'], ['corners', 'TEXT'], ['user_id', 'INTEGER']]) {
  if (!cols.has(name)) db.exec(`ALTER TABLE solves ADD COLUMN ${name} ${def}`);
}

db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS solves_user_mode ON solves (user_id, mode, id);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by INTEGER REFERENCES users(id),
  used_at INTEGER
);`);

const MODES = new Set(['333', 'bld']);
const q = {
  list: db.prepare('SELECT * FROM solves WHERE user_id = ? AND mode = ? ORDER BY id DESC'),
  get: db.prepare('SELECT * FROM solves WHERE id = ? AND user_id = ?'),
  insert: db.prepare('INSERT INTO solves (time_ms, scramble, penalty, created_at, mode, memo_ms, edges, corners, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  patch: db.prepare('UPDATE solves SET penalty = ? WHERE id = ? AND user_id = ?'),
  del: db.prepare('DELETE FROM solves WHERE id = ? AND user_id = ?'),
  clear: db.prepare('DELETE FROM solves WHERE user_id = ? AND mode = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (username, pw_hash, created_at) VALUES (?, ?, ?)'),
  session: db.prepare('SELECT s.expires_at, u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  renewSession: db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  invites: db.prepare(`SELECT i.code, i.created_at, i.expires_at, i.used_at, u.username AS used_by FROM invites i
    LEFT JOIN users u ON u.id = i.used_by WHERE i.created_by = ? AND (i.used_at IS NOT NULL OR i.expires_at > ?) ORDER BY i.created_at DESC LIMIT 20`),
  openInvites: db.prepare('SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND used_at IS NULL AND expires_at > ?'),
  insertInvite: db.prepare('INSERT INTO invites (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  delInvite: db.prepare('DELETE FROM invites WHERE code = ? AND created_by = ? AND used_at IS NULL'),
  claimInvite: db.prepare('UPDATE invites SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?'),
  inviteUsedBy: db.prepare('UPDATE invites SET used_by = ? WHERE code = ?'),
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
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const bad = (msg) => fail(400, msg);

const optLetters = (v, name) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 200) throw bad(`${name} must be a string (max 200 chars)`);
  return v;
};

// ---------- auth ----------
const scryptAsync = promisify(scrypt);
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const [, salt, hash] = stored.split('$');
  const key = await scryptAsync(pw, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
// Burned on unknown usernames so response time doesn't reveal which accounts exist
const DUMMY_HASH = await hashPassword(randomBytes(8).toString('hex'));

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
function credentials(b) {
  if (!b || typeof b !== 'object') throw bad('Body must be an object');
  const { username, password } = b;
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw bad('Username must be 3-24 characters: letters, numbers, _ . -');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw bad('Password must be at least 8 characters');
  return { username, password };
}

// Failed login/invite attempts per client IP and per username, 15 minute window
const attempts = new Map();
const LIMIT = 10, WINDOW = 15 * 60e3;
const clientIp = (req) => req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
function limited(keys) {
  const now = Date.now();
  return keys.some((k) => { const a = attempts.get(k); return a && a.reset > now && a.n >= LIMIT; });
}
function recordFail(keys) {
  const now = Date.now();
  for (const k of keys) {
    const a = attempts.get(k);
    if (!a || a.reset <= now) attempts.set(k, { n: 1, reset: now + WINDOW });
    else a.n++;
  }
}

const parseCookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k, v]) => k && v));
function setSessionCookie(req, res, token, maxAgeS) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`);
}
function startSession(req, res, userId) {
  const token = randomBytes(32).toString('base64url');
  q.insertSession.run(sha256(token), userId, Date.now() + SESSION_DAYS * DAY);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}
function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = q.session.get(sha256(token), Date.now());
  return row ? { ...row, token } : null;
}

async function handleAuth(req, res, path) {
  if (path === '/api/me' && req.method === 'GET') {
    const u = currentUser(req);
    if (!u) return json(res, 401, { error: 'Not logged in' });
    // Sliding expiry: active users effectively stay logged in on each device
    if (u.expires_at - Date.now() < (SESSION_DAYS - 30) * DAY) {
      q.renewSession.run(Date.now() + SESSION_DAYS * DAY, sha256(u.token));
      setSessionCookie(req, res, u.token, SESSION_DAYS * 86400);
    }
    return json(res, 200, { user: { id: u.id, username: u.username }, inviteRequired: !!INVITE_CODE });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  if (path === '/api/logout') {
    const u = currentUser(req);
    if (u) q.delSession.run(sha256(u.token));
    setSessionCookie(req, res, '', 0);
    return json(res, 200, { ok: true });
  }

  const b = await readBody(req);
  const ipKey = 'ip:' + clientIp(req);
  if (path === '/api/register') {
    if (limited([ipKey])) throw fail(429, 'Too many attempts, try again in 15 minutes');
    const { username, password } = credentials(b);
    const invite = typeof b.invite === 'string' ? b.invite.trim() : '';
    // The global code is for bootstrapping; personal invites are single-use
    const global = INVITE_CODE ? invite === INVITE_CODE : true;
    const personal = !global && /^[A-Za-z0-9_-]{8,64}$/.test(invite);
    if (!global && !personal) { recordFail([ipKey]); throw fail(403, 'Invalid invite code'); }
    if (q.userByName.get(username)) throw fail(409, 'That username is taken');
    const pwHash = await hashPassword(password);
    let userId;
    db.exec('BEGIN');
    try {
      if (personal && !q.claimInvite.run(Date.now(), invite, Date.now()).changes) {
        recordFail([ipKey]);
        throw fail(403, 'This invite is invalid, already used or expired');
      }
      userId = Number(q.insertUser.run(username, pwHash, Date.now()).lastInsertRowid);
      if (personal) q.inviteUsedBy.run(userId, invite);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      if (String(e.message).includes('UNIQUE')) throw fail(409, 'That username is taken');
      throw e;
    }
    startSession(req, res, userId);
    return json(res, 201, { user: { id: userId, username } });
  }
  if (path === '/api/login') {
    if (!b || typeof b.username !== 'string' || typeof b.password !== 'string') throw bad('Username and password required');
    const keys = [ipKey, 'user:' + b.username.toLowerCase()];
    if (limited(keys)) throw fail(429, 'Too many attempts, try again in 15 minutes');
    const user = q.userByName.get(b.username);
    const ok = await checkPassword(b.password.slice(0, 200), user ? user.pw_hash : DUMMY_HASH);
    if (!user || !ok) { recordFail(keys); throw fail(401, 'Wrong username or password'); }
    startSession(req, res, user.id);
    return json(res, 200, { user: { id: user.id, username: user.username } });
  }
  json(res, 404, { error: 'Not found' });
}

function handleInvites(req, res, path, uid) {
  const now = Date.now();
  if (path === '/api/invites' && req.method === 'GET') return json(res, 200, q.invites.all(uid, now));
  if (path === '/api/invites' && req.method === 'POST') {
    if (q.openInvites.get(uid, now).n >= MAX_OPEN_INVITES) throw fail(429, `You already have ${MAX_OPEN_INVITES} unused invites. Revoke one or wait for them to be used.`);
    const code = randomBytes(9).toString('base64url');
    q.insertInvite.run(code, uid, now, now + INVITE_DAYS * DAY);
    return json(res, 201, { code, created_at: now, expires_at: now + INVITE_DAYS * DAY, used_at: null, used_by: null });
  }
  const m = path.match(/^\/api\/invites\/([A-Za-z0-9_-]+)$/);
  if (m && req.method === 'DELETE') {
    return q.delInvite.run(m[1], uid).changes ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Invite not found or already used' });
  }
  json(res, 404, { error: 'Not found' });
}

async function handleApi(req, res, path) {
  if (['/api/me', '/api/login', '/api/register', '/api/logout'].includes(path)) return handleAuth(req, res, path);
  if (path === '/api/invites' || path.startsWith('/api/invites/')) {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: 'Not logged in' });
    return handleInvites(req, res, path, user.id);
  }
  const m = path.match(/^\/api\/solves(?:\/(\d+))?$/);
  if (!m) return json(res, 404, { error: 'Not found' });
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: 'Not logged in' });
  const uid = user.id;
  const id = m[1] ? Number(m[1]) : null;

  if (!id) {
    const mode = new URL(req.url, 'http://localhost').searchParams.get('mode') || '333';
    if (!MODES.has(mode)) throw bad('mode must be "333" or "bld"');
    if (req.method === 'GET') return json(res, 200, q.list.all(uid, mode));
    if (req.method === 'DELETE') { q.clear.run(uid, mode); return json(res, 200, { ok: true }); }
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
      const r = q.insert.run(time_ms, scramble, penalty, Date.now(), mode, memo, optLetters(b.edges, 'edges'), optLetters(b.corners, 'corners'), uid);
      return json(res, 201, q.get.get(r.lastInsertRowid, uid));
    }
  } else {
    if (req.method === 'PATCH') {
      const b = await readBody(req);
      if (!b || typeof b !== 'object' || !('penalty' in b) || !validPenalty(b.penalty)) throw bad('penalty must be null, "+2" or "DNF"');
      if (!q.get.get(id, uid)) return json(res, 404, { error: 'Solve not found' });
      q.patch.run(b.penalty, id, uid);
      return json(res, 200, q.get.get(id, uid));
    }
    if (req.method === 'DELETE') {
      const r = q.del.run(id, uid);
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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    if (path === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (path.startsWith('/api/')) return await handleApi(req, res, path);
    serveStatic(req, res, path);
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
    if (!e.status) console.error(e);
  }
});

q.purgeSessions.run(Date.now());
setInterval(() => q.purgeSessions.run(Date.now()), 3600e3).unref();
server.listen(PORT, () => console.log(`Listening on :${PORT}, db ${DB_PATH}`));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { server.close(); db.close(); process.exit(0); });
