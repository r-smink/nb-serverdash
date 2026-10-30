// Kern van de monitoring: agentdata verwerken, status bepalen, checks uitvoeren en incidenten bijwerken.
import net from 'node:net';
import zlib from 'node:zlib';
import { config } from './config.js';
import * as store from './db.js';
import { evaluate, evaluateSite, mergeThresholds } from './status.js';
import { checkUrl } from './checker.js';
import { handleTransition, remind } from './alerts.js';
import { diskForecast } from './insights.js';

const { nowSec } = store;
export const parse = (json) => { try { return json ? JSON.parse(json) : null; } catch { return null; } };
export const thresholds = () => mergeThresholds(store.getSetting('thresholds'));

// ---------- in-memory staat ----------

const RECENT_WINDOW = 3600;
const recent = new Map();        // serverId -> [{ts, cpu, iowait, load1, mem_pct}]
const siteRecent = new Map();    // websiteId -> [{ts, cpu, rpm, s2..s5}]
const payloadCache = new Map();  // serverId -> {seen, len, payload}
const lastSnapshot = new Map();  // serverId -> ts
const lastIngest = new Map();    // serverId -> ts van vorige meting
const levels = new Map();        // 'server:1' / 'site:4' -> laatst bekende level
// Na een herstart: laatste meting uit de database, zodat /api/health niet onterecht alarm slaat.
let lastIngestAt = Math.max(0, ...store.listServers().map((s) => s.last_seen || 0));

export const lastIngestTime = () => lastIngestAt;

function recentList(map, id, loader) {
  let list = map.get(id);
  if (!list) { list = loader(id, nowSec() - RECENT_WINDOW); map.set(id, list); }
  return list;
}
const getRecent = (id) => recentList(recent, id, store.recentMetrics);
const getSiteRecent = (id) => recentList(siteRecent, id, store.recentSiteMetrics);

function pushTo(list, sample) {
  if (list.length && list[list.length - 1].ts >= sample.ts) return;
  list.push(sample);
  const cutoff = nowSec() - RECENT_WINDOW;
  while (list.length && list[0].ts < cutoff) list.shift();
}

export function payloadOf(s) {
  if (!s.last_payload) return null;
  const cached = payloadCache.get(s.id);
  if (cached && cached.seen === s.last_seen && cached.len === s.last_payload.length) return cached.payload;
  const payload = parse(s.last_payload);
  payloadCache.set(s.id, { seen: s.last_seen, len: s.last_payload.length, payload });
  return payload;
}

export const extraOf = (s) => parse(s.extra) || {};
export const configOf = (s) => parse(s.config) || {};
export const reachOf = (s) => parse(s.reach);

// ---------- status servers ----------

export function statusOf(s, th = thresholds(), now = nowSec()) {
  return evaluate(s, payloadOf(s), getRecent(s.id), th, now, {
    extra: extraOf(s), config: configOf(s), reach: reachOf(s),
    forecast: s.last_seen ? diskForecast(s.id, now) : [],
  });
}

function sparkline(list, now, key, agg) {
  const points = new Array(60).fill(null);
  const counts = new Array(60).fill(0);
  const start = now - 3600;
  for (const r of list) {
    const i = Math.floor((r.ts - start) / 60);
    if (i < 0 || i >= 60 || r[key] == null) continue;
    points[i] = agg === 'max' ? Math.max(points[i] ?? 0, r[key]) : (points[i] ?? 0) + r[key];
    counts[i]++;
  }
  return agg === 'max' ? points : points.map((v, i) => (v == null ? null : Math.round((v / counts[i]) * 10) / 10));
}

export function serverSummary(s, th, now) {
  const p = payloadOf(s);
  const status = statusOf(s, th, now);
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
    config: configOf(s), created_at: s.created_at, last_seen: s.last_seen, agent: p?.agent || null,
    status, summary, spark: sparkline(getRecent(s.id), now, 'cpu'),
  };
}

// ---------- status websites ----------

export function siteStatus(w, server, th = thresholds(), now = nowSec()) {
  return evaluateSite(w, server, parse(w.last_stats), parse(w.last_check), getSiteRecent(w.id), th, now);
}

export function siteSummary(w, serversById, th, now) {
  const server = serversById.get(w.server_id);
  const stats = parse(w.last_stats);
  return {
    id: w.id, domain: w.domain, url: w.url, keyword: w.keyword, check_enabled: !!w.check_enabled, notes: w.notes,
    server: server ? { id: server.id, name: server.name, hostname: server.hostname } : null,
    server_id: w.server_id,
    status: siteStatus(w, server, th, now),
    stats: stats && {
      found: stats.found, user: stats.user, cpu: stats.cpu, rss: stats.rss, rio: stats.rio, wio: stats.wio, procs: stats.procs,
      rpm: stats.rpm, bw: stats.bw, s2: stats.s2, s3: stats.s3, s4: stats.s4, s5: stats.s5, disk: stats.disk,
    },
    stats_ts: w.last_stats_ts,
    check: parse(w.last_check), check_ts: w.last_check_ts,
    uptime24: store.uptimeSince(w.id, now - 86400),
    spark: sparkline(getSiteRecent(w.id), now, 'rpm', 'max'),
  };
}

// ---------- statuswijzigingen ----------

const LEVEL_TEXT = { crit: 'Kritiek', warn: 'Waarschuwing', ok: 'Hersteld' };
const problems = (status) => status.issues.filter((i) => i.level === 'crit' || i.level === 'warn').map((i) => i.msg).join(', ');

function track(key, entity, eventServerId, eventPrefix, status, now, silent) {
  const lvl = status.level;
  const prev = levels.get(key);
  levels.set(key, lvl);
  if (lvl === 'pending' || lvl === 'muted') return;
  // Eerste keer gezien (opstarten of nieuw): wel incident openen als het mis is, niet melden.
  if (prev === undefined || silent) { handleTransition(entity, prev, lvl, status, now, true); return; }
  if (prev === lvl) { if (lvl !== 'ok') handleTransition(entity, prev, lvl, status, now, true); return; }
  if ((prev === 'muted' || prev === 'pending') && lvl === 'ok') return;
  const text = lvl === 'ok' ? 'hersteld — alles weer binnen de drempels' : `${LEVEL_TEXT[lvl].toLowerCase()} — ${problems(status)}`;
  store.addEvent(eventServerId, now, lvl, `${eventPrefix}${text.charAt(0).toUpperCase()}${text.slice(1)}`);
  handleTransition(entity, prev, lvl, status, now, false);
}

export function trackServer(s, status, now, silent = false) {
  track(`server:${s.id}`, { kind: 'server', id: s.id, serverId: s.id, title: s.name, hash: `#/server/${s.id}` }, s.id, '', status, now, silent);
}

export function trackSite(w, server, status, now, silent = false) {
  if (!server) return;
  track(`site:${w.id}`, { kind: 'site', id: w.id, serverId: server.id, title: `Website ${w.domain}`, hash: `#/website/${w.id}` },
    server.id, `Website ${w.domain}: `, status, now, silent);
}

export function checkAll(silent = false) {
  const th = thresholds();
  const now = nowSec();
  const servers = store.listServers();
  const byId = new Map(servers.map((s) => [s.id, s]));
  const keys = new Set();
  for (const s of servers) {
    keys.add(`server:${s.id}`);
    trackServer(s, statusOf(s, th, now), now, silent);
  }
  for (const w of store.listWebsites()) {
    keys.add(`site:${w.id}`);
    const server = byId.get(w.server_id);
    trackSite(w, server, siteStatus(w, server, th, now), now, silent);
  }
  for (const k of levels.keys()) {
    if (keys.has(k)) continue;
    levels.delete(k);
    const [kind, id] = k.split(':');
    if (kind === 'server') { recent.delete(+id); payloadCache.delete(+id); } else siteRecent.delete(+id);
  }
  // Openstaande incidenten van verwijderde servers/sites sluiten
  for (const inc of store.openIncidents()) {
    if (!keys.has(`${inc.kind}:${inc.entity_id}`)) store.updateIncident(inc.id, { ended: now, cause: inc.cause || 'Verwijderd uit monitoring' });
  }
  if (!silent) {
    remind((inc) => {
      if (inc.kind === 'server') { const s = byId.get(inc.entity_id); return s && statusOf(s, th, now); }
      const w = store.getWebsite(inc.entity_id);
      return w && siteStatus(w, byId.get(w.server_id), th, now);
    }, now);
  }
}

export function forget(kind, id) {
  levels.delete(`${kind}:${id}`);
  if (kind === 'site') siteRecent.delete(id);
}

// ---------- agentdata verwerken ----------

const EXTRA_KEYS = ['backups', 'updates', 'wordpress', 'domains', 'user_domains', 'dbs'];

/** Verwerkt één meting van een agent. Geeft de lijst te meten websites terug. */
export function ingest(s, body) {
  const now = nowSec();
  lastIngestAt = now;
  let ts = Math.floor(+body.ts || now);
  if (ts > now + 60 || ts < now - 86400) ts = now;
  const prevTs = lastIngest.get(s.id);
  const dt = Math.min(300, Math.max(1, +body.dt || (prevTs ? ts - prevTs : 30)));
  lastIngest.set(s.id, ts);
  const hour = Math.floor(ts / 3600) * 3600;

  // Traag veranderende gegevens apart bewaren (komen niet elke meting mee).
  const extra = extraOf(s);
  let extraChanged = false;
  for (const k of EXTRA_KEYS) {
    if (body[k] === undefined) continue;
    extra[k] = body[k];
    extra[`${k}_ts`] = now;
    delete body[k];
    extraChanged = true;
  }
  if (extraChanged) { store.setServerExtra(s.id, extra); s.extra = JSON.stringify(extra); }

  store.db.exec('BEGIN');
  try {
    store.insertMetrics(s.id, ts, store.metricsFromPayload(body));

    for (const u of body.procs?.users || []) {
      if (!u.user) continue;
      store.addUsage(s.id, hour, String(u.user).slice(0, 64), (u.cpu || 0) / 100 * dt, u.rss || 0, ((u.rio || 0) + (u.wio || 0)) * dt);
    }
    for (const [domain, v] of Object.entries(body.usage?.domains || {})) {
      if (!Array.isArray(v)) continue;
      store.addDomainUsage(s.id, hour, domain.slice(0, 255), v[0] || 0, v[1] || 0, v[2] || 0, v[3] || 0, v[4] || 0);
    }
    const sec = body.security;
    if (sec) store.addSecurity(s.id, hour, sec.ssh_fail || 0, sec.wpl || 0, sec.xml || 0, sec.modsec || 0, sec.f2b?.banned || 0);
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
  delete body.usage;

  if (body.procs?.list && ts - (lastSnapshot.get(s.id) || 0) >= config.procSnapshotInterval) {
    const snap = { total: body.procs.total, running: body.procs.running, list: body.procs.list, users: body.procs.users };
    store.insertSnapshot(s.id, ts, zlib.deflateSync(JSON.stringify(snap)));
    lastSnapshot.set(s.id, ts);
  }

  // Alleen de nieuwste payload als "huidige staat" bewaren (agent kan oude payloads nasturen).
  const prev = payloadOf(s);
  if (!prev || (prev.ts || 0) <= ts) {
    body.ts = ts;
    const sites = body.sites;
    delete body.sites;
    const json = JSON.stringify(body);
    body.sites = sites;
    store.markSeen(s.id, now, json);
    s.last_seen = now;
    s.last_payload = json;
    payloadCache.set(s.id, { seen: now, len: json.length, payload: parse(json) });
  }
  pushTo(getRecent(s.id), { ts, cpu: body.cpu?.pct ?? null, iowait: body.cpu?.iowait ?? null, load1: body.load?.[0] ?? null, mem_pct: body.mem?.pct ?? null });
  trackServer(s, statusOf(s, thresholds(), now), now);

  // Automatisch nieuwe Plesk-domeinen als website toevoegen (als dat aan staat).
  const auto = store.getSetting('autoSites', { enabled: false, check: true });
  if (auto.enabled && Array.isArray(extra.domains) && extraChanged) {
    const known = new Set(store.listWebsites().map((w) => w.domain));
    for (const d of extra.domains) {
      if (known.has(d) || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) continue;
      store.createWebsite({ server_id: s.id, domain: d, url: `https://${d}/`, keyword: '', check_enabled: auto.check !== false, notes: 'Automatisch toegevoegd' });
      store.addEvent(s.id, now, 'ok', `Website ${d} automatisch toegevoegd aan de monitoring`);
    }
  }

  // Websites op deze server: statistieken opslaan en de lijst domeinen teruggeven,
  // zodat de agent weet welke sites hij de volgende keer moet meten.
  const sites = store.websitesForServer(s.id);
  if (body.sites && typeof body.sites === 'object') {
    for (const w of sites) {
      const st = body.sites[w.domain];
      if (!st || typeof st !== 'object') continue;
      if (st.found) {
        store.insertSiteMetrics(w.id, ts, st);
        pushTo(getSiteRecent(w.id), { ts, cpu: st.cpu ?? null, rpm: st.rpm ?? null, s2: st.s2 ?? 0, s3: st.s3 ?? 0, s4: st.s4 ?? 0, s5: st.s5 ?? 0 });
      }
      store.setSiteStats(w.id, now, JSON.stringify(st));
    }
  }
  return sites.map((w) => w.domain);
}

// ---------- HTTP-checks websites ----------

const CHECK_INTERVAL = 60;
export const checking = new Set();

export async function runCheck(w) {
  checking.add(w.id);
  try {
    const result = await checkUrl(w.url, { keyword: w.keyword });
    const now = nowSec();
    const fresh = store.getWebsite(w.id);
    if (!fresh) return result;
    store.insertCheck(w.id, now, result.ok, result.status, result.ms);
    store.setSiteCheck(w.id, now, JSON.stringify({ ...result, ts: now }), result.ok ? 0 : fresh.fail_count + 1);
    const updated = store.getWebsite(w.id);
    const server = store.getServer(updated.server_id);
    trackSite(updated, server, siteStatus(updated, server, thresholds(), now), now);
    return result;
  } finally {
    checking.delete(w.id);
  }
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export async function checkDueSites() {
  const now = nowSec();
  const due = store.listWebsites()
    .filter((w) => w.check_enabled && w.url && !checking.has(w.id) && (!w.last_check_ts || now - w.last_check_ts >= CHECK_INTERVAL - 5));
  await inBatches(due, 5, (w) => runCheck(w).catch((e) => console.warn(`Check ${w.domain}: ${e.message}`)));
}

// ---------- TCP-bereikbaarheid servers ----------

const DEFAULT_PORTS = { plesk: [443, 8443], nameserver: [53], database: [3306], other: [22] };

export function reachTarget(s) {
  const cfg = configOf(s);
  if (cfg.reach === false) return null;
  const host = (cfg.reachHost || s.hostname || '').trim();
  if (!host) return null;
  const ports = String(cfg.ports || '').split(/[\s,;]+/).map(Number).filter((p) => p > 0 && p < 65536);
  return { host, ports: ports.length ? ports : DEFAULT_PORTS[s.type] || [22] };
}

function tcpProbe(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const started = performance.now();
    const sock = net.connect({ host, port, timeout });
    const done = (ok, error) => { sock.destroy(); resolve({ ok, ms: Math.round(performance.now() - started), error }); };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (e) => done(false, e.code || e.message));
  });
}

export async function checkReach(s) {
  const target = reachTarget(s);
  if (!target) return null;
  let result = null;
  for (const port of target.ports) {
    const r = await tcpProbe(target.host, port);
    result = { ts: nowSec(), ok: r.ok, port, ports: target.ports, host: target.host, ms: r.ms, error: r.error || null };
    if (r.ok) break;
  }
  store.setServerReach(s.id, result);
  store.insertServerCheck(s.id, result.ts, result.ok, result.ok ? result.ms : null);
  return result;
}

export async function checkDueReach() {
  const now = nowSec();
  const due = store.listServers().filter((s) => {
    const r = reachOf(s);
    return reachTarget(s) && (!r || now - r.ts >= 55);
  });
  await inBatches(due, 10, (s) => checkReach(s).catch((e) => console.warn(`TCP-check ${s.name}: ${e.message}`)));
}
