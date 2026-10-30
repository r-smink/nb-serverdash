import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'serverdash.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'plesk',
  notes TEXT NOT NULL DEFAULT '',
  muted INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  last_payload TEXT
);

CREATE TABLE IF NOT EXISTS metrics (
  server_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  cpu REAL, cpu_user REAL, cpu_system REAL, cpu_iowait REAL, cpu_steal REAL,
  load1 REAL, load5 REAL, load15 REAL,
  mem_pct REAL, mem_used REAL, mem_cache REAL, mem_total REAL, swap_pct REAL,
  disk_read REAL, disk_write REAL, disk_util REAL,
  net_rx REAL, net_tx REAL,
  procs INTEGER, mailq INTEGER,
  disks TEXT,
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS proc_snapshots (
  server_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS events_server ON events (server_id, ts);

CREATE TABLE IF NOT EXISTS websites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  domain TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  check_enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_stats TEXT,
  last_stats_ts INTEGER,
  last_check TEXT,
  last_check_ts INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS websites_server ON websites (server_id);

CREATE TABLE IF NOT EXISTS site_metrics (
  website_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  cpu REAL, rss REAL, rio REAL, wio REAL, procs INTEGER,
  rpm REAL, bw REAL, s2 REAL, s3 REAL, s4 REAL, s5 REAL,
  PRIMARY KEY (website_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS site_checks (
  website_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  ms REAL,
  PRIMARY KEY (website_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export const nowSec = () => Math.floor(Date.now() / 1000);

// ---------- settings ----------

const qGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const qSetSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

export function getSetting(key, fallback = null) {
  const row = qGetSetting.get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setSetting(key, value) {
  qSetSetting.run(key, JSON.stringify(value));
}

export function getOrCreateSecret() {
  let secret = getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting('session_secret', secret);
  }
  return secret;
}

// ---------- servers ----------

export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
export const newToken = () => crypto.randomBytes(24).toString('base64url');

const SERVER_COLS = 'id, name, hostname, type, notes, muted, created_at, last_seen, last_payload';
const qListServers = db.prepare(`SELECT ${SERVER_COLS} FROM servers ORDER BY name`);
const qGetServer = db.prepare(`SELECT ${SERVER_COLS} FROM servers WHERE id = ?`);
const qServerByToken = db.prepare(`SELECT ${SERVER_COLS} FROM servers WHERE token_hash = ?`);
const qInsertServer = db.prepare('INSERT INTO servers (name, hostname, type, notes, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const qUpdateServer = db.prepare('UPDATE servers SET name = ?, hostname = ?, type = ?, notes = ?, muted = ? WHERE id = ?');
const qSetToken = db.prepare('UPDATE servers SET token_hash = ? WHERE id = ?');
const qSeen = db.prepare('UPDATE servers SET last_seen = ?, last_payload = ? WHERE id = ?');

export const listServers = () => qListServers.all();
export const getServer = (id) => qGetServer.get(id);
export const serverByToken = (token) => qServerByToken.get(hashToken(token));

export function createServer({ name, hostname = '', type = 'plesk', notes = '' }) {
  const token = newToken();
  const { lastInsertRowid } = qInsertServer.run(name, hostname, type, notes, hashToken(token), nowSec());
  return { server: getServer(Number(lastInsertRowid)), token };
}

export function updateServer(id, { name, hostname, type, notes, muted }) {
  qUpdateServer.run(name, hostname, type, notes, muted ? 1 : 0, id);
  return getServer(id);
}

export function regenerateToken(id) {
  const token = newToken();
  qSetToken.run(hashToken(token), id);
  return token;
}

export function deleteServer(id) {
  db.exec('BEGIN');
  try {
    for (const table of ['metrics', 'proc_snapshots', 'events']) {
      db.prepare(`DELETE FROM ${table} WHERE server_id = ?`).run(id);
    }
    for (const { id: wid } of db.prepare('SELECT id FROM websites WHERE server_id = ?').all(id)) deleteWebsiteRows(wid);
    db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const markSeen = (id, ts, payloadJson) => qSeen.run(ts, payloadJson, id);

// ---------- metrics ----------

const METRIC_COLS = ['cpu', 'cpu_user', 'cpu_system', 'cpu_iowait', 'cpu_steal', 'load1', 'load5', 'load15',
  'mem_pct', 'mem_used', 'mem_cache', 'mem_total', 'swap_pct', 'disk_read', 'disk_write', 'disk_util',
  'net_rx', 'net_tx', 'procs', 'mailq', 'disks'];

const qInsertMetrics = db.prepare(
  `INSERT OR REPLACE INTO metrics (server_id, ts, ${METRIC_COLS.join(', ')})
   VALUES (?, ?, ${METRIC_COLS.map(() => '?').join(', ')})`);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Zet een agent-payload om naar een metrics-rij. */
export function metricsFromPayload(p) {
  return {
    cpu: num(p.cpu?.pct), cpu_user: num(p.cpu?.user), cpu_system: num(p.cpu?.system),
    cpu_iowait: num(p.cpu?.iowait), cpu_steal: num(p.cpu?.steal),
    load1: num(p.load?.[0]), load5: num(p.load?.[1]), load15: num(p.load?.[2]),
    mem_pct: num(p.mem?.pct), mem_used: num(p.mem?.used), mem_cache: num(p.mem?.cached),
    mem_total: num(p.mem?.total), swap_pct: num(p.mem?.swap_pct),
    disk_read: num(p.diskio?.read), disk_write: num(p.diskio?.write), disk_util: num(p.diskio?.util),
    net_rx: num(p.net?.rx), net_tx: num(p.net?.tx),
    procs: num(p.procs?.total), mailq: num(p.mailq),
    disks: JSON.stringify((p.disks || []).map((d) => ({ m: d.mount, p: d.pct, u: d.used, t: d.total }))),
  };
}

export function insertMetrics(serverId, ts, row) {
  qInsertMetrics.run(serverId, ts, ...METRIC_COLS.map((c) => row[c] ?? null));
}

const qRecent = db.prepare(
  'SELECT ts, cpu, cpu_iowait AS iowait, load1, mem_pct FROM metrics WHERE server_id = ? AND ts >= ? ORDER BY ts');
export const recentMetrics = (serverId, from) => qRecent.all(serverId, from);

const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/** Gebucketeerde tijdreeks in kolomvorm (voor uPlot), met null-gaten waar data ontbreekt. */
export function queryMetrics(serverId, from, to, bucket) {
  bucket = Math.max(1, Math.floor(bucket));
  const rows = db.prepare(`
    SELECT (ts / ${bucket}) * ${bucket} AS t,
      AVG(cpu) cpu, AVG(cpu_user) cpu_user, AVG(cpu_system) cpu_system, AVG(cpu_iowait) cpu_iowait, AVG(cpu_steal) cpu_steal,
      AVG(load1) load1, AVG(load5) load5, AVG(load15) load15,
      AVG(mem_pct) mem_pct, AVG(mem_cache * 100.0 / NULLIF(mem_total, 0)) cache_pct, AVG(swap_pct) swap_pct,
      AVG(disk_read) disk_read, AVG(disk_write) disk_write, AVG(disk_util) disk_util,
      AVG(net_rx) net_rx, AVG(net_tx) net_tx, AVG(procs) procs, MAX(mailq) mailq
    FROM metrics WHERE server_id = ? AND ts >= ? AND ts <= ?
    GROUP BY t ORDER BY t`).all(serverId, from, to);

  const keys = ['cpu', 'cpu_user', 'cpu_system', 'cpu_iowait', 'cpu_steal', 'load1', 'load5', 'load15', 'mem_pct',
    'cache_pct', 'swap_pct', 'disk_read', 'disk_write', 'disk_util', 'net_rx', 'net_tx', 'procs', 'mailq'];
  const out = { ts: [] };
  for (const k of keys) out[k] = [];
  const gap = Math.max(bucket * 3, 180);
  let prev = null;
  for (const row of rows) {
    if (prev !== null && row.t - prev > gap) {
      out.ts.push(prev + bucket);
      for (const k of keys) out[k].push(null);
    }
    out.ts.push(row.t);
    for (const k of keys) out[k].push(r2(row[k]));
    prev = row.t;
  }
  return out;
}

/** Schijfruimte per mountpoint, één sample per bucket. */
export function queryDisks(serverId, from, to, bucket) {
  bucket = Math.max(1, Math.floor(bucket));
  const rows = db.prepare(`
    SELECT ts, disks FROM metrics WHERE server_id = ? AND ts IN (
      SELECT MIN(ts) FROM metrics WHERE server_id = ? AND ts >= ? AND ts <= ? GROUP BY ts / ${bucket}
    ) ORDER BY ts`).all(serverId, serverId, from, to);
  const ts = [];
  const mounts = {};
  rows.forEach((row, i) => {
    ts.push(row.ts);
    let list = [];
    try { list = JSON.parse(row.disks || '[]'); } catch { /* corrupte rij overslaan */ }
    for (const d of list) {
      if (!mounts[d.m]) mounts[d.m] = new Array(i).fill(null);
      mounts[d.m][i] = r2(d.p);
    }
    for (const m of Object.keys(mounts)) if (mounts[m].length <= i) mounts[m].push(null);
  });
  return { ts, mounts };
}

// ---------- process snapshots ----------

const qInsertSnap = db.prepare('INSERT OR REPLACE INTO proc_snapshots (server_id, ts, data) VALUES (?, ?, ?)');
const qSnapBefore = db.prepare('SELECT ts, data FROM proc_snapshots WHERE server_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1');
const qSnapAfter = db.prepare('SELECT ts, data FROM proc_snapshots WHERE server_id = ? AND ts > ? ORDER BY ts ASC LIMIT 1');

export const insertSnapshot = (serverId, ts, blob) => qInsertSnap.run(serverId, ts, blob);

export function snapshotNear(serverId, ts) {
  const before = qSnapBefore.get(serverId, ts);
  const after = qSnapAfter.get(serverId, ts);
  if (!before) return after;
  if (!after) return before;
  return ts - before.ts <= after.ts - ts ? before : after;
}

// ---------- events ----------

const qAddEvent = db.prepare('INSERT INTO events (server_id, ts, level, message) VALUES (?, ?, ?, ?)');
const qRecentEvents = db.prepare(`
  SELECT e.id, e.server_id, e.ts, e.level, e.message, s.name AS server_name
  FROM events e JOIN servers s ON s.id = e.server_id ORDER BY e.ts DESC, e.id DESC LIMIT ?`);
const qServerEvents = db.prepare('SELECT id, ts, level, message FROM events WHERE server_id = ? ORDER BY ts DESC, id DESC LIMIT ?');

export const addEvent = (serverId, ts, level, message) => qAddEvent.run(serverId, ts, level, message);
export const recentEvents = (limit = 30) => qRecentEvents.all(limit);
export const serverEvents = (serverId, limit = 50) => qServerEvents.all(serverId, limit);

// ---------- websites ----------

const SITE_COLS = 'id, server_id, domain, url, keyword, check_enabled, notes, created_at, last_stats, last_stats_ts, last_check, last_check_ts, fail_count';
const qListSites = db.prepare(`SELECT ${SITE_COLS} FROM websites ORDER BY domain`);
const qGetSite = db.prepare(`SELECT ${SITE_COLS} FROM websites WHERE id = ?`);
const qSitesForServer = db.prepare(`SELECT ${SITE_COLS} FROM websites WHERE server_id = ? ORDER BY domain`);
const qInsertSite = db.prepare('INSERT INTO websites (server_id, domain, url, keyword, check_enabled, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const qUpdateSite = db.prepare('UPDATE websites SET server_id = ?, domain = ?, url = ?, keyword = ?, check_enabled = ?, notes = ? WHERE id = ?');
const qSiteStats = db.prepare('UPDATE websites SET last_stats = ?, last_stats_ts = ? WHERE id = ?');
const qSiteCheck = db.prepare('UPDATE websites SET last_check = ?, last_check_ts = ?, fail_count = ? WHERE id = ?');
const qInsertCheck = db.prepare('INSERT OR REPLACE INTO site_checks (website_id, ts, ok, status, ms) VALUES (?, ?, ?, ?, ?)');
const SITE_METRIC_COLS = ['cpu', 'rss', 'rio', 'wio', 'procs', 'rpm', 'bw', 's2', 's3', 's4', 's5'];
const qInsertSiteMetrics = db.prepare(
  `INSERT OR REPLACE INTO site_metrics (website_id, ts, ${SITE_METRIC_COLS.join(', ')}) VALUES (?, ?, ${SITE_METRIC_COLS.map(() => '?').join(', ')})`);

export const listWebsites = () => qListSites.all();
export const getWebsite = (id) => qGetSite.get(id);
export const websitesForServer = (serverId) => qSitesForServer.all(serverId);

export function createWebsite(w) {
  const { lastInsertRowid } = qInsertSite.run(w.server_id, w.domain, w.url, w.keyword, w.check_enabled ? 1 : 0, w.notes, nowSec());
  return getWebsite(Number(lastInsertRowid));
}

export function updateWebsite(id, w) {
  qUpdateSite.run(w.server_id, w.domain, w.url, w.keyword, w.check_enabled ? 1 : 0, w.notes, id);
  return getWebsite(id);
}

function deleteWebsiteRows(id) {
  for (const table of ['site_metrics', 'site_checks']) db.prepare(`DELETE FROM ${table} WHERE website_id = ?`).run(id);
  db.prepare('DELETE FROM websites WHERE id = ?').run(id);
}

export function deleteWebsite(id) {
  db.exec('BEGIN');
  try { deleteWebsiteRows(id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function insertSiteMetrics(id, ts, s) {
  qInsertSiteMetrics.run(id, ts, ...SITE_METRIC_COLS.map((c) => num(s[c])));
}
export const setSiteStats = (id, ts, json) => qSiteStats.run(json, ts, id);
export const setSiteCheck = (id, ts, json, failCount) => qSiteCheck.run(json, ts, failCount, id);
export const insertCheck = (id, ts, ok, status, ms) => qInsertCheck.run(id, ts, ok ? 1 : 0, status ?? null, ms ?? null);

const qRecentSite = db.prepare('SELECT ts, cpu, rpm, s5, s2, s3, s4 FROM site_metrics WHERE website_id = ? AND ts >= ? ORDER BY ts');
export const recentSiteMetrics = (id, from) => qRecentSite.all(id, from);

const qUptime = db.prepare('SELECT AVG(ok) * 100 AS up, COUNT(*) AS n FROM site_checks WHERE website_id = ? AND ts >= ?');
export function uptimeSince(id, from) {
  const r = qUptime.get(id, from);
  return r.n ? Math.round(r.up * 100) / 100 : null;
}

function bucketed(sql, keys, params, bucket) {
  const rows = db.prepare(sql).all(...params);
  const out = { ts: [] };
  for (const k of keys) out[k] = [];
  const gap = Math.max(bucket * 3, 180);
  let prev = null;
  for (const row of rows) {
    if (prev !== null && row.t - prev > gap) {
      out.ts.push(prev + bucket);
      for (const k of keys) out[k].push(null);
    }
    out.ts.push(row.t);
    for (const k of keys) out[k].push(r2(row[k]));
    prev = row.t;
  }
  return out;
}

export function querySiteMetrics(id, from, to, bucket) {
  bucket = Math.max(1, Math.floor(bucket));
  return bucketed(`
    SELECT (ts / ${bucket}) * ${bucket} AS t, AVG(cpu) cpu, AVG(rss) rss, AVG(rio) rio, AVG(wio) wio, AVG(procs) procs,
      AVG(rpm) rpm, AVG(bw) bw, AVG(s2) s2, AVG(s3) s3, AVG(s4) s4, AVG(s5) s5
    FROM site_metrics WHERE website_id = ? AND ts >= ? AND ts <= ? GROUP BY t ORDER BY t`,
  ['cpu', 'rss', 'rio', 'wio', 'procs', 'rpm', 'bw', 's2', 's3', 's4', 's5'], [id, from, to], bucket);
}

export function queryChecks(id, from, to, bucket) {
  bucket = Math.max(60, Math.floor(bucket));
  return bucketed(`
    SELECT (ts / ${bucket}) * ${bucket} AS t, AVG(CASE WHEN ok = 1 THEN ms END) ms, AVG(ok) * 100 up
    FROM site_checks WHERE website_id = ? AND ts >= ? AND ts <= ? GROUP BY t ORDER BY t`,
  ['ms', 'up'], [id, from, to], bucket);
}

// ---------- onderhoud ----------

export function purge() {
  const now = nowSec();
  const metricsBefore = now - config.retentionDays * 86400;
  const snapsBefore = now - config.procRetentionHours * 3600;
  const delMetrics = db.prepare('DELETE FROM metrics WHERE server_id = ? AND ts < ?');
  const delSnaps = db.prepare('DELETE FROM proc_snapshots WHERE server_id = ? AND ts < ?');
  for (const { id } of db.prepare('SELECT id FROM servers').all()) {
    delMetrics.run(id, metricsBefore);
    delSnaps.run(id, snapsBefore);
  }
  const delSite = db.prepare('DELETE FROM site_metrics WHERE website_id = ? AND ts < ?');
  const delChecks = db.prepare('DELETE FROM site_checks WHERE website_id = ? AND ts < ?');
  for (const { id } of db.prepare('SELECT id FROM websites').all()) {
    delSite.run(id, metricsBefore);
    delChecks.run(id, metricsBefore);
  }
  db.prepare('DELETE FROM events WHERE ts < ?').run(now - 90 * 86400);
}
