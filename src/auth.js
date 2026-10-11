// Accounts & sessions. Passwords are stored as scrypt hashes; sessions are random tokens in a cookie.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_DAYS = 30;
const COOKIE = 'playlite_session';

export class Auth {
  #failures = new Map(); // ip -> [timestamps]

  constructor(dataDir) {
    this.usersFile = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.users = readJson(this.usersFile, { users: [] }).users;
    this.sessions = readJson(this.sessionsFile, {});
    this.#prune();
  }

  get hasUsers() { return this.users.length > 0; }

  #saveUsers() { writeJson(this.usersFile, { users: this.users }); }
  #saveSessions() { writeJson(this.sessionsFile, this.sessions); }

  #prune() {
    const now = Date.now();
    for (const [t, s] of Object.entries(this.sessions)) if (s.expires < now) delete this.sessions[t];
  }

  static hash(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
  }

  createUser(username, password) {
    username = String(username ?? '').trim();
    if (!/^[\w.@-]{2,40}$/.test(username)) throw new Error('Username: 2–40 letters, numbers, . _ - @');
    if (String(password ?? '').length < 8) throw new Error('Password must be at least 8 characters');
    if (this.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw new Error('That username is taken');
    const salt = crypto.randomBytes(16).toString('hex');
    this.users.push({ username, salt, hash: Auth.hash(password, salt), createdAt: new Date().toISOString() });
    this.#saveUsers();
  }

  deleteUser(username) {
    if (this.users.length <= 1) throw new Error("Can't delete the last account");
    this.users = this.users.filter((u) => u.username !== username);
    for (const [t, s] of Object.entries(this.sessions)) if (s.username === username) delete this.sessions[t];
    this.#saveUsers();
    this.#saveSessions();
  }

  changePassword(username, password) {
    const user = this.users.find((u) => u.username === username);
    if (!user) throw new Error('No such user');
    if (String(password ?? '').length < 8) throw new Error('Password must be at least 8 characters');
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = Auth.hash(password, user.salt);
    this.#saveUsers();
  }

  // Returns a session token or throws. Slows down repeated failures from one address.
  login(username, password, ip) {
    const recent = (this.#failures.get(ip) ?? []).filter((t) => Date.now() - t < 60_000);
    if (recent.length >= 5) throw new Error('Too many attempts — wait a minute and try again');
    const user = this.users.find((u) => u.username.toLowerCase() === String(username ?? '').trim().toLowerCase());
    const ok = user && crypto.timingSafeEqual(Buffer.from(Auth.hash(String(password ?? ''), user.salt), 'hex'), Buffer.from(user.hash, 'hex'));
    if (!ok) {
      this.#failures.set(ip, [...recent, Date.now()]);
      throw new Error('Wrong username or password');
    }
    this.#failures.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions[token] = { username: user.username, expires: Date.now() + SESSION_DAYS * 86_400_000 };
    this.#saveSessions();
    return token;
  }

  logout(token) {
    delete this.sessions[token];
    this.#saveSessions();
  }

  // -> username or null
  check(req) {
    const token = tokenFrom(req);
    const s = token && this.sessions[token];
    if (!s || s.expires < Date.now()) return null;
    return s.username;
  }

  static cookie(token) {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
  }
  static clearCookie() {
    return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }
}

export function tokenFrom(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie ?? '');
  return m?.[1] ?? null;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}
