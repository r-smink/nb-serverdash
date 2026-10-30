// Demo-simulator: maakt 24 Plesk-servers + nameserver + shared database server aan,
// vult 7 dagen historie en stuurt daarna live metingen naar het dashboard.
//
//   npm run demo          (dashboard moet draaien: npm start)
//   npm run demo:clean    verwijdert alle demo-servers

import zlib from 'node:zlib';
import { config } from '../server/config.js';
import * as store from '../server/db.js';

const DOMAIN = '.demo.local';
const T0 = Math.floor(Date.now() / 1000);
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
  web13: { diskPct: 91, diskGrowth: 1.1 },          // schijf groeit snel -> vol over ~8 dagen
  web15: { backupFailed: true },                    // laatste back-up mislukt -> kritiek
  web09: { backupAgeH: 31 },                        // back-up te oud -> waarschuwing
  web02: { attacked: true },                        // veel wp-login/xmlrpc-aanvallen
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
  const diskBase = sc.diskPct != null ? sc.diskPct - (sc.diskGrowth || 0) * (T0 - t) / 86400 : 30 + (seed * 11) % 45;
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
    dt: LIVE_INTERVAL,
    security: genSecurity(srv, seed, t, LIVE_INTERVAL),
    usage: { domains: genDomainUsage(srv, seed, t, LIVE_INTERVAL) },
    mysql: genMysql(srv, seed, t),
  };
}

// ---------- websites ----------

const DEMO_SITES = [
  { domain: 'autobedrijf.nl', server: 'web07', rpm: 90, cpu: 190 },                 // CPU-slurper (queue worker)
  { domain: 'tandarts-zuid.nl', server: 'web07', rpm: 25, cpu: 60 },
  { domain: 'webshop-xl.nl', server: 'web01', rpm: 600, cpu: 80 },                  // drukke webshop
  { domain: 'bakkerijdejong.nl', server: 'web05', rpm: 15, cpu: 5 },
  { domain: 'kapsalon-anna.nl', server: 'web03', rpm: 8, cpu: 3 },
  { domain: 'makelaardij.nl', server: 'web12', rpm: 120, cpu: 40, err: 0.12 },      // veel 5xx-fouten
  { domain: 'nextbuzz.nl', server: 'web21', rpm: 40, cpu: 12 },
  { domain: 'restaurant-zee.nl', server: 'web19', rpm: 20, cpu: 8, down: true },   // server offline
];

const PATHS = ['/', '/wp-admin/admin-ajax.php', '/wp-login.php', '/xmlrpc.php', '/producten', '/winkelwagen', '/contact',
  '/wp-content/uploads/2026/10/header.jpg', '/feed/', '/sitemap.xml', '/api/voorraad', '/.env'];
const AGENTS = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1',
  'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'Mozilla/5.0 (compatible; Googlebot/2.1)',
  'Mozilla/5.0 (compatible; SemrushBot/7~bl)', 'WordPress/6.6; https://example.nl', 'python-requests/2.32'];

function genSiteStats(site, seed, t, srvName) {
  const hourOfDay = new Date(t * 1000).getHours();
  const daily = 0.35 + 0.65 * Math.max(0, Math.sin(((hourOfDay - 7) / 24) * 2 * Math.PI));
  const rpm = site.rpm * daily * (0.6 + 0.8 * noise(seed, t, 300));
  const err = site.err ? site.err * (0.6 + 0.8 * noise(seed + 1, t, 600)) : 0.002;
  const cpu = site.cpu * (0.5 + 0.5 * daily) * (0.7 + 0.6 * noise(seed + 2, t, 240));
  const user = site.domain.replace(/\..*$/, '').replace(/-/g, '_').slice(0, 12);
  const pick = (arr, n, s) => arr.map((k, i) => [k, Math.max(1, Math.round(n * (0.5 + hash(s + i * 7 + Math.floor(t / 60))) / (i + 1)))])
    .sort((a, b) => b[1] - a[1]);
  const top = [
    { pid: 20000 + seed * 10, ppid: 1, user, name: 'php-fpm', cmd: `php-fpm: pool ${site.domain}`, cpu: Math.round(cpu * 0.6 * 10) / 10, rss: 120e6 + seed * 9e6, mem: 0.4, rio: 0, wio: 2000, ctime: 8000, age: 86400 * 2, thr: 1, st: 'R' },
    { pid: 20001 + seed * 10, ppid: 1, user, name: 'php-fpm', cmd: `php-fpm: pool ${site.domain}`, cpu: Math.round(cpu * 0.3 * 10) / 10, rss: 95e6, mem: 0.3, rio: 0, wio: 0, ctime: 3000, age: 3600, thr: 1, st: 'S' },
  ];
  if (site.cpu > 100) top.unshift({ pid: 20005 + seed * 10, ppid: 1, user, name: 'php', cmd: `/opt/plesk/php/8.2/bin/php /var/www/vhosts/${site.domain}/httpdocs/artisan queue:work --tries=3`, cpu: Math.round(cpu * 0.9 * 10) / 10, rss: 380e6, mem: 0.6, rio: 1e4, wio: 5e4, ctime: 250000, age: 3 * 86400 + 4000, thr: 1, st: 'R' });
  return {
    found: true, user, docroot: `/var/www/vhosts/${site.domain}/httpdocs`,
    cpu: Math.round(cpu * 10) / 10, rss: Math.round(top.reduce((a, p) => a + p.rss, 0)), rio: Math.round(5e4 * noise(seed + 3, t, 120)),
    wio: Math.round(2e5 * noise(seed + 4, t, 120)), procs: top.length + 2, top,
    disk: (2 + (seed * 7) % 40) * 1024 ** 3,
    req: Math.round(rpm / 2), rpm: Math.round(rpm * 10) / 10, bw: Math.round(rpm * 85e3 / 60),
    s2: Math.round(rpm * (0.82 - err) * 10) / 10, s3: Math.round(rpm * 0.12 * 10) / 10, s4: Math.round(rpm * 0.06 * 10) / 10, s5: Math.round(rpm * err * 10) / 10,
    paths: pick(PATHS, rpm / 3, seed), ips: pick(['203.0.113.7', '198.51.100.23', '192.0.2.44', '2001:db8::17', '203.0.113.99', '198.51.100.4'], rpm / 4, seed + 50),
    agents: pick(AGENTS, rpm / 3, seed + 90), log: 'proxy_access_log', log_truncated: false, srv: srvName,
  };
}

// ---------- extra demo-data (agent 1.2) ----------

const subsFor = (srv, seed) => (srv.type === 'plesk' ? SUBSCRIPTIONS.slice(seed % 5, (seed % 5) + 6) : []);
const domainsFor = (srv, seed) => [...new Set([...subsFor(srv, seed).map((u) => `${u}.nl`), ...DEMO_SITES.filter((d) => d.server === srv.name).map((d) => d.domain)])];

function genSecurity(srv, seed, t, dt) {
  const sc = scenario[srv.name] || {};
  const k = dt / 60;
  const wave = noise(seed + 70, t, 1800);
  const attack = srv.type === 'plesk' ? (sc.attacked ? 90 : 6) * wave * k : 0;
  return {
    ssh_fail: Math.round((srv.type === 'nameserver' ? 3 : 1.5) * noise(seed + 71, t, 600) * k * 2),
    wpl: Math.round(attack), xml: Math.round(attack * (sc.attacked ? 1.6 : 0.4)),
    modsec: Math.round((srv.type === 'plesk' ? 1.2 : 0) * noise(seed + 72, t, 900) * k * 2),
    f2b: srv.type === 'nameserver' ? { jails: [{ name: 'ssh', banned: 4, total: 310 }], banned: 4 } : {
      jails: [
        { name: 'plesk-apache', banned: Math.round(5 + 10 * wave), total: 900 + seed * 13 },
        { name: 'plesk-wordpress', banned: Math.round((sc.attacked ? 60 : 4) * wave), total: (sc.attacked ? 6000 : 300) + seed },
        { name: 'plesk-postfix', banned: 2, total: 120 }, { name: 'ssh', banned: 3, total: 400 + seed }, { name: 'recidive', banned: 1, total: 20 },
      ],
      get banned() { return this.jails.reduce((a, j) => a + j.banned, 0); },
    },
  };
}

function genDomainUsage(srv, seed, t, dt) {
  const out = {};
  const k = dt / 60;
  domainsFor(srv, seed).forEach((d, i) => {
    const site = DEMO_SITES.find((x) => x.domain === d);
    const rpm = (site ? site.rpm : 8 + ((seed + i) * 7) % 30) * (0.5 + noise(seed + i, t, 300));
    const req = Math.round(rpm * k);
    const att = scenario[srv.name]?.attacked && i < 2 ? Math.round(40 * noise(seed + i + 80, t, 1200) * k) : Math.round(2 * noise(seed + i + 80, t, 1200) * k);
    out[d] = [req, req * 85000, Math.round(req * (site?.err || 0.003)), att, Math.round(att * 0.8)];
  });
  return out;
}

function genMysql(srv, seed, t) {
  if (srv.type === 'nameserver') return undefined;
  const db = srv.type === 'database';
  const conns = Math.round((db ? 160 : 12) * (0.6 + 0.6 * noise(seed + 90, t, 300)));
  return {
    version: '10.11.9-MariaDB-0ubuntu0.24.04.1', conns, running: Math.round(conns * 0.06) + 1,
    max_conn: db ? 500 : 151, max_used: db ? 342 : 48,
    qps: Math.round((db ? 1800 : 90) * (0.6 + 0.6 * noise(seed + 91, t, 240)) * 10) / 10,
    slow: Math.round((db ? 2.5 : 0.1) * noise(seed + 92, t, 600) * 100) / 100,
    slow_log: 'ON', long_query_time: '2.000000', uptime: 86400 * 30 + (t % 86400), aborted: 12, hit: db ? 99.31 : 99.87,
    long: db ? [
      { id: 88123, user: 'wp_webshopxl', db: 'webshopxl_wp', time: 140 + (t % 600), state: 'Sending data', info: "SELECT p.ID, pm.meta_value FROM wp_posts p JOIN wp_postmeta pm ON pm.post_id = p.ID WHERE pm.meta_key = '_price' ORDER BY pm.meta_value+0 DESC" },
      { id: 88190, user: 'makelaar', db: 'makelaardij_crm', time: 35, state: 'Creating sort index', info: 'SELECT * FROM objecten WHERE plaats LIKE "%dam%" ORDER BY prijs' },
      { id: 88201, user: 'wp_autobedrijf', db: 'autobedrijf_wp', time: 3, state: 'updating', info: "UPDATE wp_options SET option_value = '...' WHERE option_name = '_transient_timeout_wc_count_comments'" },
    ] : [],
    users: db ? [['wp_webshopxl', 48], ['makelaar', 31], ['wp_autobedrijf', 22], ['wp_tandarts', 14], ['root', 1]] : [['admin', 2], ['wp_local', conns - 2]],
    repl: db ? { io: 'Yes', sql: 'Yes', lag: Math.round(3 * noise(seed + 93, t, 120)), master: 'db00.nextbuzz.lan', error: '' } : null,
  };
}

const WP_PLUGINS = [['akismet', '5.3'], ['contact-form-7', '5.8.1'], ['wordpress-seo', '21.0'], ['woocommerce', '8.2.0'], ['elementor', '3.16.0'],
  ['wordfence', '7.10.0'], ['really-simple-ssl', '7.0.0'], ['updraftplus', '1.23.10'], ['classic-editor', '1.6.3'], ['nextbuzz-maatwerk', '2.1']];

function genExtras(srv, seed, t) {
  const sc = scenario[srv.name] || {};
  const lastBackup = Math.floor(t / 86400) * 86400 + 2 * 3600 - (t % 86400 < 2 * 3600 ? 86400 : 0) - (sc.backupAgeH ? sc.backupAgeH * 3600 - 6 * 3600 : 0);
  const subs = subsFor(srv, seed);
  const extras = {
    backups: {
      checked: t, source: srv.type === 'database' ? 'paths' : 'plesk', count: srv.type === 'database' ? 0 : 7,
      last: { ts: lastBackup, size: Math.round(srv.disk * 0.12), status: sc.backupFailed ? 'error' : seed % 7 === 0 ? 'warnings' : 'success',
        name: srv.type === 'database' ? '/backup/nightly/mariabackup.xbstream' : `backup_info_${new Date(lastBackup * 1000).toISOString().slice(2, 16).replace(/\D/g, '')}.xml`,
        source: srv.type === 'database' ? 'paths' : 'plesk' },
    },
    updates: {
      total: (seed * 7) % 23, security: seed % 4 === 0 ? (seed * 3) % 9 : 0, checked: t,
      packages: [['openssl', true], ['libssl3', true], ['linux-image-generic', false], ['curl', seed % 2 === 0], ['tzdata', false], ['plesk-php83', false]].slice(0, 2 + (seed % 5)),
    },
  };
  if (srv.type === 'database') {
    extras.dbs = { checked: t, list: Array.from({ length: 24 }, (_, i) => [`${SUBSCRIPTIONS[i % 12].replace(/-/g, '_')}_${['wp', 'crm', 'shop'][i % 3]}`, Math.round((40 - i * 1.5) * 1.3 ** (8 - (i % 8)) * 1024 ** 2 * 10), i % 5 === 0 ? 300 * 1024 ** 2 : 0, 12 + i * 3]) };
  }
  if (srv.type === 'plesk') {
    extras.domains = domainsFor(srv, seed);
    extras.user_domains = Object.fromEntries(subs.map((u) => [u, `${u}.nl`]));
    extras.wordpress = {
      checked: t,
      sites: subs.slice(0, 4).map((u, i) => ({
        domain: `${u}.nl`, path: `${u}.nl/httpdocs`, version: ['6.4.2', '6.6.2', '6.7.1', '6.5.5'][(seed + i) % 4],
        plugins: WP_PLUGINS.filter((_, j) => (j + seed + i) % 3 !== 0),
        themes: [['twentytwentyfour', '1.0'], ['astra', '4.6.0']].slice(0, 1 + ((seed + i) % 2)),
      })),
    };
  }
  return extras;
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
  // TCP-check naar het dashboard zelf laten wijzen (demo-hostnames bestaan niet); web19 krijgt een dichte poort.
  const reachCfg = { ports: scenario[srv.name]?.offline ? '9' : String(config.port), reachHost: '127.0.0.1', reach: true, backup: { enabled: true, maxAgeHours: 0 } };
  store.updateServer(row.id, { name: srv.name, hostname: srv.name + DOMAIN, type: srv.type, notes: 'Demo-server', muted: false, config: reachCfg });
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
  store.setServerExtra(s.id, genExtras(s, s.seed, end));

  // Verbruik en beveiliging per uur (voor de pagina's Verbruik en Beveiliging)
  for (let h = Math.floor((now - 7 * 86400) / 3600) * 3600; h <= end; h += 3600) {
    const t = h + 1800;
    const procs = genProcs(s, s.seed, t, 40, s.mem * 0.5).users;
    for (const u of procs) store.addUsage(s.id, h, u.user, (u.cpu / 100) * 3600 * (0.5 + noise(s.seed, t, 7200)), u.rss, (u.rio + u.wio) * 3600);
    for (const [d, v] of Object.entries(genDomainUsage(s, s.seed, t, 3600))) store.addDomainUsage(s.id, h, d, ...v);
    const sec = genSecurity(s, s.seed, t, 3600);
    store.addSecurity(s.id, h, sec.ssh_fail, sec.wpl, sec.xml, sec.modsec, sec.f2b.banned);
  }
}
store.db.exec('COMMIT');

console.log('Demo-websites aanmaken…');
const existingSites = store.listWebsites();
store.db.exec('BEGIN');
for (const [i, site] of DEMO_SITES.entries()) {
  const srv = servers.find((s) => s.name === site.server);
  if (existingSites.some((w) => w.domain === site.domain)) continue;
  const w = store.createWebsite({
    server_id: srv.id, domain: site.domain, keyword: '', notes: 'Demo-website', check_enabled: true,
    url: site.down ? 'http://127.0.0.1:9/' : `${BASE}/login.html`,
  });
  const end = site.down ? now - 7200 : now - LIVE_INTERVAL;
  for (let t = now - 7 * 86400; t <= now - 60; t += 120) {
    const stats = genSiteStats(site, i + 1, t, srv.name);
    if (t <= end) store.insertSiteMetrics(w.id, t, stats);
    const up = t <= end && hash(t + i) > 0.002;
    store.insertCheck(w.id, t, up, up ? 200 : null, up ? Math.round(stats.rpm > 300 ? 180 + 300 * noise(i, t, 600) : 60 + 120 * noise(i, t, 600)) : null);
  }
  if (!site.down) store.setSiteStats(w.id, now, JSON.stringify(genSiteStats(site, i + 1, now, srv.name)));
  else store.setSiteStats(w.id, end, JSON.stringify(genSiteStats(site, i + 1, end, srv.name)));
}
store.db.exec('COMMIT');

console.log(`${servers.length} demo-servers klaar. Live metingen naar ${BASE} elke ${LIVE_INTERVAL}s (Ctrl+C om te stoppen).`);

// ---------- live ----------

let tickNo = 0;
async function tick() {
  const t = store.nowSec();
  const withExtras = tickNo++ % 30 === 0;
  await Promise.all(servers.filter((s) => !scenario[s.name]?.offline).map(async (s) => {
    try {
      const payload = genPayload(s, s.seed, t);
      if (withExtras) Object.assign(payload, genExtras(s, s.seed, t));
      payload.security = JSON.parse(JSON.stringify(payload.security));
      // Net als de echte agent: meet de sites die het dashboard in de vorige response noemde.
      if (s.sites?.length) {
        payload.sites = {};
        for (const domain of s.sites) {
          const idx = DEMO_SITES.findIndex((d) => d.domain === domain);
          payload.sites[domain] = idx >= 0 ? genSiteStats(DEMO_SITES[idx], idx + 1, t, s.name) : { found: false };
        }
      }
      const r = await fetch(`${BASE}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
        body: JSON.stringify(payload),
      });
      if (!r.ok) console.warn(`${s.name}: HTTP ${r.status}`);
      else s.sites = (await r.json()).sites;
    } catch (e) {
      console.warn(`${s.name}: ${e.message} — draait het dashboard (npm start)?`);
    }
  }));
}
tick();
setInterval(tick, LIVE_INTERVAL * 1000);
