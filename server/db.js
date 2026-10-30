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

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  totp_secret TEXT,
  totp_pending TEXT,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'server' | 'site'
  entity_id INTEGER NOT NULL,
  server_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  level TEXT NOT NULL,             -- hoogste level tijdens het incident
  summary TEXT NOT NULL DEFAULT '',
  started INTEGER NOT NULL,
  ended INTEGER,
  last_notified INTEGER,
  ack_user TEXT,
  ack_ts INTEGER,
  cause TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS incidents_open ON incidents (kind, entity_id, ended);
CREATE INDEX IF NOT EXISTS incidents_started ON incidents (started);

CREATE TABLE IF NOT EXISTS incident_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  user TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incident_notes_inc ON incident_notes (incident_id);

CREATE TABLE IF NOT EXISTS server_checks (
  server_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  ok REAL NOT NULL,
  ms REAL,
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage_hourly (
  server_id INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  user TEXT NOT NULL,
  cpu_s REAL NOT NULL DEFAULT 0,     -- CPU-core-seconden
  rss_max REAL NOT NULL DEFAULT 0,
  io REAL NOT NULL DEFAULT 0,        -- bytes gelezen + geschreven
  PRIMARY KEY (server_id, hour, user)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS domain_hourly (
  server_id INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  domain TEXT NOT NULL,
  req INTEGER NOT NULL DEFAULT 0,
  bytes REAL NOT NULL DEFAULT 0,
  s5 INTEGER NOT NULL DEFAULT 0,
  wpl INTEGER NOT NULL DEFAULT 0,    -- POST /wp-login.php
  xml INTEGER NOT NULL DEFAULT 0,    -- POST /xmlrpc.php
  PRIMARY KEY (server_id, hour, domain)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS security_hourly (
  server_id INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  ssh_fail INTEGER NOT NULL DEFAULT 0,
  wpl INTEGER NOT NULL DEFAULT 0,
  xml INTEGER NOT NULL DEFAULT 0,
  modsec INTEGER NOT NULL DEFAULT 0,
  f2b_banned INTEGER NOT NULL DEFAULT 0,  -- max. tegelijk geblokkeerd in dat uur
  PRIMARY KEY (server_id, hour)
) WITHOUT ROWID;
`);

/** Kolom toevoegen aan een bestaande tabel (migratie), stil als hij al bestaat. */
function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn('servers', 'config', 'TEXT');        // JSON: { ports, backup }
addColumn('servers', 'extra', 'TEXT');         // JSON: traag veranderende agentdata (backups, updates, wordpress, …)
addColumn('servers', 'reach', 'TEXT');         // JSON: laatste TCP-check
for (const c of ['db_conns', 'db_running', 'db_qps', 'db_slow']) addColumn('metrics', c, 'REAL');

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

const SERVER_COLS = 'id, name, hostname, type, notes, muted, created_at, last_seen, last_payload, config, extra, reach';
const qListServers = db.prepare(`SELECT ${SERVER_COLS} FROM servers ORDER BY name`);
const qGetServer = db.prepare(`SELECT ${SERVER_COLS} FROM servers WHERE id = ?`);
const qServerByToken = db.prepare(`SELECT ${SERVER_COLS} FROM servers WHERE token_hash = ?`);
const qInsertServer = db.prepare('INSERT INTO servers (name, hostname, type, notes, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const qUpdateServer = db.prepare('UPDATE servers SET name = ?, hostname = ?, type = ?, notes = ?, muted = ?, config = ? WHERE id = ?');
const qSetExtra = db.prepare('UPDATE servers SET extra = ? WHERE id = ?');
const qSetReach = db.prepare('UPDATE servers SET reach = ? WHERE id = ?');
const qSetToken = db.prepare('UPDATE servers SET token_hash = ? WHERE id = ?');
const qSeen = db.prepare('UPDATE servers SET last_seen = ?, last_payload = ? WHERE id = ?');

export const listServers = () => qListServers.all();
export const getServer = (id) => qGetServer.get(id);
export const serverByToken = (token) => qServerByToken.get(hashToken(token));

export function createServer({ name, hostname = '', type = 'plesk', notes = '', config = {} }) {
  const token = newToken();
  const { lastInsertRowid } = qInsertServer.run(name, hostname, type, notes, hashToken(token), nowSec());
  qUpdateServer.run(name, hostname, type, notes, 0, JSON.stringify(config), Number(lastInsertRowid));
  return { server: getServer(Number(lastInsertRowid)), token };
}

export function updateServer(id, { name, hostname, type, notes, muted, config = {} }) {
  qUpdateServer.run(name, hostname, type, notes, muted ? 1 : 0, JSON.stringify(config), id);
  return getServer(id);
}

export const setServerExtra = (id, extra) => qSetExtra.run(JSON.stringify(extra), id);
export const setServerReach = (id, reach) => qSetReach.run(JSON.stringify(reach), id);

export function regenerateToken(id) {
  const token = newToken();
  qSetToken.run(hashToken(token), id);
  return token;
}

export function deleteServer(id) {
  db.exec('BEGIN');
  try {
    for (const table of ['metrics', 'proc_snapshots', 'events', 'server_checks', 'usage_hourly', 'domain_hourly', 'security_hourly', 'incidents']) {
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
  'net_rx', 'net_tx', 'procs', 'mailq', 'disks', 'db_conns', 'db_running', 'db_qps', 'db_slow'];

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
    db_conns: num(p.mysql?.conns), db_running: num(p.mysql?.running), db_qps: num(p.mysql?.qps), db_slow: num(p.mysql?.slow),
  };
}

export function insertMetrics(serverId, ts, row) {
  qInsertMetrics.run(serverId, ts, ...METRIC_COLS.map((c) => row[c] ?? null));
}

const qRecent = db.prepare(
  'SELECT ts, cpu, cpu_iowait AS iowait, load1, mem_pct FROM metrics WHERE server_id = ? AND ts >= ? ORDER BY ts');
export const recentMetrics = (serverId, from) => qRecent.all(serverId, from);

const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/** Vanaf welk tijdsverschil een gat in de grafiek getoond wordt; samengevatte (uur)data heeft grotere stappen. */
const compactCutoff = () => nowSec() - config.compactAfterDays * 86400;
const gapLimit = (t, bucket) => Math.max(bucket * 3, 180, t < compactCutoff() + 3600 ? 3 * 3600 : 0);

/** Gebucketeerde tijdreeks in kolomvorm (voor uPlot), met null-gaten waar data ontbreekt. */
export function queryMetrics(serverId, from, to, bucket) {
  bucket = Math.max(1, Math.floor(bucket));
  const rows = db.prepare(`
    SELECT (ts / ${bucket}) * ${bucket} AS t,
      AVG(cpu) cpu, AVG(cpu_user) cpu_user, AVG(cpu_system) cpu_system, AVG(cpu_iowait) cpu_iowait, AVG(cpu_steal) cpu_steal,
      AVG(load1) load1, AVG(load5) load5, AVG(load15) load15,
      AVG(mem_pct) mem_pct, AVG(mem_cache * 100.0 / NULLIF(mem_total, 0)) cache_pct, AVG(swap_pct) swap_pct,
      AVG(disk_read) disk_read, AVG(disk_write) disk_write, AVG(disk_util) disk_util,
      AVG(net_rx) net_rx, AVG(net_tx) net_tx, AVG(procs) procs, MAX(mailq) mailq,
      AVG(db_conns) db_conns, AVG(db_running) db_running, AVG(db_qps) db_qps, AVG(db_slow) db_slow
    FROM metrics WHERE server_id = ? AND ts >= ? AND ts <= ?
    GROUP BY t ORDER BY t`).all(serverId, from, to);

  const keys = ['cpu', 'cpu_user', 'cpu_system', 'cpu_iowait', 'cpu_steal', 'load1', 'load5', 'load15', 'mem_pct',
    'cache_pct', 'swap_pct', 'disk_read', 'disk_write', 'disk_util', 'net_rx', 'net_tx', 'procs', 'mailq',
    'db_conns', 'db_running', 'db_qps', 'db_slow'];
  const out = { ts: [] };
  for (const k of keys) out[k] = [];
  let prev = null;
  for (const row of rows) {
    if (prev !== null && row.t - prev > gapLimit(row.t, bucket)) {
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
  let prev = null;
  for (const row of rows) {
    if (prev !== null && row.t - prev > gapLimit(row.t, bucket)) {
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

// ---------- gebruikers ----------

const USER_COLS = 'id, username, pass_hash, role, totp_secret, totp_pending, created_at, last_login';
export const countUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
export const listUsers = () => db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY username`).all();
export const getUser = (id) => db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id);
export const userByName = (name) => db.prepare(`SELECT ${USER_COLS} FROM users WHERE username = ?`).get(name);
export function createUser(username, passHash, role) {
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, pass_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(username, passHash, role, nowSec());
  return getUser(Number(lastInsertRowid));
}
export function updateUser(id, fields) {
  const allowed = ['pass_hash', 'role', 'totp_secret', 'totp_pending', 'last_login'];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) db.prepare(`UPDATE users SET ${k} = ? WHERE id = ?`).run(v ?? null, id);
  }
  return getUser(id);
}
export const deleteUser = (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id);

// ---------- incidenten ----------

const INC_COLS = 'id, kind, entity_id, server_id, title, level, summary, started, ended, last_notified, ack_user, ack_ts, cause';
export const openIncident = (kind, entityId) =>
  db.prepare(`SELECT ${INC_COLS} FROM incidents WHERE kind = ? AND entity_id = ? AND ended IS NULL ORDER BY id DESC LIMIT 1`).get(kind, entityId);
export const openIncidents = () => db.prepare(`SELECT ${INC_COLS} FROM incidents WHERE ended IS NULL`).all();
export const getIncident = (id) => db.prepare(`SELECT ${INC_COLS} FROM incidents WHERE id = ?`).get(id);
export function createIncident(i) {
  const { lastInsertRowid } = db.prepare(`INSERT INTO incidents (kind, entity_id, server_id, title, level, summary, started, last_notified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(i.kind, i.entity_id, i.server_id, i.title, i.level, i.summary, i.started, i.last_notified ?? null);
  return getIncident(Number(lastInsertRowid));
}
export function updateIncident(id, fields) {
  const allowed = ['level', 'summary', 'ended', 'last_notified', 'ack_user', 'ack_ts', 'cause', 'title'];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) db.prepare(`UPDATE incidents SET ${k} = ? WHERE id = ?`).run(v ?? null, id);
  }
  return getIncident(id);
}
export function listIncidents({ open = false, from = 0, serverId = null, limit = 200 } = {}) {
  // Openstaande incidenten altijd tonen, afgesloten alleen binnen de periode.
  const where = [open ? 'ended IS NULL' : '(ended IS NULL OR started >= ?)'];
  const params = open ? [] : [from];
  if (serverId) { where.push('server_id = ?'); params.push(serverId); }
  return db.prepare(`
    SELECT ${INC_COLS}, (SELECT COUNT(*) FROM incident_notes n WHERE n.incident_id = incidents.id) AS notes
    FROM incidents WHERE ${where.join(' AND ')} ORDER BY (ended IS NULL) DESC, started DESC LIMIT ?`).all(...params, limit);
}
export const incidentNotes = (id) => db.prepare('SELECT id, ts, user, text FROM incident_notes WHERE incident_id = ? ORDER BY ts').all(id);
export const addIncidentNote = (id, user, text) =>
  db.prepare('INSERT INTO incident_notes (incident_id, ts, user, text) VALUES (?, ?, ?, ?)').run(id, nowSec(), user, text);
export const eventsBetween = (serverId, from, to) =>
  db.prepare('SELECT id, ts, level, message FROM events WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts').all(serverId, from, to);

// ---------- bereikbaarheid (TCP) ----------

export const insertServerCheck = (id, ts, ok, ms) =>
  db.prepare('INSERT OR REPLACE INTO server_checks (server_id, ts, ok, ms) VALUES (?, ?, ?, ?)').run(id, ts, ok ? 1 : 0, ms ?? null);

export function queryServerChecks(id, from, to, bucket) {
  bucket = Math.max(60, Math.floor(bucket));
  return bucketed(`SELECT (ts / ${bucket}) * ${bucket} AS t, AVG(CASE WHEN ok > 0 THEN ms END) ms, AVG(ok) * 100 up
    FROM server_checks WHERE server_id = ? AND ts >= ? AND ts <= ? GROUP BY t ORDER BY t`, ['ms', 'up'], [id, from, to], bucket);
}

// ---------- verbruik & beveiliging per uur ----------

const qUsage = db.prepare(`INSERT INTO usage_hourly (server_id, hour, user, cpu_s, rss_max, io) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(server_id, hour, user) DO UPDATE SET cpu_s = cpu_s + excluded.cpu_s,
  rss_max = MAX(rss_max, excluded.rss_max), io = io + excluded.io`);
const qDomainUsage = db.prepare(`INSERT INTO domain_hourly (server_id, hour, domain, req, bytes, s5, wpl, xml) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(server_id, hour, domain) DO UPDATE SET req = req + excluded.req, bytes = bytes + excluded.bytes,
  s5 = s5 + excluded.s5, wpl = wpl + excluded.wpl, xml = xml + excluded.xml`);
const qSecurity = db.prepare(`INSERT INTO security_hourly (server_id, hour, ssh_fail, wpl, xml, modsec, f2b_banned) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(server_id, hour) DO UPDATE SET ssh_fail = ssh_fail + excluded.ssh_fail, wpl = wpl + excluded.wpl,
  xml = xml + excluded.xml, modsec = modsec + excluded.modsec, f2b_banned = MAX(f2b_banned, excluded.f2b_banned)`);

export const addUsage = (sid, hour, user, cpuS, rss, io) => qUsage.run(sid, hour, user, cpuS, rss, io);
export const addDomainUsage = (sid, hour, d, req, bytes, s5, wpl, xml) => qDomainUsage.run(sid, hour, d, req, bytes, s5, wpl, xml);
export const addSecurity = (sid, hour, ssh, wpl, xml, modsec, banned) => qSecurity.run(sid, hour, ssh, wpl, xml, modsec, banned);

export const topUsers = (from, limit = 100) => db.prepare(`
  SELECT server_id, user, SUM(cpu_s) cpu_s, MAX(rss_max) rss, SUM(io) io FROM usage_hourly WHERE hour >= ?
  GROUP BY server_id, user ORDER BY cpu_s DESC LIMIT ?`).all(from, limit);
export const topDomains = (from, limit = 100) => db.prepare(`
  SELECT server_id, domain, SUM(req) req, SUM(bytes) bytes, SUM(s5) s5, SUM(wpl) wpl, SUM(xml) xml FROM domain_hourly
  WHERE hour >= ? GROUP BY server_id, domain ORDER BY req DESC LIMIT ?`).all(from, limit);
export const topAttacked = (from, limit = 20) => db.prepare(`
  SELECT server_id, domain, SUM(wpl) wpl, SUM(xml) xml FROM domain_hourly WHERE hour >= ? AND (wpl > 0 OR xml > 0)
  GROUP BY server_id, domain ORDER BY SUM(wpl) + SUM(xml) DESC LIMIT ?`).all(from, limit);
export const securityTotals = (from) => db.prepare(`
  SELECT server_id, SUM(ssh_fail) ssh_fail, SUM(wpl) wpl, SUM(xml) xml, SUM(modsec) modsec, MAX(f2b_banned) f2b_banned
  FROM security_hourly WHERE hour >= ? GROUP BY server_id`).all(from);
export const securitySeries = (from) => db.prepare(`
  SELECT hour, SUM(ssh_fail) ssh_fail, SUM(wpl) wpl, SUM(xml) xml, SUM(modsec) modsec FROM security_hourly
  WHERE hour >= ? GROUP BY hour ORDER BY hour`).all(from);
export const serverCpuAvg = (id, from) =>
  db.prepare('SELECT AVG(cpu) cpu, AVG(load1) load1, MAX(cpu) cpu_max FROM metrics WHERE server_id = ? AND ts >= ?').get(id, from);

/** Schijfvulling per mount (uurwaarden) voor de trendvoorspelling. */
export const diskHistory = (id, from) => queryDisks(id, from, nowSec(), 3600);

// ---------- samenvatten (downsampling) ----------

/**
 * Vat ruwe samples ouder dan compactAfterDays samen tot één rij per uur (ts = begin van het uur).
 * Houdt per tabel en entiteit bij tot waar al samengevat is.
 */
const COMPACT_SPECS = [
  {
    table: 'metrics', key: 'server_id', listSql: 'SELECT id FROM servers',
    cols: METRIC_COLS, max: ['mailq'], last: ['disks'],
  },
  {
    table: 'site_metrics', key: 'website_id', listSql: 'SELECT id FROM websites',
    cols: SITE_METRIC_COLS, max: [], last: [],
  },
  {
    table: 'site_checks', key: 'website_id', listSql: 'SELECT id FROM websites',
    cols: ['ok', 'status', 'ms'], max: [], last: ['status'], okMs: true,
  },
  {
    table: 'server_checks', key: 'server_id', listSql: 'SELECT id FROM servers',
    cols: ['ok', 'ms'], max: [], last: [], okMs: true,
  },
];

function compactRows(rows, spec) {
  const out = { ts: rows[0].hour };
  for (const c of spec.cols) {
    const vals = rows.map((r) => r[c]).filter((v) => v != null);
    if (spec.last.includes(c)) out[c] = vals.length ? vals[vals.length - 1] : null;
    else if (spec.max.includes(c)) out[c] = vals.length ? Math.max(...vals) : null;
    else if (spec.okMs && c === 'ms') {
      const okVals = rows.filter((r) => r.ok > 0 && r.ms != null).map((r) => r.ms);
      out[c] = okVals.length ? okVals.reduce((a, b) => a + b, 0) / okVals.length : null;
    } else out[c] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return out;
}

export function compact() {
  const cutoff = Math.floor((nowSec() - config.compactAfterDays * 86400) / 3600) * 3600;
  let total = 0;
  for (const spec of COMPACT_SPECS) {
    const ids = db.prepare(spec.listSql).all().map((r) => r.id);
    for (const id of ids) {
      const markKey = `compacted:${spec.table}:${id}`;
      let from = getSetting(markKey, 0);
      if (!from) {
        const first = db.prepare(`SELECT MIN(ts) AS t FROM ${spec.table} WHERE ${spec.key} = ?`).get(id).t;
        from = first == null ? cutoff : Math.floor(first / 3600) * 3600;
      }
      while (from < cutoff) {
        const to = Math.min(cutoff, from + 2 * 86400);
        const rows = db.prepare(`SELECT ts, (ts / 3600) * 3600 AS hour, ${spec.cols.join(', ')} FROM ${spec.table}
          WHERE ${spec.key} = ? AND ts >= ? AND ts < ? ORDER BY ts`).all(id, from, to);
        const groups = new Map();
        for (const r of rows) {
          if (!groups.has(r.hour)) groups.set(r.hour, []);
          groups.get(r.hour).push(r);
        }
        db.exec('BEGIN');
        try {
          const del = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.key} = ? AND ts >= ? AND ts < ?`);
          const ins = db.prepare(`INSERT OR REPLACE INTO ${spec.table} (${spec.key}, ts, ${spec.cols.join(', ')})
            VALUES (?, ?, ${spec.cols.map(() => '?').join(', ')})`);
          for (const [hour, group] of groups) {
            if (group.length === 1 && group[0].ts === hour) continue;
            const agg = compactRows(group, spec);
            del.run(id, hour, hour + 3600);
            ins.run(id, hour, ...spec.cols.map((c) => agg[c]));
            total += group.length - 1;
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        from = to;
        setSetting(markKey, from);
      }
    }
  }
  return total;
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
  db.prepare('DELETE FROM events WHERE ts < ?').run(now - 365 * 86400);
  const delCheck = db.prepare('DELETE FROM server_checks WHERE server_id = ? AND ts < ?');
  for (const { id } of db.prepare('SELECT id FROM servers').all()) delCheck.run(id, metricsBefore);
  db.prepare('DELETE FROM usage_hourly WHERE hour < ?').run(now - 90 * 86400);
  db.prepare('DELETE FROM domain_hourly WHERE hour < ?').run(now - 90 * 86400);
  db.prepare('DELETE FROM security_hourly WHERE hour < ?').run(now - 90 * 86400);
  db.prepare('DELETE FROM incident_notes WHERE incident_id IN (SELECT id FROM incidents WHERE ended IS NOT NULL AND ended < ?)').run(metricsBefore);
  db.prepare('DELETE FROM incidents WHERE ended IS NOT NULL AND ended < ?').run(metricsBefore);
}
