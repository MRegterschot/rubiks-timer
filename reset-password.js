// Admin: set a new password for a user and log them out everywhere.
// Usage: node reset-password.js <username> <new-password>
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import { resolve } from 'node:path';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error('Usage: node reset-password.js <username> <new-password (8+ chars)>');
  process.exit(1);
}
const db = new DatabaseSync(resolve(process.env.DB_PATH || './data/solves.db'));
const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!user) { console.error(`No user "${username}"`); process.exit(1); }
const salt = randomBytes(16);
const hash = `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32).toString('hex')}`;
db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hash, user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log(`Password reset for ${username}; all their sessions were logged out.`);
