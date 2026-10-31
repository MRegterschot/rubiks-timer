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
const DAILY_TZ = process.env.DAILY_TZ || 'Europe/Amsterdam';
const MAX_RACES_PER_DAY = 50;

// Version asset URLs by content hash so Cloudflare/browser caches never serve stale CSS/JS
const hashOf = (f) => createHash('sha256').update(readFileSync(join(PUBLIC_DIR, f))).digest('hex').slice(0, 10);
const INDEX_HTML = Buffer.from(readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace(/(href|src)="(style\.css|app\.js|cube\.js|algs\.js)"/g, (_, attr, f) => `${attr}="${f}?v=${hashOf(f)}"`));

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
for (const [name, def] of [['mode', "TEXT NOT NULL DEFAULT '333'"], ['memo_ms', 'INTEGER'], ['edges', 'TEXT'], ['corners', 'TEXT'], ['user_id', 'INTEGER'], ['client_id', 'TEXT'], ['case_id', 'TEXT']]) {
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
-- Client-generated id makes save retries idempotent
CREATE UNIQUE INDEX IF NOT EXISTS solves_user_client ON solves (user_id, client_id);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by INTEGER REFERENCES users(id),
  used_at INTEGER
);
-- Shared-scramble events: one per day ('daily') or created by a user ('race')
CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('daily','race')),
  code TEXT NOT NULL UNIQUE,
  scramble TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
-- time_ms NULL = joined but not finished yet
CREATE TABLE IF NOT EXISTS challenge_results (
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  time_ms INTEGER,
  penalty TEXT CHECK (penalty IN ('+2','DNF')),
  joined_at INTEGER NOT NULL,
  done_at INTEGER,
  PRIMARY KEY (challenge_id, user_id)
);`);
if (!new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name)).has('recovery_hash')) db.exec('ALTER TABLE users ADD COLUMN recovery_hash TEXT');

const MODES = new Set(['333', 'bld', 'pll', 'oll']);
const BOARD_MODES = new Set(['333', 'bld']);
const q = {
  list: db.prepare('SELECT * FROM solves WHERE user_id = ? AND mode = ? ORDER BY id DESC'),
  get: db.prepare('SELECT * FROM solves WHERE id = ? AND user_id = ?'),
  insert: db.prepare('INSERT INTO solves (time_ms, scramble, penalty, created_at, mode, memo_ms, edges, corners, user_id, client_id, case_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'),
  byClientId: db.prepare('SELECT * FROM solves WHERE user_id = ? AND client_id = ?'),
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
  dropSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
  setPassword: db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?'),
  setRecovery: db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  challenge: db.prepare('SELECT * FROM challenges WHERE code = ?'),
  insertChallenge: db.prepare('INSERT INTO challenges (kind, code, scramble, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'),
  racesToday: db.prepare("SELECT COUNT(*) AS n FROM challenges WHERE kind = 'race' AND created_by = ? AND created_at > ?"),
  results: db.prepare('SELECT r.user_id, u.username, r.time_ms, r.penalty, r.joined_at, r.done_at FROM challenge_results r JOIN users u ON u.id = r.user_id WHERE r.challenge_id = ?'),
  myResult: db.prepare('SELECT * FROM challenge_results WHERE challenge_id = ? AND user_id = ?'),
  join: db.prepare('INSERT INTO challenge_results (challenge_id, user_id, joined_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'),
  submit: db.prepare('INSERT INTO challenge_results (challenge_id, user_id, time_ms, penalty, joined_at, done_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (challenge_id, user_id) DO UPDATE SET time_ms = excluded.time_ms, penalty = excluded.penalty, done_at = excluded.done_at WHERE time_ms IS NULL'),
  setResultPenalty: db.prepare('UPDATE challenge_results SET penalty = ? WHERE challenge_id = ? AND user_id = ? AND time_ms IS NOT NULL'),
  myRaces: db.prepare(`SELECT c.code, c.created_at, cu.username AS created_by,
      (SELECT COUNT(*) FROM challenge_results r WHERE r.challenge_id = c.id) AS players,
      (SELECT COUNT(*) FROM challenge_results r WHERE r.challenge_id = c.id AND r.time_ms IS NOT NULL) AS finished,
      (SELECT time_ms IS NOT NULL FROM challenge_results r WHERE r.challenge_id = c.id AND r.user_id = ?) AS done
    FROM challenges c LEFT JOIN users cu ON cu.id = c.created_by
    WHERE c.kind = 'race' AND (c.created_by = ? OR EXISTS (SELECT 1 FROM challenge_results r WHERE r.challenge_id = c.id AND r.user_id = ?))
    ORDER BY c.created_at DESC LIMIT 20`),
  invites: db.prepare(`SELECT i.code, i.created_at, i.expires_at, i.used_at, u.username AS used_by FROM invites i
    LEFT JOIN users u ON u.id = i.used_by WHERE i.created_by = ? AND (i.used_at IS NOT NULL OR i.expires_at > ?) ORDER BY i.created_at DESC LIMIT 20`),
  openInvites: db.prepare('SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND used_at IS NULL AND expires_at > ?'),
  insertInvite: db.prepare('INSERT INTO invites (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  delInvite: db.prepare('DELETE FROM invites WHERE code = ? AND created_by = ? AND used_at IS NULL'),
  claimInvite: db.prepare('UPDATE invites SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?'),
  inviteUsedBy: db.prepare('UPDATE invites SET used_by = ? WHERE code = ?'),
  boardSolves: db.prepare('SELECT s.user_id, u.username, s.time_ms, s.penalty FROM solves s JOIN users u ON u.id = s.user_id WHERE s.mode = ? ORDER BY s.user_id, s.id'),
  publicSolves: db.prepare('SELECT id, time_ms, scramble, penalty, created_at, mode, memo_ms, edges, corners FROM solves WHERE user_id = ? AND mode = ? ORDER BY id DESC LIMIT 1000'),
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
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
const newPassword = (pw) => {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) throw bad('Password must be at least 8 characters');
  return pw;
};
// Recovery codes: 20 chars from an unambiguous alphabet, shown grouped as XXXXX-XXXXX-...
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newRecoveryCode = () => [...randomBytes(20)].map((b) => RECOVERY_ALPHABET[b % 32]).join('').match(/.{5}/g).join('-');
const recoveryHash = (code) => sha256('recovery:' + String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''));
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
    const hasRecovery = !!q.userById.get(u.id)?.recovery_hash;
    return json(res, 200, { user: { id: u.id, username: u.username, hasRecovery }, inviteRequired: !!INVITE_CODE });
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
    return json(res, 201, { user: { id: userId, username, hasRecovery: false } });
  }
  if (path === '/api/password' || path === '/api/recovery') {
    const u = currentUser(req);
    if (!u) return json(res, 401, { error: 'Not logged in' });
    const keys = ['pw:' + u.id];
    if (limited(keys)) throw fail(429, 'Too many attempts, try again in 15 minutes');
    const user = q.userById.get(u.id);
    if (!b || typeof b.current !== 'string' || !(await checkPassword(b.current.slice(0, 200), user.pw_hash))) {
      recordFail(keys);
      throw fail(403, 'Current password is wrong');
    }
    if (path === '/api/recovery') {
      const code = newRecoveryCode();
      q.setRecovery.run(recoveryHash(code), u.id);
      return json(res, 200, { code });
    }
    q.setPassword.run(await hashPassword(newPassword(b.password)), u.id);
    q.dropSessions.run(u.id, sha256(u.token)); // log out every other device
    return json(res, 200, { ok: true });
  }
  if (path === '/api/reset') {
    if (!b || typeof b.username !== 'string' || typeof b.code !== 'string') throw bad('Username and recovery code required');
    const keys = [ipKey, 'user:' + b.username.toLowerCase()];
    if (limited(keys)) throw fail(429, 'Too many attempts, try again in 15 minutes');
    const password = newPassword(b.password);
    const user = q.userByName.get(b.username);
    const given = Buffer.from(recoveryHash(b.code.slice(0, 100)));
    if (!user?.recovery_hash || !timingSafeEqual(given, Buffer.from(user.recovery_hash))) {
      recordFail(keys);
      throw fail(401, 'Wrong username or recovery code');
    }
    // Codes are single use: the old one stops working and every device is logged out
    q.setPassword.run(await hashPassword(password), user.id);
    q.setRecovery.run(null, user.id);
    q.dropSessions.run(user.id, '');
    startSession(req, res, user.id);
    return json(res, 200, { user: { id: user.id, username: user.username, hasRecovery: false } });
  }
  if (path === '/api/login') {
    if (!b || typeof b.username !== 'string' || typeof b.password !== 'string') throw bad('Username and password required');
    const keys = [ipKey, 'user:' + b.username.toLowerCase()];
    if (limited(keys)) throw fail(429, 'Too many attempts, try again in 15 minutes');
    const user = q.userByName.get(b.username);
    const ok = await checkPassword(b.password.slice(0, 200), user ? user.pw_hash : DUMMY_HASH);
    if (!user || !ok) { recordFail(keys); throw fail(401, 'Wrong username or password'); }
    startSession(req, res, user.id);
    return json(res, 200, { user: { id: user.id, username: user.username, hasRecovery: !!user.recovery_hash } });
  }
  json(res, 404, { error: 'Not found' });
}

// ---------- leaderboard ----------
const effMs = (s) => (s.penalty === 'DNF' ? null : s.time_ms + (s.penalty === '+2' ? 2000 : 0));
// Best rolling average over a chronological list; trimmed = WCA average, otherwise plain mean (mo3)
function bestAvg(vals, n, trimmed) {
  let best = null;
  for (let i = 0; i + n <= vals.length; i++) {
    let win = vals.slice(i, i + n);
    if (trimmed) {
      const trim = n === 5 ? 1 : Math.ceil(n * 0.05);
      win = win.map((v) => (v === null ? Infinity : v)).sort((a, b) => a - b).slice(trim, n - trim);
      if (win.includes(Infinity)) continue;
    } else if (win.includes(null)) continue;
    const avg = win.reduce((a, b) => a + b, 0) / win.length;
    if (best === null || avg < best) best = avg;
  }
  return best === null ? null : Math.round(best);
}
function leaderboard(mode) {
  const byUser = new Map();
  for (const s of q.boardSolves.all(mode)) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, { username: s.username, vals: [] });
    byUser.get(s.user_id).vals.push(effMs(s));
  }
  return [...byUser.values()].map(({ username, vals }) => {
    const ok = vals.filter((v) => v !== null);
    const row = { username, solves: vals.length, single: ok.length ? Math.min(...ok) : null };
    if (mode === 'bld') Object.assign(row, { mo3: bestAvg(vals, 3, false), successes: ok.length });
    else Object.assign(row, { ao5: bestAvg(vals, 5, true), ao12: bestAvg(vals, 12, true) });
    return row;
  });
}

function handlePublic(req, res, path) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const mode = new URL(req.url, 'http://localhost').searchParams.get('mode') || '333';
  if (!BOARD_MODES.has(mode)) throw bad('mode must be "333" or "bld"');
  if (path === '/api/leaderboard') return json(res, 200, { mode, users: leaderboard(mode) });
  const m = path.match(/^\/api\/users\/([^/]+)\/solves$/);
  if (!m) return json(res, 404, { error: 'Not found' });
  let name;
  try { name = decodeURIComponent(m[1]); } catch { throw bad('Bad username'); }
  const user = q.userByName.get(name);
  if (!user) return json(res, 404, { error: 'User not found' });
  return json(res, 200, { username: user.username, mode, solves: q.publicSolves.all(user.id, mode) });
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

// ---------- daily scramble & races ----------
function genScramble() {
  const faces = 'UDLRFB', axis = { U: 0, D: 0, L: 1, R: 1, F: 2, B: 2 }, mods = ['', "'", '2'];
  const moves = [];
  let last = '', prev = '';
  while (moves.length < 20) {
    const [a, b] = randomBytes(2);
    const f = faces[a % 6];
    if (f === last) continue;
    if (last && prev && axis[f] === axis[last] && axis[f] === axis[prev]) continue;
    moves.push(f + mods[b % 3]);
    prev = last && axis[last] === axis[f] ? last : '';
    last = f;
  }
  return moves.join(' ');
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: DAILY_TZ }).format(new Date());
function dailyChallenge() {
  const code = 'daily-' + today();
  q.insertChallenge.run('daily', code, genScramble(), null, Date.now());
  return q.challenge.get(code);
}
// Others' times stay hidden until you've finished, so nobody gets spoiled or knows the time to beat
function challengeView(c, uid) {
  const rows = q.results.all(c.id);
  const mine = rows.find((r) => r.user_id === uid);
  const reveal = mine?.time_ms != null;
  const results = rows.map((r) => ({
    username: r.username,
    me: r.user_id === uid,
    done: r.time_ms != null,
    time_ms: reveal || r.user_id === uid ? r.time_ms : null,
    penalty: reveal || r.user_id === uid ? r.penalty : null,
  }));
  const creator = c.created_by ? q.userById.get(c.created_by)?.username : null;
  return {
    code: c.code, kind: c.kind, scramble: c.scramble, created_at: c.created_at, created_by: creator,
    day: c.kind === 'daily' ? c.code.slice(6) : null, done: reveal, results,
  };
}
async function handleChallenges(req, res, path, uid) {
  const now = Date.now();
  if (path === '/api/daily' && req.method === 'GET') return json(res, 200, challengeView(dailyChallenge(), uid));
  if (path === '/api/races' && req.method === 'GET') return json(res, 200, q.myRaces.all(uid, uid, uid));
  if (path === '/api/races' && req.method === 'POST') {
    if (q.racesToday.get(uid, now - DAY).n >= MAX_RACES_PER_DAY) throw fail(429, 'You created a lot of races today, try again tomorrow');
    const code = randomBytes(6).toString('base64url');
    q.insertChallenge.run('race', code, genScramble(), uid, now);
    const c = q.challenge.get(code);
    q.join.run(c.id, uid, now);
    return json(res, 201, challengeView(c, uid));
  }
  const m = path.match(/^\/api\/challenges\/([A-Za-z0-9_-]{6,32})(?:\/(join|result))?$/);
  if (!m) return json(res, 404, { error: 'Not found' });
  const c = q.challenge.get(m[1]);
  if (!c) return json(res, 404, { error: 'This race does not exist' });
  if (!m[2] && req.method === 'GET') return json(res, 200, challengeView(c, uid));
  if (m[2] === 'join' && req.method === 'POST') {
    q.join.run(c.id, uid, now);
    return json(res, 200, challengeView(c, uid));
  }
  if (m[2] === 'result' && req.method === 'POST') {
    const b = await readBody(req);
    const penalty = b?.penalty ?? null;
    if (!Number.isInteger(b?.time_ms) || b.time_ms < 0 || b.time_ms > 1e9) throw bad('time_ms must be a non-negative integer');
    if (!validPenalty(penalty)) throw bad('penalty must be null, "+2" or "DNF"');
    // One attempt each; a retry of the same submission just returns the current view
    if (!q.submit.run(c.id, uid, b.time_ms, penalty, now, now).changes && q.myResult.get(c.id, uid)?.time_ms !== b.time_ms) {
      throw fail(409, 'You already did this one');
    }
    return json(res, 200, challengeView(c, uid));
  }
  if (m[2] === 'result' && req.method === 'PATCH') {
    const b = await readBody(req);
    if (!b || !('penalty' in b) || !validPenalty(b.penalty)) throw bad('penalty must be null, "+2" or "DNF"');
    if (!q.setResultPenalty.run(b.penalty, c.id, uid).changes) return json(res, 404, { error: 'No result to change' });
    return json(res, 200, challengeView(c, uid));
  }
  json(res, 405, { error: 'Method not allowed' });
}

async function handleApi(req, res, path) {
  if (['/api/me', '/api/login', '/api/register', '/api/logout', '/api/password', '/api/recovery', '/api/reset'].includes(path)) return handleAuth(req, res, path);
  if (path === '/api/leaderboard' || path.startsWith('/api/users/')) return handlePublic(req, res, path);
  if (path === '/api/invites' || path.startsWith('/api/invites/')) {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: 'Not logged in' });
    return handleInvites(req, res, path, user.id);
  }
  if (path === '/api/daily' || path === '/api/races' || path.startsWith('/api/challenges/')) {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: 'Not logged in' });
    return handleChallenges(req, res, path, user.id);
  }
  const m = path.match(/^\/api\/solves(?:\/(\d+))?$/);
  if (!m) return json(res, 404, { error: 'Not found' });
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: 'Not logged in' });
  const uid = user.id;
  const id = m[1] ? Number(m[1]) : null;

  if (!id) {
    const mode = new URL(req.url, 'http://localhost').searchParams.get('mode') || '333';
    if (!MODES.has(mode)) throw bad('mode must be one of 333, bld, pll, oll');
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
      if (!MODES.has(mode)) throw bad('mode must be one of 333, bld, pll, oll');
      const caseId = b.case_id ?? null;
      if (caseId !== null && (typeof caseId !== 'string' || !/^[A-Za-z0-9]{1,8}$/.test(caseId))) throw bad('case_id must be 1-8 letters or digits');
      const memo = b.memo_ms ?? null;
      if (memo !== null && (!Number.isInteger(memo) || memo < 0 || memo > time_ms)) throw bad('memo_ms must be an integer between 0 and time_ms');
      const clientId = b.client_id ?? null;
      if (clientId !== null && (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId))) throw bad('client_id must be 8-64 characters: letters, numbers, _ -');
      // Queued solves are retried later, so keep the client's stop time (within the last 30 days)
      const now = Date.now();
      const at = Number.isInteger(b.created_at) && b.created_at <= now && b.created_at > now - 30 * DAY ? b.created_at : now;
      const r = q.insert.run(time_ms, scramble, penalty, at, mode, memo, optLetters(b.edges, 'edges'), optLetters(b.corners, 'corners'), uid, clientId, caseId);
      if (!r.changes) return json(res, 200, q.byClientId.get(uid, clientId)); // retry of an already saved solve
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
// Graceful shutdown: finish in-flight requests (e.g. a solve being saved) before closing the DB
function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => { db.close(); process.exit(0); }, 8000).unref();
}
for (const s of ['SIGINT', 'SIGTERM']) process.once(s, shutdown);
