import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { config } from './config.js';
import * as store from './db.js';
import { evaluate, evaluateSite, mergeThresholds, DEFAULT_THRESHOLDS } from './status.js';
import { checkUrl } from './checker.js';

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

// ---------- websites ----------

const SITE_RECENT_WINDOW = 3600;
const siteRecent = new Map();  // websiteId -> [{ts, cpu, rpm, s2..s5}]
const siteLevels = new Map();  // websiteId -> laatst bekende level

function getSiteRecent(id) {
  let list = siteRecent.get(id);
  if (!list) {
    list = store.recentSiteMetrics(id, nowSec() - SITE_RECENT_WINDOW);
    siteRecent.set(id, list);
  }
  return list;
}

function pushSiteRecent(id, sample) {
  const list = getSiteRecent(id);
  if (list.length && list[list.length - 1].ts >= sample.ts) return;
  list.push(sample);
  const cutoff = nowSec() - SITE_RECENT_WINDOW;
  while (list.length && list[0].ts < cutoff) list.shift();
}

const parse = (json) => { try { return json ? JSON.parse(json) : null; } catch { return null; } };

function siteStatus(w, server, th = thresholds(), now = nowSec()) {
  return evaluateSite(w, server, parse(w.last_stats), parse(w.last_check), getSiteRecent(w.id), th, now);
}

function siteSpark(id, now) {
  const points = new Array(60).fill(null);
  const start = now - 3600;
  for (const r of getSiteRecent(id)) {
    const i = Math.floor((r.ts - start) / 60);
    if (i >= 0 && i < 60 && r.rpm != null) points[i] = Math.max(points[i] ?? 0, r.rpm);
  }
  return points;
}

function siteSummary(w, serversById, th, now) {
  const server = serversById.get(w.server_id);
  const stats = parse(w.last_stats);
  const check = parse(w.last_check);
  return {
    id: w.id, domain: w.domain, url: w.url, keyword: w.keyword, check_enabled: !!w.check_enabled, notes: w.notes,
    server: server ? { id: server.id, name: server.name, hostname: server.hostname } : null,
    server_id: w.server_id,
    status: evaluateSite(w, server, stats, check, getSiteRecent(w.id), th, now),
    stats: stats && {
      found: stats.found, user: stats.user, cpu: stats.cpu, rss: stats.rss, rio: stats.rio, wio: stats.wio, procs: stats.procs,
      rpm: stats.rpm, bw: stats.bw, s2: stats.s2, s3: stats.s3, s4: stats.s4, s5: stats.s5, disk: stats.disk,
    },
    stats_ts: w.last_stats_ts,
    check, check_ts: w.last_check_ts,
    uptime24: store.uptimeSince(w.id, now - 86400),
    spark: siteSpark(w.id, now),
  };
}

function trackSiteLevel(w, server, status, now, silent = false) {
  const lvl = status.level;
  const prev = siteLevels.get(w.id);
  siteLevels.set(w.id, lvl);
  if (silent || prev === undefined || prev === lvl || lvl === 'pending' || lvl === 'muted' || !server) return;
  if (prev === 'pending' && lvl === 'ok') return;
  const msgs = status.issues.filter((i) => i.level === 'crit' || i.level === 'warn').map((i) => i.msg).join(', ');
  const message = `Website ${w.domain}: ${lvl === 'ok' ? 'hersteld' : `${LEVEL_TEXT[lvl].toLowerCase()} — ${msgs}`}`;
  store.addEvent(server.id, now, lvl, message);
  notify(server, lvl, message);
}

function checkAllSites(silent = false) {
  const th = thresholds();
  const now = nowSec();
  const servers = new Map(store.listServers().map((s) => [s.id, s]));
  const ids = new Set();
  for (const w of store.listWebsites()) {
    ids.add(w.id);
    trackSiteLevel(w, servers.get(w.server_id), siteStatus(w, servers.get(w.server_id), th, now), now, silent);
  }
  for (const id of siteLevels.keys()) if (!ids.has(id)) { siteLevels.delete(id); siteRecent.delete(id); }
}

// HTTP-checks: elke CHECK_INTERVAL seconden per website, max. 5 tegelijk.
const CHECK_INTERVAL = 60;
const checking = new Set();

async function runCheck(w) {
  checking.add(w.id);
  try {
    const result = await checkUrl(w.url, { keyword: w.keyword });
    const now = nowSec();
    const fresh = store.getWebsite(w.id);
    if (!fresh) return result;
    const failCount = result.ok ? 0 : fresh.fail_count + 1;
    store.insertCheck(w.id, now, result.ok, result.status, result.ms);
    store.setSiteCheck(w.id, now, JSON.stringify({ ...result, ts: now }), failCount);
    const updated = store.getWebsite(w.id);
    const server = store.getServer(updated.server_id);
    trackSiteLevel(updated, server, siteStatus(updated, server, thresholds(), now), now);
    return result;
  } finally {
    checking.delete(w.id);
  }
}

async function checkDueSites() {
  const now = nowSec();
  const due = store.listWebsites()
    .filter((w) => w.check_enabled && w.url && !checking.has(w.id) && (!w.last_check_ts || now - w.last_check_ts >= CHECK_INTERVAL - 5));
  for (let i = 0; i < due.length; i += 5) {
    await Promise.all(due.slice(i, i + 5).map((w) => runCheck(w).catch((e) => console.warn(`Check ${w.domain}: ${e.message}`))));
  }
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

  // Websites op deze server: statistieken opslaan en de lijst domeinen teruggeven,
  // zodat de agent weet welke sites hij de volgende keer moet meten.
  const sites = store.websitesForServer(s.id);
  if (body.sites && typeof body.sites === 'object') {
    for (const w of sites) {
      const st = body.sites[w.domain];
      if (!st || typeof st !== 'object') continue;
      if (st.found) {
        store.insertSiteMetrics(w.id, ts, st);
        pushSiteRecent(w.id, { ts, cpu: st.cpu ?? null, rpm: st.rpm ?? null, s2: st.s2 ?? 0, s3: st.s3 ?? 0, s4: st.s4 ?? 0, s5: st.s5 ?? 0 });
      }
      store.setSiteStats(w.id, now, JSON.stringify(st));
    }
  }
  return { ok: true, sites: sites.map((w) => w.domain) };
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
  const now = nowSec();
  const websites = store.websitesForServer(s.id).map((w) => ({ id: w.id, domain: w.domain, level: siteStatus(w, s, th, now).level }));
  return { ...serverSummary(s, th, now), thresholds: th, payload: payloadOf(s), events: store.serverEvents(s.id, 50), websites };
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

// --- websites ---

function normalizeDomain(input) {
  const raw = String(input || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0];
  let host;
  try { host = new URL(`http://${raw}`).hostname; } catch { host = ''; }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) throw new HttpError(400, 'Ongeldig domein');
  return host;
}

function validateWebsite(body) {
  const server = store.getServer(Number(body.server_id));
  if (!server) throw new HttpError(400, 'Kies een server');
  const domain = normalizeDomain(body.domain);
  let url = String(body.url || '').trim() || `https://${domain}/`;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
    url = u.href;
  } catch { throw new HttpError(400, 'Ongeldige controle-URL'); }
  return {
    server_id: server.id, domain, url,
    keyword: String(body.keyword || '').slice(0, 200),
    check_enabled: body.check_enabled !== false,
    notes: String(body.notes || '').slice(0, 2000),
  };
}

function requireWebsite(id) {
  const w = store.getWebsite(Number(id));
  if (!w) throw new HttpError(404, 'Website niet gevonden');
  return w;
}

on('GET', '/api/websites', () => {
  const th = thresholds();
  const now = nowSec();
  const servers = store.listServers();
  const byId = new Map(servers.map((s) => [s.id, s]));
  return {
    thresholds: th,
    enlarge: store.getSetting('enlargeProblems', true),
    servers: servers.map((s) => ({ id: s.id, name: s.name, type: s.type })),
    websites: store.listWebsites().map((w) => siteSummary(w, byId, th, now)),
  };
});

on('GET', '/api/websites/:id', ({ params }) => {
  const w = requireWebsite(params.id);
  const th = thresholds();
  const now = nowSec();
  const server = store.getServer(w.server_id);
  const summary = siteSummary(w, new Map(server ? [[server.id, server]] : []), th, now);
  const sp = server && payloadOf(server);
  return {
    ...summary,
    thresholds: th,
    fullStats: parse(w.last_stats),
    uptime7d: store.uptimeSince(w.id, now - 7 * 86400),
    uptime30d: store.uptimeSince(w.id, now - 30 * 86400),
    serverInfo: server && { cores: sp?.cpu?.cores, mem_total: sp?.mem?.total, cpu: sp?.cpu?.pct, level: statusOf(server, th, now).level },
  };
});

on('GET', '/api/websites/:id/metrics', ({ params, query }) => {
  const w = requireWebsite(params.id);
  const now = nowSec();
  const to = Math.floor(+query.get('to') || now);
  let from = Math.floor(+query.get('from') || 0);
  if (!from) from = to - Math.min(Math.max(+query.get('range') || 3600, 300), 31 * 86400);
  if (from >= to) throw new HttpError(400, 'Ongeldige periode');
  const bucket = Math.max(10, Math.floor((to - from) / 400));
  return {
    from, to, bucket,
    site: store.querySiteMetrics(w.id, from, to, bucket),
    checks: store.queryChecks(w.id, from, to, bucket),
  };
});

on('POST', '/api/websites', ({ body }) => {
  const w = store.createWebsite(validateWebsite(body));
  if (w.check_enabled) runCheck(w).catch(() => {});
  return { website: { id: w.id, domain: w.domain } };
});

on('PUT', '/api/websites/:id', ({ params, body }) => {
  const w = requireWebsite(params.id);
  const updated = store.updateWebsite(w.id, validateWebsite({ ...w, check_enabled: !!w.check_enabled, ...body }));
  return { website: { id: updated.id, domain: updated.domain } };
});

on('DELETE', '/api/websites/:id', ({ params }) => {
  const w = requireWebsite(params.id);
  store.deleteWebsite(w.id);
  siteLevels.delete(w.id);
  siteRecent.delete(w.id);
  return { ok: true };
});

on('POST', '/api/websites/:id/check', async ({ params }) => {
  const w = requireWebsite(params.id);
  if (!w.url) throw new HttpError(400, 'Geen controle-URL ingesteld');
  if (checking.has(w.id)) throw new HttpError(409, 'Controle loopt al');
  return { result: await runCheck(w) };
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
checkAllSites(true);
setInterval(() => {
  try { checkAll(); checkAllSites(); } catch (e) { console.error(e); }
}, 15_000);
let checkLoopBusy = false;
setInterval(async () => {
  if (checkLoopBusy) return;
  checkLoopBusy = true;
  try { await checkDueSites(); } catch (e) { console.error(e); } finally { checkLoopBusy = false; }
}, 10_000);
setInterval(() => { try { store.purge(); } catch (e) { console.error(e); } }, 3600_000);
setTimeout(() => store.purge(), 30_000);

server.listen(config.port, config.host, () => {
  console.log(`ServerDash draait op http://${config.host}:${config.port}`);
});
