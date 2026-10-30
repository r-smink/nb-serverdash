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
  response: { warn: 2000, crit: 5000 }, // website: responstijd in ms
  ssl: { warn: 21, crit: 7 },         // website: dagen tot SSL-certificaat verloopt (lager = slechter)
  err5xx: { warn: 5, crit: 20 },      // website: % requests met 5xx-fout
  siteCpu: { warn: 150, crit: 300 },  // website: CPU in % van één core (gemiddeld over sustainMinutes)
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

/**
 * Status van een website: bereikbaarheid (HTTP-check vanaf het dashboard) + resourceverbruik (agent).
 * @param site    rij uit de websites-tabel
 * @param server  rij van de server waar de site op draait
 * @param stats   laatste site-statistieken van de agent (of null)
 * @param check   laatste HTTP-check (of null)
 * @param recent  recente site-samples [{ts, cpu, rpm, s2..s5}]
 */
export function evaluateSite(site, server, stats, check, recent, th, now) {
  const issues = [];
  const add = (level, key, msg) => issues.push({ level, key, msg });
  const why = (c) => c?.error || (c?.status ? `HTTP ${c.status}` : 'onbekende fout');

  if (site.check_enabled) {
    if (!check) add('pending', 'pending', 'Wacht op eerste controle');
    else if (site.fail_count >= 2) add('crit', 'down', `Onbereikbaar — ${why(check)}`);
    else if (site.fail_count === 1) add('warn', 'down', `Controle mislukt (${why(check)}), wordt opnieuw geprobeerd`);
    else if (check.ms >= th.response.crit) add('crit', 'slow', `Zeer traag: ${Math.round(check.ms)} ms`);
    else if (check.ms >= th.response.warn) add('warn', 'slow', `Traag: ${Math.round(check.ms)} ms`);
    if (check?.certDays != null) {
      const msg = check.certDays < 0 ? 'SSL-certificaat is verlopen' : `SSL-certificaat verloopt over ${check.certDays} dagen`;
      if (check.certDays <= th.ssl.crit) add('crit', 'ssl', msg);
      else if (check.certDays <= th.ssl.warn) add('warn', 'ssl', msg);
    }
  }

  const serverOffline = !server?.last_seen || now - server.last_seen > th.offlineSeconds;
  if (!stats || !site.last_stats_ts || now - site.last_stats_ts > th.offlineSeconds) {
    add('info', 'nodata', serverOffline ? `Server ${server?.name || ''} is offline — geen resourcedata`
      : 'Nog geen resourcedata van de agent (agent 1.1+ nodig)');
  } else if (!stats.found) {
    add('warn', 'notfound', `Domein niet gevonden in Plesk op ${server.name}`);
  } else {
    const win = recent.filter((r) => r.ts >= now - th.sustainMinutes * 60);
    const sum = (k) => win.reduce((a, r) => a + (r[k] || 0), 0);
    const cpu = win.length ? sum('cpu') / win.length : stats.cpu;
    if (cpu >= th.siteCpu.crit) add('crit', 'cpu', `CPU ${Math.round(cpu)}% (van 1 core)`);
    else if (cpu >= th.siteCpu.warn) add('warn', 'cpu', `CPU ${Math.round(cpu)}% (van 1 core)`);
    const total = win.length ? sum('s2') + sum('s3') + sum('s4') + sum('s5') : (stats.s2 + stats.s3 + stats.s4 + stats.s5) || 0;
    const errors = win.length ? sum('s5') : stats.s5 || 0;
    if (total / Math.max(win.length, 1) >= 1) { // pas beoordelen vanaf ~1 request per minuut
      const pct = (errors / total) * 100;
      if (pct >= th.err5xx.crit) add('crit', '5xx', `${pct.toFixed(1)}% serverfouten (5xx)`);
      else if (pct >= th.err5xx.warn) add('warn', '5xx', `${pct.toFixed(1)}% serverfouten (5xx)`);
    }
  }
  return finish({ muted: !!server?.muted }, issues);
}

function finish(server, issues, offline = false) {
  issues.sort((a, b) => RANK[b.level] - RANK[a.level]);
  let level = 'ok';
  if (issues.some((i) => i.level === 'crit')) level = 'crit';
  else if (issues.some((i) => i.level === 'warn')) level = 'warn';
  else if (issues.some((i) => i.level === 'pending')) level = 'pending';
  return { level: server.muted ? 'muted' : level, real: level, offline, issues };
}
