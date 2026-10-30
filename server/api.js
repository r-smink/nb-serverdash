// Alle API-routes.
import zlib from 'node:zlib';
import { config } from './config.js';
import * as store from './db.js';
import * as auth from './auth.js';
import * as mon from './monitor.js';
import { DEFAULT_THRESHOLDS, mergeThresholds } from './status.js';
import { maskedNotifyConfig, saveNotifyConfig, notify } from './alerts.js';
import { diskForecast, wordpressOverview, refreshWporg, cmpVersion } from './insights.js';

const { nowSec } = store;
const SERVER_TYPES = ['plesk', 'nameserver', 'database', 'other'];

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- router ----------

export const routes = [];
/**
 * @param opts.auth  false = openbaar (login, ingest, health)
 * @param opts.role  minimale rol; standaard 'viewer' voor GET en 'admin' voor wijzigingen
 */
function on(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({
    method, re, keys, handler,
    auth: opts.auth !== false,
    role: opts.role || (method === 'GET' ? 'viewer' : 'admin'),
  });
}

const clientIp = (req) => (config.trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
const isHttps = (req) => config.secureCookie || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');

function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function rangeParam(query, def = 86400, max = 400 * 86400) {
  return Math.min(Math.max(+query.get('range') || def, 300), max);
}

function periodParams(query) {
  const now = nowSec();
  const to = Math.floor(+query.get('to') || now);
  let from = Math.floor(+query.get('from') || 0);
  if (!from) from = to - rangeParam(query, 3600);
  if (from >= to) throw new HttpError(400, 'Ongeldige periode');
  return { from, to, bucket: Math.max(10, Math.floor((to - from) / 400)) };
}

// ---------- auth & account ----------

on('POST', '/api/login', ({ req, res, body }) => {
  const ip = clientIp(req);
  if (!auth.checkRateLimit(ip)) throw new HttpError(429, 'Te veel pogingen, probeer het over 15 minuten opnieuw');
  const u = store.userByName(String(body.username || '').trim());
  if (!u || !auth.verifyPassword(body.password, u.pass_hash)) {
    auth.registerFailure(ip);
    throw new HttpError(401, 'Onjuiste gebruikersnaam of wachtwoord');
  }
  if (u.totp_secret) {
    if (!body.code) return { needCode: true };
    if (!auth.verifyTotp(u.totp_secret, body.code, u.id)) {
      auth.registerFailure(ip);
      throw new HttpError(401, 'Onjuiste of verlopen code');
    }
  }
  auth.clearFailures(ip);
  store.updateUser(u.id, { last_login: nowSec() });
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sd_session=${auth.makeSession(u)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${auth.SESSION_TTL}${secure}`);
  return { ok: true };
}, { auth: false });

on('POST', '/api/logout', ({ res }) => {
  res.setHeader('Set-Cookie', 'sd_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return { ok: true };
}, { auth: false });

on('GET', '/api/me', ({ user }) => ({ user }));

on('POST', '/api/account/password', ({ user, body }) => {
  const u = store.getUser(user.id);
  if (!auth.verifyPassword(body.current, u.pass_hash)) throw new HttpError(400, 'Huidig wachtwoord klopt niet');
  const err = auth.validatePassword(body.password);
  if (err) throw new HttpError(400, err);
  store.updateUser(u.id, { pass_hash: auth.hashPassword(body.password) });
  return { ok: true, relogin: true };
}, { role: 'viewer' });

on('POST', '/api/account/2fa/setup', async ({ user }) => {
  const setup = await auth.newTotpSetup(user.username);
  store.updateUser(user.id, { totp_pending: setup.secret });
  return setup;
}, { role: 'viewer' });

on('POST', '/api/account/2fa/enable', ({ user, body }) => {
  const u = store.getUser(user.id);
  if (!u.totp_pending) throw new HttpError(400, 'Start eerst de instelling van 2FA');
  if (!auth.verifyTotp(u.totp_pending, body.code)) throw new HttpError(400, 'Code klopt niet — controleer de tijd op je telefoon');
  store.updateUser(u.id, { totp_secret: u.totp_pending, totp_pending: null });
  return { ok: true, relogin: true };
}, { role: 'viewer' });

on('POST', '/api/account/2fa/disable', ({ user, body }) => {
  const u = store.getUser(user.id);
  if (!auth.verifyPassword(body.password, u.pass_hash)) throw new HttpError(400, 'Wachtwoord klopt niet');
  store.updateUser(u.id, { totp_secret: null, totp_pending: null });
  return { ok: true, relogin: true };
}, { role: 'viewer' });

// --- gebruikersbeheer ---

on('GET', '/api/users', () => ({ users: store.listUsers().map(auth.publicUser) }), { role: 'admin' });

on('POST', '/api/users', ({ body }) => {
  const username = String(body.username || '').trim();
  if (!/^[\w.@-]{2,64}$/.test(username)) throw new HttpError(400, 'Gebruikersnaam: 2–64 tekens (letters, cijfers, . _ - @)');
  if (store.userByName(username)) throw new HttpError(400, 'Gebruikersnaam bestaat al');
  const err = auth.validatePassword(body.password);
  if (err) throw new HttpError(400, err);
  const role = auth.ROLES.includes(body.role) ? body.role : 'viewer';
  return { user: auth.publicUser(store.createUser(username, auth.hashPassword(body.password), role)) };
});

function adminCount() { return store.listUsers().filter((u) => u.role === 'admin').length; }

on('PUT', '/api/users/:id', ({ params, body, user }) => {
  const u = store.getUser(+params.id);
  if (!u) throw new HttpError(404, 'Gebruiker niet gevonden');
  const fields = {};
  if (body.role && auth.ROLES.includes(body.role) && body.role !== u.role) {
    if (u.role === 'admin' && adminCount() <= 1) throw new HttpError(400, 'Er moet minimaal één beheerder blijven');
    if (u.id === user.id) throw new HttpError(400, 'Je kunt je eigen rol niet wijzigen');
    fields.role = body.role;
  }
  if (body.password) {
    const err = auth.validatePassword(body.password);
    if (err) throw new HttpError(400, err);
    fields.pass_hash = auth.hashPassword(body.password);
  }
  if (body.reset2fa) { fields.totp_secret = null; fields.totp_pending = null; }
  return { user: auth.publicUser(store.updateUser(u.id, fields)) };
});

on('DELETE', '/api/users/:id', ({ params, user }) => {
  const u = store.getUser(+params.id);
  if (!u) throw new HttpError(404, 'Gebruiker niet gevonden');
  if (u.id === user.id) throw new HttpError(400, 'Je kunt jezelf niet verwijderen');
  if (u.role === 'admin' && adminCount() <= 1) throw new HttpError(400, 'Er moet minimaal één beheerder blijven');
  store.deleteUser(u.id);
  return { ok: true };
});

// ---------- health (voor externe bewaking van het dashboard zelf) ----------

on('GET', '/api/health', ({ res }) => {
  const servers = store.listServers().length;
  const age = mon.lastIngestTime() ? nowSec() - mon.lastIngestTime() : null;
  const ok = !servers || (age != null && age < 300);
  if (!ok) res.statusCode = 503;
  return { ok, servers, lastIngestAge: age, time: nowSec() };
}, { auth: false });

// ---------- agent ----------

on('POST', '/api/ingest', ({ req, body }) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = token && store.serverByToken(token);
  if (!s) throw new HttpError(401, 'Ongeldig token');
  if (!body || typeof body !== 'object' || !body.cpu) throw new HttpError(400, 'Ongeldige payload');
  return { ok: true, sites: mon.ingest(s, body) };
}, { auth: false });

// ---------- overzicht & servers ----------

on('GET', '/api/overview', () => {
  const th = mon.thresholds();
  const now = nowSec();
  return {
    now, thresholds: th,
    enlarge: store.getSetting('enlargeProblems', true),
    servers: store.listServers().map((s) => mon.serverSummary(s, th, now)),
    events: store.recentEvents(25),
    openIncidents: store.openIncidents().length,
  };
});

/** Gecombineerde data voor de tv-modus. */
on('GET', '/api/tv', () => {
  const th = mon.thresholds();
  const now = nowSec();
  const servers = store.listServers();
  const byId = new Map(servers.map((s) => [s.id, s]));
  return {
    now, thresholds: th,
    servers: servers.map((s) => mon.serverSummary(s, th, now)),
    websites: store.listWebsites().map((w) => mon.siteSummary(w, byId, th, now))
      .map(({ id, domain, server, status, check, stats }) => ({ id, domain, server, status, check, rpm: stats?.rpm })),
    incidents: store.openIncidents().length,
  };
});

function requireServer(id) {
  const s = store.getServer(Number(id));
  if (!s) throw new HttpError(404, 'Server niet gevonden');
  return s;
}

function validateServer(body, current = {}) {
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'Naam is verplicht');
  const cfgIn = body.config || current.config || {};
  const ports = String(cfgIn.ports || '').split(/[\s,;]+/).filter(Boolean);
  if (ports.some((p) => !(+p > 0 && +p < 65536))) throw new HttpError(400, 'Poorten: komma-gescheiden nummers, bijv. 443,8443');
  return {
    name,
    type: SERVER_TYPES.includes(body.type) ? body.type : 'other',
    hostname: String(body.hostname || '').trim().slice(0, 255),
    notes: String(body.notes || '').slice(0, 2000),
    muted: !!body.muted,
    config: {
      ports: ports.join(','),
      reachHost: String(cfgIn.reachHost || '').trim().slice(0, 255),
      reach: cfgIn.reach !== false,
      backup: {
        enabled: cfgIn.backup?.enabled !== false,
        maxAgeHours: Math.max(0, Math.min(24 * 31, Math.floor(+cfgIn.backup?.maxAgeHours || 0))),
      },
    },
  };
}

function installCommand(req, token) {
  const base = baseUrl(req);
  return `curl -fsSL ${base}/agent/install.sh | sudo bash -s -- --url ${base} --token ${token}`;
}

on('GET', '/api/servers/:id', ({ params }) => {
  const s = requireServer(params.id);
  const th = mon.thresholds();
  const now = nowSec();
  const extra = mon.extraOf(s);
  const p = mon.payloadOf(s);
  const websites = store.websitesForServer(s.id).map((w) => ({ id: w.id, domain: w.domain, level: mon.siteStatus(w, s, th, now).level }));
  const forecast = diskForecast(s.id, now).map((f) => {
    const d = (p?.disks || []).find((x) => x.mount === f.mount);
    return { ...f, total: d?.total ?? null, bytesPerDay: d && f.perDay != null ? (f.perDay / 100) * d.total : null };
  });
  return {
    ...mon.serverSummary(s, th, now), thresholds: th, payload: p, events: store.serverEvents(s.id, 50), websites,
    forecast, reach: mon.reachOf(s), reachTarget: mon.reachTarget(s),
    backups: extra.backups || null, updates: extra.updates || null, dbs: extra.dbs || null, dbs_ts: extra.dbs_ts || null,
    wordpress: (extra.wordpress?.sites || []).length,
    incidents: store.listIncidents({ serverId: s.id, from: now - 30 * 86400, limit: 20 }),
  };
});

on('GET', '/api/servers/:id/metrics', ({ params, query }) => {
  const s = requireServer(params.id);
  const { from, to, bucket } = periodParams(query);
  return {
    from, to, bucket,
    cores: mon.payloadOf(s)?.cpu?.cores || null,
    series: store.queryMetrics(s.id, from, to, bucket),
    disks: store.queryDisks(s.id, from, to, Math.max(bucket, Math.floor((to - from) / 150))),
    reach: store.queryServerChecks(s.id, from, to, bucket),
  };
});

on('GET', '/api/servers/:id/processes', ({ params, query }) => {
  const s = requireServer(params.id);
  const ts = Math.floor(+query.get('ts'));
  if (!ts) {
    const p = mon.payloadOf(s);
    return { ts: p?.ts || null, live: true, procs: p?.procs || null };
  }
  const snap = store.snapshotNear(s.id, ts);
  if (!snap) return { ts: null, procs: null };
  return { ts: snap.ts, live: false, procs: JSON.parse(zlib.inflateSync(snap.data).toString()) };
});

on('POST', '/api/servers', ({ req, body }) => {
  const { server, token } = store.createServer(validateServer(body));
  mon.checkAll(true);
  return { server: { id: server.id, name: server.name }, token, installCommand: installCommand(req, token) };
});

on('PUT', '/api/servers/:id', ({ params, body }) => {
  const s = requireServer(params.id);
  const current = { ...s, muted: !!s.muted, config: mon.configOf(s) };
  const updated = store.updateServer(s.id, validateServer({ ...current, ...body }, current));
  return { server: { id: updated.id, name: updated.name } };
});

on('POST', '/api/servers/:id/token', ({ req, params }) => {
  const s = requireServer(params.id);
  const token = store.regenerateToken(s.id);
  return { token, installCommand: installCommand(req, token) };
});

on('POST', '/api/servers/:id/reach', async ({ params }) => {
  const s = requireServer(params.id);
  const r = await mon.checkReach(s);
  if (!r) throw new HttpError(400, 'Geen hostname of poorten ingesteld voor de TCP-check');
  return { reach: r };
});

on('DELETE', '/api/servers/:id', ({ params }) => {
  const s = requireServer(params.id);
  store.deleteServer(s.id);
  mon.checkAll(true);
  return { ok: true };
});

// ---------- websites ----------

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function normalizeDomain(input) {
  const raw = String(input || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0];
  let host;
  try { host = new URL(`http://${raw}`).hostname; } catch { host = ''; }
  if (!DOMAIN_RE.test(host)) throw new HttpError(400, `Ongeldig domein: ${raw || '(leeg)'}`);
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
  const th = mon.thresholds();
  const now = nowSec();
  const servers = store.listServers();
  const byId = new Map(servers.map((s) => [s.id, s]));
  return {
    thresholds: th,
    enlarge: store.getSetting('enlargeProblems', true),
    servers: servers.map((s) => ({ id: s.id, name: s.name, type: s.type })),
    websites: store.listWebsites().map((w) => mon.siteSummary(w, byId, th, now)),
  };
});

/** Door de agents gevonden Plesk-domeinen, met wat er al bewaakt wordt. */
on('GET', '/api/websites/discover', () => {
  const monitored = new Set(store.listWebsites().map((w) => w.domain));
  return {
    autoSites: store.getSetting('autoSites', { enabled: false, check: true }),
    servers: store.listServers().map((s) => {
      const extra = mon.extraOf(s);
      return {
        id: s.id, name: s.name, type: s.type, checked: extra.domains_ts || null,
        domains: (extra.domains || []).map((d) => ({ domain: d, monitored: monitored.has(d) })),
      };
    }).filter((s) => s.domains.length || s.type === 'plesk'),
  };
});

on('POST', '/api/websites/bulk', ({ body }) => {
  const items = Array.isArray(body.items) ? body.items.slice(0, 2000) : [];
  const known = new Set(store.listWebsites().map((w) => w.domain));
  let added = 0;
  for (const it of items) {
    let w;
    try { w = validateWebsite({ server_id: it.server_id, domain: it.domain, check_enabled: body.check_enabled !== false }); } catch { continue; }
    if (known.has(w.domain)) continue;
    known.add(w.domain);
    store.createWebsite({ ...w, notes: '' });
    added++;
  }
  return { added };
});

on('GET', '/api/websites/:id', ({ params }) => {
  const w = requireWebsite(params.id);
  const th = mon.thresholds();
  const now = nowSec();
  const server = store.getServer(w.server_id);
  const summary = mon.siteSummary(w, new Map(server ? [[server.id, server]] : []), th, now);
  const sp = server && mon.payloadOf(server);
  return {
    ...summary,
    thresholds: th,
    fullStats: mon.parse(w.last_stats),
    uptime7d: store.uptimeSince(w.id, now - 7 * 86400),
    uptime30d: store.uptimeSince(w.id, now - 30 * 86400),
    serverInfo: server && { cores: sp?.cpu?.cores, mem_total: sp?.mem?.total, cpu: sp?.cpu?.pct, level: mon.statusOf(server, th, now).level },
  };
});

on('GET', '/api/websites/:id/metrics', ({ params, query }) => {
  const w = requireWebsite(params.id);
  const { from, to, bucket } = periodParams(query);
  return { from, to, bucket, site: store.querySiteMetrics(w.id, from, to, bucket), checks: store.queryChecks(w.id, from, to, bucket) };
});

on('POST', '/api/websites', ({ body }) => {
  const w = store.createWebsite(validateWebsite(body));
  if (w.check_enabled) mon.runCheck(w).catch(() => {});
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
  mon.forget('site', w.id);
  return { ok: true };
});

on('POST', '/api/websites/:id/check', async ({ params }) => {
  const w = requireWebsite(params.id);
  if (!w.url) throw new HttpError(400, 'Geen controle-URL ingesteld');
  if (mon.checking.has(w.id)) throw new HttpError(409, 'Controle loopt al');
  return { result: await mon.runCheck(w) };
});

// ---------- verbruik (top-verbruikers) ----------

on('GET', '/api/usage', ({ query }) => {
  const range = rangeParam(query, 7 * 86400, 90 * 86400);
  const now = nowSec();
  const from = Math.floor((now - range) / 3600) * 3600;
  const servers = store.listServers();
  const byId = new Map(servers.map((s) => [s.id, s]));
  const userDomains = new Map(servers.map((s) => [s.id, mon.extraOf(s).user_domains || {}]));
  const name = (id) => byId.get(id)?.name || '?';
  return {
    range,
    users: store.topUsers(from, 150).map((u) => ({
      ...u, server: name(u.server_id), domain: userDomains.get(u.server_id)?.[u.user] || null,
      cores: u.cpu_s / range,
    })),
    domains: store.topDomains(from, 150).map((d) => ({ ...d, server: name(d.server_id) })),
    servers: servers.map((s) => {
      const a = store.serverCpuAvg(s.id, now - range) || {};
      const p = mon.payloadOf(s);
      return { id: s.id, name: s.name, type: s.type, cpu: a.cpu, cpu_max: a.cpu_max, load1: a.load1, cores: p?.cpu?.cores, mem_pct: p?.mem?.pct };
    }),
  };
});

// ---------- onderhoud (back-ups, updates, schijfvoorspelling, WordPress) ----------

on('GET', '/api/maintenance', () => {
  const th = mon.thresholds();
  const now = nowSec();
  const servers = store.listServers();
  const pleskVersions = servers.map((s) => mon.payloadOf(s)?.system?.plesk).filter(Boolean);
  const newestPlesk = pleskVersions.sort((a, b) => cmpVersion(b, a))[0] || null;
  const rows = servers.map((s) => {
    const p = mon.payloadOf(s);
    const extra = mon.extraOf(s);
    const forecast = s.last_seen ? diskForecast(s.id, now) : [];
    return {
      id: s.id, name: s.name, type: s.type, level: mon.statusOf(s, th, now).level, last_seen: s.last_seen,
      backupCfg: mon.configOf(s).backup || { enabled: true },
      backups: extra.backups || null,
      updates: extra.updates || null,
      os: p?.system?.os, kernel: p?.system?.kernel, plesk: p?.system?.plesk, reboot: !!p?.system?.reboot_required,
      agent: p?.agent || null,
      pleskBehind: !!(p?.system?.plesk && newestPlesk && cmpVersion(newestPlesk, p.system.plesk) > 0),
      forecast: forecast.map((f) => {
        const d = (p?.disks || []).find((x) => x.mount === f.mount);
        return { ...f, total: d?.total ?? null, bytesPerDay: d && f.perDay != null ? (f.perDay / 100) * d.total : null };
      }),
    };
  });
  const wp = wordpressOverview(servers, mon.extraOf);
  return { thresholds: th, newestPlesk, servers: rows, wordpress: { core: wp.core, sites: wp.sites } };
});

// ---------- beveiliging ----------

on('GET', '/api/security', ({ query }) => {
  const range = rangeParam(query, 86400, 30 * 86400);
  const now = nowSec();
  const from = Math.floor((now - range) / 3600) * 3600;
  const servers = store.listServers();
  const byId = new Map(servers.map((s) => [s.id, s]));
  const totals = new Map(store.securityTotals(from).map((r) => [r.server_id, r]));
  const series = store.securitySeries(Math.floor((now - 7 * 86400) / 3600) * 3600);
  return {
    range,
    servers: servers.map((s) => {
      const sec = mon.payloadOf(s)?.security || {};
      return { id: s.id, name: s.name, type: s.type, totals: totals.get(s.id) || null, f2b: sec.f2b || null, agent: mon.payloadOf(s)?.agent };
    }),
    attacked: store.topAttacked(from, 25).map((r) => ({ ...r, server: byId.get(r.server_id)?.name || '?' })),
    series: {
      ts: series.map((r) => r.hour), ssh_fail: series.map((r) => r.ssh_fail), wpl: series.map((r) => r.wpl),
      xml: series.map((r) => r.xml), modsec: series.map((r) => r.modsec),
    },
  };
});

// ---------- incidenten ----------

function requireIncident(id) {
  const inc = store.getIncident(+id);
  if (!inc) throw new HttpError(404, 'Incident niet gevonden');
  return inc;
}

function decorateIncident(inc, byId) {
  return { ...inc, server: byId.get(inc.server_id)?.name || null };
}

on('GET', '/api/incidents', ({ query }) => {
  const range = rangeParam(query, 30 * 86400, 365 * 86400);
  const byId = new Map(store.listServers().map((s) => [s.id, s]));
  return {
    incidents: store.listIncidents({ open: query.get('open') === '1', from: nowSec() - range, limit: 500 })
      .map((i) => decorateIncident(i, byId)),
  };
});

on('GET', '/api/incidents/:id', ({ params }) => {
  const inc = requireIncident(params.id);
  const byId = new Map(store.listServers().map((s) => [s.id, s]));
  return {
    incident: decorateIncident(inc, byId),
    notes: store.incidentNotes(inc.id),
    events: store.eventsBetween(inc.server_id, inc.started - 600, (inc.ended || nowSec()) + 600),
  };
});

on('POST', '/api/incidents/:id/notes', ({ params, body, user }) => {
  const inc = requireIncident(params.id);
  const text = String(body.text || '').trim().slice(0, 5000);
  if (!text) throw new HttpError(400, 'Notitie is leeg');
  store.addIncidentNote(inc.id, user.username, text);
  return { ok: true };
});

on('POST', '/api/incidents/:id/ack', ({ params, user }) => {
  const inc = requireIncident(params.id);
  store.updateIncident(inc.id, { ack_user: user.username, ack_ts: nowSec() });
  return { ok: true };
});

on('PUT', '/api/incidents/:id', ({ params, body }) => {
  const inc = requireIncident(params.id);
  store.updateIncident(inc.id, { cause: String(body.cause ?? inc.cause).slice(0, 2000) });
  return { ok: true };
});

on('POST', '/api/incidents/:id/close', ({ params, user }) => {
  const inc = requireIncident(params.id);
  if (!inc.ended) store.updateIncident(inc.id, { ended: nowSec() });
  store.addIncidentNote(inc.id, user.username, 'Handmatig afgesloten');
  return { ok: true };
});

// ---------- instellingen ----------

on('GET', '/api/settings', () => ({
  thresholds: mon.thresholds(),
  defaults: DEFAULT_THRESHOLDS,
  enlargeProblems: store.getSetting('enlargeProblems', true),
  notify: maskedNotifyConfig(),
  autoSites: store.getSetting('autoSites', { enabled: false, check: true }),
  heartbeatUrl: store.getSetting('heartbeatUrl', ''),
  publicUrl: config.publicUrl,
}), { role: 'admin' });

on('PUT', '/api/settings', ({ body }) => {
  if (body.thresholds) store.setSetting('thresholds', mergeThresholds(body.thresholds));
  if (body.enlargeProblems !== undefined) store.setSetting('enlargeProblems', !!body.enlargeProblems);
  if (body.notify) {
    try { saveNotifyConfig(body.notify); } catch (e) { throw new HttpError(400, e.message); }
  }
  if (body.autoSites) store.setSetting('autoSites', { enabled: !!body.autoSites.enabled, check: body.autoSites.check !== false });
  if (body.heartbeatUrl !== undefined) {
    const url = String(body.heartbeatUrl || '').trim();
    if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, 'Heartbeat-URL moet met http(s):// beginnen');
    store.setSetting('heartbeatUrl', url);
  }
  return { ok: true };
});

on('POST', '/api/settings/test-notify', async ({ body }) => {
  const results = await notify(
    { level: 'warn', title: '🧪 Testmelding ServerDash', text: 'Als je dit leest, werkt dit meldingskanaal.', url: config.publicUrl || '' },
    { only: String(body.channel || '') },
  );
  if (!results.length) throw new HttpError(400, 'Onbekend kanaal');
  if (!results[0].ok) throw new HttpError(400, `Mislukt: ${results[0].error}`);
  return { ok: true };
});

// ---------- achtergrondtaken ----------

/** Vraagt periodiek actuele WordPress-versies op voor de plugins/thema's die de agents vonden. */
export function refreshWordpressVersions() {
  const wp = wordpressOverview(store.listServers(), mon.extraOf);
  const plugins = new Set();
  const themes = new Set();
  for (const s of store.listServers()) {
    for (const site of mon.extraOf(s).wordpress?.sites || []) {
      for (const [slug] of site.plugins || []) plugins.add(slug);
      for (const [slug] of site.themes || []) themes.add(slug);
    }
  }
  if (!wp.sites.length) return Promise.resolve();
  return refreshWporg([...plugins], [...themes]);
}
