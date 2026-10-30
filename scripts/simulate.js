// Demo-simulator: maakt 24 Plesk-servers + nameserver + shared database server aan,
// vult 7 dagen historie en stuurt daarna live metingen naar het dashboard.
//
//   npm run demo          (dashboard moet draaien: npm start)
//   npm run demo:clean    verwijdert alle demo-servers

import zlib from 'node:zlib';
import { config } from '../server/config.js';
import * as store from '../server/db.js';

const DOMAIN = '.demo.local';
const BASE = process.env.SIM_URL || `http://127.0.0.1:${config.port}`;
const LIVE_INTERVAL = 10;

if (process.argv.includes('--clean')) {
  let n = 0;
  for (const s of store.listServers()) if (s.hostname.endsWith(DOMAIN)) { store.deleteServer(s.id); n++; }
  console.log(`${n} demo-servers verwijderd.`);
  process.exit(0);
}

// ---------- vloot ----------

const GB = 1024 ** 3;
const fleet = [];
for (let i = 1; i <= 24; i++) {
  const n = String(i).padStart(2, '0');
  fleet.push({ name: `web${n}`, type: 'plesk', cores: [4, 8, 8, 16][i % 4], mem: [16, 32, 32, 64][i % 4] * GB, disk: [200, 400, 800][i % 3] * GB, base: 8 + ((i * 37) % 30) });
}
fleet.push({ name: 'ns1', type: 'nameserver', cores: 2, mem: 4 * GB, disk: 40 * GB, base: 3 });
fleet.push({ name: 'db01', type: 'database', cores: 16, mem: 128 * GB, disk: 2000 * GB, base: 30 });

// Scenario's zodat er iets te zien is
const scenario = {
  web07: { cpuBoost: 75 },                          // continu hoge CPU -> kritiek
  web04: { loadBoost: 2.2 },                        // hoge load -> waarschuwing
  web13: { diskPct: 91 },                           // schijf bijna vol -> waarschuwing
  web19: { offline: true },                         // offline -> kritiek
  web21: { failed: 'fail2ban' },                    // service down -> kritiek
  web11: { mailq: 1200 },                           // mailwachtrij -> waarschuwing
  db01: { iowaitSpikes: true },
};

// ---------- deterministische ruis ----------

function hash(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
function noise(seed, t, period) {
  const k = Math.floor(t / period);
  const f = (t % period) / period;
  const a = hash(seed * 1000 + k), b = hash(seed * 1000 + k + 1);
  return a + (b - a) * (0.5 - Math.cos(f * Math.PI) / 2);
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const SUBSCRIPTIONS = ['bakkerijdejong', 'webshop-xl', 'autobedrijf', 'tandarts-zuid', 'fietsenmaker', 'kapsalon-anna', 'nextbuzz', 'sportclub', 'makelaardij', 'restaurant-zee', 'advocaten', 'bouwbedrijf'];

function genProcs(srv, seed, t, cpuPct, memUsed) {
  const subs = SUBSCRIPTIONS.slice(seed % 5, (seed % 5) + 6);
  const list = [];
  let pid = 1000 + (seed * 97) % 5000;
  const add = (user, name, cmd, cpu, rss, age, extra = {}) => list.push({
    pid: pid += 7 + Math.floor(hash(pid + t) * 50), ppid: 1, user, name, cmd, cpu: Math.round(cpu * 10) / 10, rss: Math.round(rss),
    mem: Math.round((rss / srv.mem) * 1000) / 10, rio: extra.rio || 0, wio: extra.wio || 0,
    ctime: Math.round((extra.ctime ?? age * cpu / 100) * 10) / 10, age: Math.round(age), thr: extra.thr || 1, st: cpu > 5 ? 'R' : 'S',
  });
  const budget = cpuPct * srv.cores; // in "top %" (100 = 1 core)

  if (srv.type === 'plesk') {
    subs.forEach((u, i) => {
      const share = budget * (0.25 / (i + 1)) * noise(seed + i, t, 300);
      add(u, 'php-fpm', `php-fpm: pool ${u}.nl`, share, 80e6 + hash(i + seed) * 120e6, 3600 * (1 + i));
    });
    add('mysql', 'mariadbd', '/usr/sbin/mariadbd', budget * 0.15, srv.mem * 0.12, 86400 * 12, { thr: 48, rio: 2e5 * noise(seed, t, 120), wio: 6e5 * noise(seed + 3, t, 120) });
    add('root', 'nginx', 'nginx: master process /usr/sbin/nginx', 0.1, 12e6, 86400 * 12);
    add('www-data', 'nginx', 'nginx: worker process', budget * 0.04, 40e6, 86400 * 2);
    add('root', 'apache2', '/usr/sbin/apache2 -k start', budget * 0.06, 90e6, 86400 * 12, { thr: 26 });
    add('psaadm', 'sw-engine', '/usr/sbin/sw-engine-fpm', 0.4, 110e6, 86400 * 12);
    add('dovecot', 'dovecot', '/usr/sbin/dovecot -F', 0.3, 8e6, 86400 * 12);
    add('postfix', 'smtpd', 'smtpd -n smtp -t inet -u -c -o stress=', 0.5 + (scenario[srv.name]?.mailq ? 6 : 0), 6e6, 900);
    add('clamav', 'clamd', '/usr/sbin/clamd --foreground=true', 0.8, 1.1e9, 86400 * 12);
    add('root', 'fail2ban-server', '/usr/bin/python3 /usr/bin/fail2ban-server -xf start', 0.6, 60e6, 86400 * 12);
    if (srv.name === 'web07') {
      add(subs[0], 'php', `/opt/plesk/php/8.2/bin/php /var/www/vhosts/${subs[0]}.nl/httpdocs/artisan queue:work --tries=3`, 96, 380e6, 3 * 86400 + 4000, { ctime: 3 * 86400 * 0.9 });
      add(subs[1], 'php', `/opt/plesk/php/8.1/bin/php -f /var/www/vhosts/${subs[1]}.nl/httpdocs/wp-cron.php`, 88, 260e6, 5400);
    }
    if (hash(seed + Math.floor(t / 3600)) > 0.7) {
      add('root', 'pmm-ras', '/usr/local/psa/admin/bin/pmm-ras --create-dump --session-path=/var/lib/psa/dumps', 35, 220e6, 1800 + (t % 3600), { rio: 25e6, wio: 4e6 });
    }
  } else if (srv.type === 'nameserver') {
    add('bind', 'named', '/usr/sbin/named -f -u bind', budget * 0.7, 380e6, 86400 * 40, { thr: 8 });
    add('root', 'sshd', 'sshd: /usr/sbin/sshd -D', 0, 8e6, 86400 * 40);
  } else {
    add('mysql', 'mariadbd', '/usr/sbin/mariadbd', budget * 0.85, memUsed * 0.85, 86400 * 30, { thr: 220, rio: 30e6 * noise(seed, t, 200), wio: 12e6 * noise(seed + 2, t, 200) });
    add('root', 'mariabackup', 'mariabackup --backup --target-dir=/backup/nightly', hash(Math.floor(t / 3600)) > 0.6 ? 45 : 0, 500e6, 2400, { rio: 80e6, wio: 60e6 });
  }
  add('root', 'systemd', '/sbin/init', 0, 12e6, 86400 * 12);
  add('root', 'python3', '/usr/bin/python3 /opt/nb-agent/nb-agent.py', 0.3, 30e6, 86400 * 12);

  const users = {};
  for (const p of list) {
    const u = users[p.user] ||= { user: p.user, procs: 0, cpu: 0, rss: 0, rio: 0, wio: 0 };
    u.procs++; u.cpu += p.cpu; u.rss += p.rss; u.rio += p.rio; u.wio += p.wio;
  }
  const userList = Object.values(users).map((u) => ({ ...u, cpu: Math.round(u.cpu * 10) / 10 })).sort((a, b) => b.cpu - a.cpu);
  return { total: 180 + (seed * 13) % 250, running: 1 + Math.floor(cpuPct / 25), list, users: userList };
}

function genPayload(srv, seed, t) {
  const sc = scenario[srv.name] || {};
  const hourOfDay = new Date(t * 1000).getHours() + new Date(t * 1000).getMinutes() / 60;
  const daily = 0.55 + 0.45 * Math.sin(((hourOfDay - 8) / 24) * 2 * Math.PI);
  let cpu = srv.base * daily + 15 * noise(seed, t, 600) + 8 * noise(seed + 50, t, 90) - 4;
  if (noise(seed + 99, t, 1800) > 0.93) cpu += 45; // af en toe een piek
  if (sc.cpuBoost) cpu += sc.cpuBoost;
  cpu = clamp(cpu, 1, 99.5);
  let iowait = clamp(2 * noise(seed + 7, t, 300) + (sc.iowaitSpikes && noise(seed + 8, t, 900) > 0.75 ? 30 : 0), 0, 60);
  const steal = clamp(noise(seed + 9, t, 600) * 1.5, 0, 5);
  const system = cpu * 0.25;
  const load1 = clamp((cpu / 100) * srv.cores * (1 + 0.3 * noise(seed + 3, t, 120)) + (iowait / 100) * srv.cores + (sc.loadBoost || 0) * srv.cores * (0.8 + 0.2 * noise(seed, t, 60)), 0.01, 999);
  const memPct = clamp(45 + (seed * 7) % 30 + 8 * noise(seed + 11, t, 3600), 5, 99);
  const memUsed = (srv.mem * memPct) / 100;
  const diskBase = sc.diskPct ?? 30 + (seed * 11) % 45;
  const diskPct = clamp(diskBase + (t % 86400) / 86400 * 0.5, 1, 99.9);
  const swapPct = clamp(memPct > 80 ? 20 : 2 + 3 * noise(seed + 12, t, 3600), 0, 100);

  const disks = [{ mount: '/', device: '/dev/sda1', fs: 'ext4', total: srv.disk, used: (srv.disk * diskPct) / 100, pct: Math.round(diskPct * 10) / 10, inodes_pct: Math.round(diskPct * 0.6 * 10) / 10 }];
  if (srv.type !== 'nameserver') disks.push({ mount: '/backup', device: '/dev/sdb1', fs: 'ext4', total: srv.disk * 2, used: srv.disk * 2 * 0.42, pct: 42 + (seed % 10), inodes_pct: 3 });

  const services = srv.type === 'plesk'
    ? { 'sw-cp-server': 'active', 'sw-engine': 'active', nginx: 'active', apache2: 'active', mariadb: 'active', postfix: 'active', dovecot: 'active', fail2ban: 'active', 'plesk-php82-fpm': 'active', cron: 'active' }
    : srv.type === 'nameserver' ? { named: 'active', cron: 'active', ssh: 'active' } : { mariadb: 'active', cron: 'active', ssh: 'active' };
  if (sc.failed) services[sc.failed] = 'failed';

  const rx = srv.type === 'database' ? 40e6 : srv.type === 'nameserver' ? 300e3 : 2e6;
  return {
    agent: '1.0.0-demo',
    ts: t,
    system: {
      hostname: srv.name + DOMAIN, kernel: '5.15.0-122-generic', os: 'Ubuntu 22.04.5 LTS',
      plesk: srv.type === 'plesk' ? '18.0.64' : null, uptime: 86400 * 12 + (t % 86400), reboot_required: seed % 9 === 0,
    },
    cpu: { pct: Math.round(cpu * 10) / 10, user: Math.round((cpu - system) * 10) / 10, system: Math.round(system * 10) / 10, iowait: Math.round(iowait * 10) / 10, steal: Math.round(steal * 10) / 10, cores: srv.cores, model: 'AMD EPYC 7543P 32-Core Processor' },
    load: [load1, load1 * 0.92, load1 * 0.85].map((v) => Math.round(v * 100) / 100),
    mem: { total: srv.mem, used: memUsed, available: srv.mem - memUsed, buffers: srv.mem * 0.02, cached: srv.mem * 0.25, pct: Math.round(memPct * 10) / 10, swap_total: 4 * GB, swap_used: (4 * GB * swapPct) / 100, swap_pct: Math.round(swapPct * 10) / 10 },
    disks,
    diskio: { read: rx * 0.8 * noise(seed + 20, t, 300) + (iowait > 20 ? 60e6 : 0), write: rx * 1.2 * noise(seed + 21, t, 300), util: clamp(iowait * 2 + 10 * noise(seed + 22, t, 300), 0, 100), riops: 120 * noise(seed, t, 300), wiops: 200 * noise(seed + 1, t, 300) },
    net: { rx: Math.round(rx * (0.3 + daily) * noise(seed + 30, t, 240)), tx: Math.round(rx * 3 * (0.3 + daily) * noise(seed + 31, t, 240)) },
    procs: genProcs(srv, seed, t, cpu, memUsed),
    services,
    failed: sc.failed ? [`${sc.failed}.service`] : [],
    mailq: srv.type === 'plesk' ? Math.round((sc.mailq || 5) * (0.8 + 0.4 * noise(seed + 40, t, 600))) : null,
  };
}

// ---------- servers aanmaken + historie ----------

const now = store.nowSec();
const servers = [];
const existing = store.listServers();
for (const [i, srv] of fleet.entries()) {
  let row = existing.find((s) => s.hostname === srv.name + DOMAIN);
  let token;
  if (!row) {
    ({ server: row, token } = store.createServer({ name: srv.name, hostname: srv.name + DOMAIN, type: srv.type, notes: 'Demo-server' }));
  } else {
    token = store.regenerateToken(row.id);
  }
  servers.push({ ...srv, id: row.id, token, seed: i + 1 });
}

console.log('Historie van 7 dagen genereren…');
store.db.exec('BEGIN');
for (const s of servers) {
  const end = scenario[s.name]?.offline ? now - 7200 : now - LIVE_INTERVAL;
  for (let t = now - 7 * 86400; t <= end; t += 120) {
    const p = genPayload(s, s.seed, t);
    store.insertMetrics(s.id, t, store.metricsFromPayload(p));
    if (t > now - 72 * 3600 && t % 600 < 120) {
      const snap = { total: p.procs.total, running: p.procs.running, list: p.procs.list, users: p.procs.users };
      store.insertSnapshot(s.id, t, zlib.deflateSync(JSON.stringify(snap)));
    }
  }
  if (scenario[s.name]?.offline) store.markSeen(s.id, end, JSON.stringify(genPayload(s, s.seed, end)));
}
store.db.exec('COMMIT');
console.log(`${servers.length} demo-servers klaar. Live metingen naar ${BASE} elke ${LIVE_INTERVAL}s (Ctrl+C om te stoppen).`);

// ---------- live ----------

async function tick() {
  const t = store.nowSec();
  await Promise.all(servers.filter((s) => !scenario[s.name]?.offline).map(async (s) => {
    try {
      const r = await fetch(`${BASE}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
        body: JSON.stringify(genPayload(s, s.seed, t)),
      });
      if (!r.ok) console.warn(`${s.name}: HTTP ${r.status}`);
    } catch (e) {
      console.warn(`${s.name}: ${e.message} — draait het dashboard (npm start)?`);
    }
  }));
}
tick();
setInterval(tick, LIVE_INTERVAL * 1000);
