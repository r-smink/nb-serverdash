import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { config } from './config.js';
import * as store from './db.js';
import { evaluate, mergeThresholds, DEFAULT_THRESHOLDS } from './status.js';

if (!config.adminPassword) {
  console.error('ADMIN_PASSWORD is niet ingesteld. Kopieer .env.example naar .env en vul een wachtwoord in.');
  process.exit(1);
}

const { nowSec } = store;
const SERVER_TYPES = ['plesk', 'nameserver', 'database', 'other'];
const PUBLIC_DIR = path.join(config.root, 'public');
const STATIC_MAP = {
  '/vendor/uPlot.iife.min.js': path.join(config.root, 'node_modules/uplot/dist/uPlot.iife.min.js'),
  '/vendor/uPlot.min.css': path.join(config.root, 'node_modules/uplot/dist/uPlot.min.css'),
  '/agent/install.sh': path.join(config.root, 'agent/install.sh'),
  '/agent/nb-agent.py': path.join(config.root, 'agent/nb-agent.py'),
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.sh': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8',
};

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Payload te groot')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Ongeldige JSON')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const clientIp = (req) => (config.trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
const isHttps = (req) => config.secureCookie || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');

function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

// ---------- sessies ----------

const sessionSecret = config.sessionSecret || store.getOrCreateSecret();
const SESSION_TTL = 7 * 86400;
const sign = (data) => crypto.createHmac('sha256', sessionSecret).update(data).digest('base64url');

function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, e: nowSec() + SESSION_TTL })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const raw = parseCookies(req).sd_session;
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.e > nowSec() ? data : null;
  } catch { return null; }
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const loginFailures = new Map(); // ip -> {count, until}

// ---------- in-memory staat ----------

const RECENT_WINDOW = 3600;
const recent = new Map();        // serverId -> [{ts, cpu, iowait, load1, mem_pct}]
const payloadCache = new Map();  // serverId -> {seen, payload}
const lastSnapshot = new Map();  // serverId -> ts
const levels = new Map();        // serverId -> laatst bekende status-level

function getRecent(id) {
  let list = recent.get(id);
  if (!list) {
    list = store.recentMetrics(id, nowSec() - RECENT_WINDOW);
    recent.set(id, list);
  }
  return list;
}

function pushRecent(id, sample) {
  const list = getRecent(id);
  if (list.length && list[list.length - 1].ts >= sample.ts) return;
  list.push(sample);
  const cutoff = nowSec() - RECENT_WINDOW;
  while (list.length && list[0].ts < cutoff) list.shift();
}

function payloadOf(s) {
  if (!s.last_payload) return null;
  const cached = payloadCache.get(s.id);
  if (cached && cached.seen === s.last_seen && cached.len === s.last_payload.length) return cached.payload;
  let payload = null;
  try { payload = JSON.parse(s.last_payload); } catch { /* negeren */ }
  payloadCache.set(s.id, { seen: s.last_seen, len: s.last_payload.length, payload });
  return payload;
}

const thresholds = () => mergeThresholds(store.getSetting('thresholds'));

function statusOf(s, th = thresholds(), now = nowSec()) {
  return evaluate(s, payloadOf(s), getRecent(s.id), th, now);
}

function sparkline(id, now) {
  const points = new Array(60).fill(null);
  const counts = new Array(60).fill(0);
  const start = now - 3600;
  for (const r of getRecent(id)) {
    const i = Math.floor((r.ts - start) / 60);
    if (i < 0 || i >= 60 || r.cpu == null) continue;
    points[i] = (points[i] ?? 0) + r.cpu;
    counts[i]++;
  }
  return points.map((v, i) => (v == null ? null : Math.round((v / counts[i]) * 10) / 10));
}

function serverSummary(s, th, now) {
  const p = payloadOf(s);
  const status = evaluate(s, p, getRecent(s.id), th, now);
  let summary = null;
  if (p) {
    const disk = (p.disks || []).reduce((a, d) => (!a || d.pct > a.pct ? d : a), null);
    summary = {
      cpu: p.cpu?.pct, cores: p.cpu?.cores, load: p.load || [], mem_pct: p.mem?.pct, mem_total: p.mem?.total,
      swap_pct: p.mem?.swap_pct, disk: disk && { mount: disk.mount, pct: disk.pct },
      net_rx: p.net?.rx, net_tx: p.net?.tx, uptime: p.system?.uptime, plesk: p.system?.plesk, os: p.system?.os,
    };
  }
  return {
    id: s.id, name: s.name, hostname: s.hostname, type: s.type, notes: s.notes, muted: !!s.muted,
    created_at: s.created_at, last_seen: s.last_seen, agent: p?.agent || null, status, summary,
    spark: sparkline(s.id, now),
  };
}

// ---------- events & notificaties ----------

const LEVEL_TEXT = { crit: 'Kritiek', warn: 'Waarschuwing', ok: 'Hersteld' };

function trackLevel(s, status, now, silent = false) {
  const lvl = status.level;
  const prev = levels.get(s.id);
  levels.set(s.id, lvl);
  if (silent || prev === undefined || prev === lvl || lvl === 'pending' || lvl === 'muted') return;
  if ((prev === 'muted' || prev === 'pending') && lvl === 'ok') return;
  const msgs = status.issues.filter((i) => i.level === 'crit' || i.level === 'warn').map((i) => i.msg).join(', ');
  const message = lvl === 'ok' ? 'Hersteld — alles weer binnen de drempels' : `${LEVEL_TEXT[lvl]}: ${msgs}`;
  store.addEvent(s.id, now, lvl, message);
  notify(s, lvl, message);
}

function notify(s, level, message) {
  const url = store.getSetting('webhookUrl', '');
  if (!url) return;
  const icon = { crit: '🔴', warn: '🟠', ok: '🟢' }[level] || '';
  const text = `${icon} ${s.name}${s.hostname ? ` (${s.hostname})` : ''}: ${message}`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, content: text, server: s.name, hostname: s.hostname, level, message }),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => console.warn(`Webhook mislukt: ${e.message}`));
}

function checkAll(silent = false) {
  const th = thresholds();
  const now = nowSec();
  const servers = store.listServers();
  const ids = new Set(servers.map((s) => s.id));
  for (const s of servers) trackLevel(s, statusOf(s, th, now), now, silent);
  for (const id of levels.keys()) if (!ids.has(id)) { levels.delete(id); recent.delete(id); payloadCache.delete(id); }
}

// ---------- router ----------

const routes = [];
function on(method, pattern, handler, { auth = true } = {}) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler, auth });
}

function requireServer(id) {
  const s = store.getServer(Number(id));
  if (!s) throw new HttpError(404, 'Server niet gevonden');
  return s;
}

function validateServer(body) {
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'Naam is verplicht');
  const type = SERVER_TYPES.includes(body.type) ? body.type : 'other';
  return {
    name, type,
    hostname: String(body.hostname || '').trim().slice(0, 255),
    notes: String(body.notes || '').slice(0, 2000),
    muted: !!body.muted,
  };
}

function installCommand(req, token) {
  const base = baseUrl(req);
  return `curl -fsSL ${base}/agent/install.sh | sudo bash -s -- --url ${base} --token ${token}`;
}

// --- auth ---

on('POST', '/api/login', ({ req, res, body }) => {
  const ip = clientIp(req);
  const f = loginFailures.get(ip);
  if (f && f.count >= 10 && f.until > Date.now()) throw new HttpError(429, 'Te veel pogingen, probeer het over 15 minuten opnieuw');
  if (!safeEqual(body.username, config.adminUser) || !safeEqual(body.password, config.adminPassword)) {
    const entry = f && f.until > Date.now() ? f : { count: 0, until: Date.now() + 15 * 60_000 };
    entry.count++;
    loginFailures.set(ip, entry);
    throw new HttpError(401, 'Onjuiste gebruikersnaam of wachtwoord');
  }
  loginFailures.delete(ip);
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sd_session=${makeSession(config.adminUser)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL}${secure}`);
  return { ok: true };
}, { auth: false });

on('POST', '/api/logout', ({ res }) => {
  res.setHeader('Set-Cookie', 'sd_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return { ok: true };
}, { auth: false });

on('GET', '/api/me', ({ user }) => ({ user: user.u }));

// --- agent ingest ---

on('POST', '/api/ingest', ({ req, body }) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = token && store.serverByToken(token);
  if (!s) throw new HttpError(401, 'Ongeldig token');
  if (!body || typeof body !== 'object' || !body.cpu) throw new HttpError(400, 'Ongeldige payload');

  const now = nowSec();
  let ts = Math.floor(+body.ts || now);
  if (ts > now + 60 || ts < now - 86400) ts = now;

  store.insertMetrics(s.id, ts, store.metricsFromPayload(body));

  if (body.procs?.list && ts - (lastSnapshot.get(s.id) || 0) >= config.procSnapshotInterval) {
    const snap = { total: body.procs.total, running: body.procs.running, list: body.procs.list, users: body.procs.users };
    store.insertSnapshot(s.id, ts, zlib.deflateSync(JSON.stringify(snap)));
    lastSnapshot.set(s.id, ts);
  }

  // Alleen nieuwste payload als "huidige staat" bewaren (agent kan oude payloads nasturen).
  const prevPayload = payloadOf(s);
  if (!prevPayload || (prevPayload.ts || 0) <= ts) {
    body.ts = ts;
    const json = JSON.stringify(body);
    store.markSeen(s.id, now, json);
    s.last_seen = now;
    s.last_payload = json;
    payloadCache.set(s.id, { seen: now, len: json.length, payload: body });
  }
  pushRecent(s.id, { ts, cpu: body.cpu?.pct ?? null, iowait: body.cpu?.iowait ?? null, load1: body.load?.[0] ?? null, mem_pct: body.mem?.pct ?? null });
  trackLevel(s, statusOf(s, thresholds(), now), now);
  return { ok: true };
}, { auth: false });

// --- dashboard ---

on('GET', '/api/overview', () => {
  const th = thresholds();
  const now = nowSec();
  return {
    now,
    thresholds: th,
    enlarge: store.getSetting('enlargeProblems', true),
    servers: store.listServers().map((s) => serverSummary(s, th, now)),
    events: store.recentEvents(25),
  };
});

on('GET', '/api/servers/:id', ({ params }) => {
  const s = requireServer(params.id);
  const th = thresholds();
  return { ...serverSummary(s, th, nowSec()), thresholds: th, payload: payloadOf(s), events: store.serverEvents(s.id, 50) };
});

on('GET', '/api/servers/:id/metrics', ({ params, query }) => {
  const s = requireServer(params.id);
  const now = nowSec();
  let to = Math.floor(+query.get('to') || now);
  let from = Math.floor(+query.get('from') || 0);
  if (!from) from = to - Math.min(Math.max(+query.get('range') || 3600, 300), 31 * 86400);
  if (from >= to) throw new HttpError(400, 'Ongeldige periode');
  const range = to - from;
  const bucket = Math.max(10, Math.floor(range / 400));
  return {
    from, to, bucket,
    cores: payloadOf(s)?.cpu?.cores || null,
    series: store.queryMetrics(s.id, from, to, bucket),
    disks: store.queryDisks(s.id, from, to, Math.max(bucket, Math.floor(range / 150))),
  };
});

on('GET', '/api/servers/:id/processes', ({ params, query }) => {
  const s = requireServer(params.id);
  const ts = Math.floor(+query.get('ts'));
  if (!ts) {
    const p = payloadOf(s);
    return { ts: p?.ts || null, live: true, procs: p?.procs || null };
  }
  const snap = store.snapshotNear(s.id, ts);
  if (!snap) return { ts: null, procs: null };
  return { ts: snap.ts, live: false, procs: JSON.parse(zlib.inflateSync(snap.data).toString()) };
});

// --- beheer ---

on('POST', '/api/servers', ({ req, body }) => {
  const data = validateServer(body);
  const { server, token } = store.createServer(data);
  checkAll(true);
  return { server: { id: server.id, name: server.name }, token, installCommand: installCommand(req, token) };
});

on('PUT', '/api/servers/:id', ({ params, body }) => {
  const s = requireServer(params.id);
  const updated = store.updateServer(s.id, validateServer({ ...s, muted: !!s.muted, ...body }));
  return { server: { id: updated.id, name: updated.name } };
});

on('POST', '/api/servers/:id/token', ({ req, params }) => {
  const s = requireServer(params.id);
  const token = store.regenerateToken(s.id);
  return { token, installCommand: installCommand(req, token) };
});

on('DELETE', '/api/servers/:id', ({ params }) => {
  const s = requireServer(params.id);
  store.deleteServer(s.id);
  checkAll(true);
  return { ok: true };
});

on('GET', '/api/settings', () => ({
  thresholds: thresholds(),
  defaults: DEFAULT_THRESHOLDS,
  webhookUrl: store.getSetting('webhookUrl', ''),
  enlargeProblems: store.getSetting('enlargeProblems', true),
}));

on('PUT', '/api/settings', ({ body }) => {
  if (body.thresholds) store.setSetting('thresholds', mergeThresholds(body.thresholds));
  if (body.webhookUrl !== undefined) {
    const url = String(body.webhookUrl || '').trim();
    if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, 'Webhook-URL moet met http(s):// beginnen');
    store.setSetting('webhookUrl', url);
  }
  if (body.enlargeProblems !== undefined) store.setSetting('enlargeProblems', !!body.enlargeProblems);
  return { ok: true };
});

on('POST', '/api/settings/test-webhook', () => {
  if (!store.getSetting('webhookUrl', '')) throw new HttpError(400, 'Geen webhook-URL ingesteld');
  notify({ name: 'ServerDash', hostname: '' }, 'ok', 'Testmelding — de webhook werkt');
  return { ok: true };
});

// ---------- static ----------

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Methode niet toegestaan' });
  let file = STATIC_MAP[pathname];
  if (!file) {
    if (pathname === '/' || pathname === '/index.html') {
      if (!readSession(req)) {
        res.writeHead(302, { Location: '/login.html' });
        return res.end();
      }
      file = path.join(PUBLIC_DIR, 'index.html');
    } else {
      file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Niet gevonden' });
    }
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'Niet gevonden' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': pathname.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let user = null;
      if (r.auth) {
        user = readSession(req);
        if (!user) throw new HttpError(401, 'Niet ingelogd');
        if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) {
          throw new HttpError(415, 'Content-Type moet application/json zijn');
        }
      }
      const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : null;
      const out = await r.handler({ req, res, params, query: url.searchParams, body, user });
      if (!res.writableEnded) send(res, 200, out ?? { ok: true });
      return;
    }
    throw new HttpError(404, 'Niet gevonden');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Interne fout' : e.message });
    else res.end();
  }
});

checkAll(true);
setInterval(() => { try { checkAll(); } catch (e) { console.error(e); } }, 15_000);
setInterval(() => { try { store.purge(); } catch (e) { console.error(e); } }, 3600_000);
setTimeout(() => store.purge(), 30_000);

server.listen(config.port, config.host, () => {
  console.log(`ServerDash draait op http://${config.host}:${config.port}`);
});
