// Gebruikers, wachtwoorden (scrypt), sessies en tweestapsverificatie (TOTP, RFC 6238).
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { config } from './config.js';
import * as store from './db.js';

export const ROLES = ['admin', 'viewer'];
export const SESSION_TTL = 7 * 86400;

// ---------- wachtwoorden ----------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

export function validatePassword(pw) {
  if (String(pw || '').length < 10) return 'Wachtwoord moet minimaal 10 tekens zijn';
  return null;
}

/** Eerste admin aanmaken uit ADMIN_USER/ADMIN_PASSWORD (of resetten met RESET_ADMIN_PASSWORD=1). */
export function bootstrapUsers() {
  if (store.countUsers() === 0) {
    if (!config.adminPassword) {
      console.error('Er zijn nog geen gebruikers. Zet ADMIN_USER en ADMIN_PASSWORD in .env voor het eerste admin-account.');
      process.exit(1);
    }
    store.createUser(config.adminUser, hashPassword(config.adminPassword), 'admin');
    console.log(`Admin-account "${config.adminUser}" aangemaakt vanuit .env`);
  } else if (config.resetAdminPassword && config.adminPassword) {
    const u = store.userByName(config.adminUser);
    if (u) store.updateUser(u.id, { pass_hash: hashPassword(config.adminPassword), role: 'admin', totp_secret: null });
    else store.createUser(config.adminUser, hashPassword(config.adminPassword), 'admin');
    console.log(`Wachtwoord van "${config.adminUser}" gereset vanuit .env (2FA uitgeschakeld). Zet RESET_ADMIN_PASSWORD weer uit.`);
  }
}

// ---------- sessies ----------

const sessionSecret = config.sessionSecret || store.getOrCreateSecret();
const sign = (data) => crypto.createHmac('sha256', sessionSecret).update(data).digest('base64url');
// Wachtwoordwijziging of 2FA-wijziging maakt bestaande sessies ongeldig.
const userVersion = (u) => crypto.createHash('sha256').update(`${u.pass_hash}|${u.totp_secret || ''}|${u.role}`).digest('base64url').slice(0, 12);

export function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({ i: user.id, v: userVersion(user), e: store.nowSec() + SESSION_TTL })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Geeft de ingelogde gebruiker terug ({id, username, role, totp}) of null. */
export function readSession(req) {
  const raw = parseCookies(req).sd_session;
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!data.i || data.e < store.nowSec()) return null;
  const u = store.getUser(data.i);
  if (!u || userVersion(u) !== data.v) return null;
  return publicUser(u);
}

export const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, totp: !!u.totp_secret, last_login: u.last_login, created_at: u.created_at });

// ---------- TOTP ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

const usedCounters = new Map(); // userId -> laatst gebruikte counter (tegen hergebruik van een code)

export function verifyTotp(secret, code, userId = null) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean) || !secret) return false;
  const now = Math.floor(Date.now() / 30000);
  for (const c of [now - 1, now, now + 1]) {
    const a = Buffer.from(hotp(secret, c));
    if (crypto.timingSafeEqual(a, Buffer.from(clean))) {
      if (userId != null && (usedCounters.get(userId) ?? -1) >= c) return false;
      if (userId != null) usedCounters.set(userId, c);
      return true;
    }
  }
  return false;
}

export async function newTotpSetup(username) {
  const secret = base32Encode(crypto.randomBytes(20));
  const label = encodeURIComponent(`ServerDash:${username}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('NextBuzz ServerDash')}&algorithm=SHA1&digits=6&period=30`;
  const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
  return { secret, uri, qr };
}

// ---------- inlogpogingen ----------

const loginFailures = new Map(); // ip -> {count, until}

export function checkRateLimit(ip) {
  const f = loginFailures.get(ip);
  return !(f && f.count >= 10 && f.until > Date.now());
}

export function registerFailure(ip) {
  const f = loginFailures.get(ip);
  const entry = f && f.until > Date.now() ? f : { count: 0, until: Date.now() + 15 * 60_000 };
  entry.count++;
  loginFailures.set(ip, entry);
}

export const clearFailures = (ip) => loginFailures.delete(ip);
