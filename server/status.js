// Bepaalt de status (ok / warn / crit) van een server op basis van de laatste metrics.

export const DEFAULT_THRESHOLDS = {
  cpu: { warn: 85, crit: 95 },        // % (gemiddeld over sustainMinutes)
  load: { warn: 1.5, crit: 3 },       // load1 per CPU-core (gemiddeld over sustainMinutes)
  iowait: { warn: 20, crit: 40 },     // % (gemiddeld over sustainMinutes)
  mem: { warn: 90, crit: 97 },        // % gebruikt (excl. cache)
  swap: { warn: 60, crit: 90 },       // %
  disk: { warn: 85, crit: 95 },       // % per mountpoint
  inodes: { warn: 85, crit: 95 },     // % per mountpoint
  mailq: { warn: 500, crit: 2000 },   // aantal berichten in Postfix-wachtrij
  sustainMinutes: 3,
  offlineSeconds: 180,
};

export function mergeThresholds(saved) {
  const out = structuredClone(DEFAULT_THRESHOLDS);
  for (const [k, v] of Object.entries(saved || {})) {
    if (!(k in out)) continue;
    if (typeof out[k] === 'object') {
      for (const lvl of ['warn', 'crit']) if (Number.isFinite(+v?.[lvl])) out[k][lvl] = +v[lvl];
    } else if (Number.isFinite(+v)) {
      out[k] = +v;
    }
  }
  return out;
}

const RANK = { crit: 3, warn: 2, pending: 1, info: 0 };
const OK_STATES = new Set(['active', 'activating', 'reloading']);

export function fmtAge(sec) {
  if (sec < 120) return `${sec} s`;
  if (sec < 7200) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${Math.round(sec / 3600)} uur`;
  return `${Math.round(sec / 86400)} dagen`;
}

/**
 * @param server  rij uit de servers-tabel
 * @param p       laatste payload van de agent (of null)
 * @param recent  recente samples [{ts, cpu, iowait, load1, mem_pct}]
 */
export function evaluate(server, p, recent, th, now) {
  const issues = [];
  const add = (level, key, msg) => issues.push({ level, key, msg });

  if (!server.last_seen || !p) {
    add('pending', 'pending', 'Wacht op eerste data van de agent');
    return finish(server, issues);
  }
  const age = now - server.last_seen;
  if (age > th.offlineSeconds) {
    add('crit', 'offline', `Offline — geen data sinds ${fmtAge(age)}`);
    return finish(server, issues, true);
  }

  const win = recent.filter((r) => r.ts >= now - th.sustainMinutes * 60);
  const avg = (key, fallback) => {
    const vals = win.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : fallback;
  };
  const check = (key, value, t, msg) => {
    if (value == null || !t) return;
    if (value >= t.crit) add('crit', key, msg());
    else if (value >= t.warn) add('warn', key, msg());
  };

  const cores = p.cpu?.cores || 1;
  const cpu = avg('cpu', p.cpu?.pct);
  check('cpu', cpu, th.cpu, () => `CPU ${cpu.toFixed(0)}%`);
  const load = avg('load1', p.load?.[0]);
  if (load != null) check('load', load / cores, th.load, () => `Load ${load.toFixed(2)} op ${cores} cores`);
  const iowait = avg('iowait', p.cpu?.iowait);
  check('iowait', iowait, th.iowait, () => `IO-wait ${iowait.toFixed(0)}%`);

  check('mem', p.mem?.pct, th.mem, () => `Geheugen ${p.mem.pct.toFixed(0)}%`);
  if (p.mem?.swap_total > 0) check('swap', p.mem.swap_pct, th.swap, () => `Swap ${p.mem.swap_pct.toFixed(0)}%`);

  for (const d of p.disks || []) {
    check('disk', d.pct, th.disk, () => `Schijf ${d.mount} ${d.pct.toFixed(0)}% vol`);
    check('inodes', d.inodes_pct, th.inodes, () => `Inodes ${d.mount} ${d.inodes_pct.toFixed(0)}%`);
  }

  const services = p.services || {};
  for (const [name, state] of Object.entries(services)) {
    if (!OK_STATES.has(state)) add('crit', 'service', `Service ${name} is ${state}`);
  }
  for (const unit of p.failed || []) {
    if (!(unit.replace(/\.service$/, '') in services)) add('warn', 'failed', `Unit gefaald: ${unit}`);
  }

  if (p.mailq != null) check('mailq', p.mailq, th.mailq, () => `Mailwachtrij: ${p.mailq} berichten`);
  if (p.system?.reboot_required) add('info', 'reboot', 'Herstart vereist (updates)');

  return finish(server, issues);
}

function finish(server, issues, offline = false) {
  issues.sort((a, b) => RANK[b.level] - RANK[a.level]);
  let level = 'ok';
  if (issues.some((i) => i.level === 'crit')) level = 'crit';
  else if (issues.some((i) => i.level === 'warn')) level = 'warn';
  else if (issues.some((i) => i.level === 'pending')) level = 'pending';
  return { level: server.muted ? 'muted' : level, real: level, offline, issues };
}
