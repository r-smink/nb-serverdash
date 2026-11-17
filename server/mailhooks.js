// E-mailmeldingen via webhook: WordPress-sites (de SMTP-logger van NB OC Monitor, direct of via het OC Monitor-paneel)
// melden e-mail die niet verstuurd kon worden. Zo'n melding staat een instelbare tijd op het overzicht en in de tv-modus.
// Alleen weergave: er worden geen incidenten aangemaakt en geen meldingen verstuurd.
//
//   POST /hooks/mail/<token>                    (token in de URL, want in WordPress kun je alleen een URL invullen)
//   POST /hooks/mail  + Authorization: Bearer <token>
import crypto from 'node:crypto';
import * as store from './db.js';

const { nowSec } = store;

export const MAX_BODY = 32 * 1024;
export const RATE_LIMIT = 120;                  // verzoeken per minuut per token
const BAD_TOKEN_LIMIT = 60;                     // onbekende tokens per minuut per IP
export const DURATIONS = [5, 15, 30, 60, 120, 240, 1440];
export const DEFAULT_MINUTES = 30;
const RECOVERED_SECONDS = 5 * 60;

const EVENTS = {
  'smtp.failed': 'crit',
  'smtp.backup_used': 'warn',
  'smtp.recovered': 'ok',
  'smtp.test': 'info',
};

export const displayMinutes = () => {
  const m = store.getSetting('mailAlertMinutes', DEFAULT_MINUTES);
  return DURATIONS.includes(m) ? m : DEFAULT_MINUTES;
};

// ---------- invoer opschonen (alles in de payload is onbetrouwbaar) ----------

// Stuurtekens, zero-width- en bidi-tekens (die tekst op het scherm kunnen verstoppen of omdraaien).
const CONTROL_CHARS = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]]
  .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]+`, 'g');

/** Tekst: alleen strings/getallen, zonder stuurtekens, witruimte samengevoegd, ingekort tot max tekens. */
function str(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Alleen http(s)-URL's zonder inloggegevens; anders ''. */
function httpUrl(v, max = 500) {
  if (typeof v !== 'string' || v.length > 2000) return '';
  try {
    const u = new URL(v.trim());
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return '';
    return u.href.length > max ? '' : u.href;
  } catch { return ''; }
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };

/** j***@klant.nl — de lokale naam deels verbergen; meerdere ontvangers als "(+2)". */
export function maskEmail(addr) {
  const s = str(addr, 254);
  const at = s.lastIndexOf('@');
  if (at < 1) return s ? `${s[0]}***` : '';
  const local = s.slice(0, at), domain = s.slice(at + 1);
  return `${local.length > 3 ? local.slice(0, 2) : local[0]}***@${domain}`;
}

function recipientOf(to) {
  const list = (Array.isArray(to) ? to : typeof to === 'string' ? to.split(',') : []).filter((x) => typeof x === 'string' && x.trim());
  if (!list.length) return '';
  return str(`${maskEmail(list[0])}${list.length > 1 ? ` (+${list.length - 1})` : ''}`, 120);
}

/** Maakt van een payload een schone rij, of null als het event niet bekend is (wordt dan genegeerd). */
export function normalize(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const level = Object.hasOwn(EVENTS, p.event) ? EVENTS[p.event] : null;
  if (!level) return null;
  const mail = p.mail && typeof p.mail === 'object' && !Array.isArray(p.mail) ? p.mail : {};
  const siteUrl = httpUrl(p.site_url, 300);
  const host = hostOf(siteUrl);
  const err = str(mail.error, 500);
  const backupErr = str(mail.backup_error, 500);
  const suppressed = Number.isFinite(+p.suppressed) && +p.suppressed > 0 ? Math.min(Math.floor(+p.suppressed), 100_000) : 0;
  return {
    event: p.event, level,
    site_host: host,
    site_title: str(p.site_title, 120) || host || 'Onbekende site',
    site_url: siteUrl,
    subject: str(mail.subject, 200),
    recipient: recipientOf(mail.to),
    error: str([err || str(p.message, 500), backupErr && `Backup: ${backupErr}`].filter(Boolean).join(' · '), 500),
    diagnose_title: str(mail.diagnose_title, 120),
    initiator: str(mail.initiator, 80),
    maillog_url: httpUrl(p.maillog_url, 500),
    count: 1 + suppressed,
  };
}

/** Verwerkt een (geldige) melding: dedupliceren per site + soort, herstel ruimt fout/backup op. */
export function record(a, tokenId = null, now = nowSec()) {
  if (a.event === 'smtp.recovered') {
    store.expireMailAlerts(a.site_host, a.site_title, ['smtp.failed', 'smtp.backup_used'], now);
  }
  const expires = now + (a.event === 'smtp.recovered' ? RECOVERED_SECONDS : displayMinutes() * 60);
  const current = store.activeMailAlert(a.site_host, a.site_title, a.event, now);
  if (current) {
    store.updateMailAlert(current.id, { ...a, last_at: now, expires_at: expires });
  } else {
    store.insertMailAlert({ ...a, token_id: tokenId, first_at: now, last_at: now, expires_at: expires });
  }
}

/** Testmelding vanuit Beheer, via dezelfde verwerking als de webhook. */
export function recordTest(publicUrl) {
  record(normalize({
    event: 'smtp.test', site_title: 'Testmelding ServerDash', site_url: publicUrl || 'https://serverdash.test/',
    message: 'Zo ziet een e-mailmelding eruit. De echte meldingen komen van de SMTP-logger op de WordPress-sites.',
    mail: { to: ['info@voorbeeld.nl'], subject: 'Testmelding', initiator: 'Beheer' },
  }));
}

/** Actieve meldingen voor overzicht en tv-modus (zwaarste eerst, dan nieuwste). */
export function activeAlerts(now = nowSec()) {
  const rank = { crit: 0, warn: 1, info: 2, ok: 3 };
  return store.activeMailAlerts(now)
    .map(({ token_id, dismissed_at, ...a }) => a)
    .sort((a, b) => rank[a.level] - rank[b.level] || b.last_at - a.last_at);
}

// ---------- tokens ----------

/** Zoekt het token op met een constant-time vergelijking van de sha256-hash. */
function tokenId(token) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const hash = Buffer.from(store.hashToken(token), 'hex');
  let found = null;
  for (const row of store.hookTokenHashes()) {
    const h = Buffer.from(row.token_hash, 'hex');
    if (h.length === hash.length && crypto.timingSafeEqual(h, hash)) found = row.id;
  }
  return found;
}

// ---------- rate limiting ----------

const windows = new Map();   // 't:<id>' / 'ip:<adres>' -> { start, n }

function overLimit(key, limit) {
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
    w = { start: now, n: 0 };
    windows.set(key, w);
  }
  return ++w.n > limit;
}

// ---------- HTTP ----------

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export const isHookPath = (p) => p === '/hooks/mail' || p.startsWith('/hooks/mail/');

/**
 * Afhandeling van /hooks/mail[/<token>]. Werkt zonder sessie of CSRF-controle: het token is de authenticatie.
 * 404 bij een onbekend token (zonder details), 413 > 32 KB, 400 ongeldige JSON, 429 te veel verzoeken.
 */
export function handleMailHook(req, res, pathname, ip) {
  const rest = pathname.slice('/hooks/mail'.length);
  if (rest && !/^\/[^/]+\/?$/.test(rest)) return reply(res, 404, { error: 'Niet gevonden' });
  if (req.method !== 'POST') return reply(res, 405, { error: 'Methode niet toegestaan' }, { Allow: 'POST' });

  let token = rest.replace(/^\/|\/$/g, '');
  try { token = decodeURIComponent(token); } catch { token = ''; }
  if (!token) token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  const id = token ? tokenId(token) : null;
  if (!id) {
    if (overLimit(`ip:${ip}`, BAD_TOKEN_LIMIT)) return reply(res, 429, { error: 'Te veel verzoeken' }, { 'Retry-After': '60' });
    return reply(res, 404, { error: 'Niet gevonden' });
  }
  if (overLimit(`t:${id}`, RATE_LIMIT)) return reply(res, 429, { error: 'Te veel verzoeken' }, { 'Retry-After': '60' });

  const ctype = String(req.headers['content-type'] || '');
  if (ctype && !/json/i.test(ctype)) return reply(res, 415, { error: 'Content-Type moet application/json zijn' });
  const tooLarge = () => {
    reply(res, 413, { error: 'Payload te groot' }, { Connection: 'close' });
    res.on('finish', () => req.destroy());
  };
  if (+req.headers['content-length'] > MAX_BODY) return tooLarge();

  const chunks = [];
  let size = 0, done = false;
  req.on('data', (c) => {
    if (done) return;
    size += c.length;
    if (size > MAX_BODY) { done = true; tooLarge(); return; }
    chunks.push(c);
  });
  req.on('error', () => { done = true; });
  req.on('end', () => {
    if (done) return;
    done = true;
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, { error: 'Ongeldige JSON' }); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply(res, 400, { error: 'Ongeldige payload' });
    const now = nowSec();
    try {
      store.touchHookToken(id, now);
      const a = normalize(payload);
      if (a) record(a, id, now);   // onbekende events: 200, maar genegeerd
    } catch (e) {
      console.error('Webhook e-mailmelding:', e.message);
      return reply(res, 500, { error: 'Interne fout' });
    }
    reply(res, 200, { ok: true });
  });
}
