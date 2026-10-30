import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './db.js';
import * as auth from './auth.js';
import * as mon from './monitor.js';
import { routes, HttpError, refreshWordpressVersions } from './api.js';

auth.bootstrapUsers();

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
const ROLE_RANK = { viewer: 1, admin: 2 };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 4 * 1024 * 1024) {
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

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Methode niet toegestaan' });
  let file = STATIC_MAP[pathname];
  if (!file) {
    if (pathname === '/' || pathname === '/index.html') {
      if (!auth.readSession(req)) {
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

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'");
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
        user = auth.readSession(req);
        if (!user) throw new HttpError(401, 'Niet ingelogd');
        if (ROLE_RANK[user.role] < ROLE_RANK[r.role]) throw new HttpError(403, 'Hiervoor heb je beheerrechten nodig');
        if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) {
          throw new HttpError(415, 'Content-Type moet application/json zijn');
        }
      }
      const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : null;
      const out = await r.handler({ req, res, params, query: url.searchParams, body, user });
      if (!res.writableEnded) send(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, out ?? { ok: true });
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

// ---------- achtergrondtaken ----------

function every(ms, name, fn) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error(`${name}:`, e); } finally { busy = false; }
  };
  setInterval(run, ms);
  return run;
}

mon.checkAll(true);
every(15_000, 'status', () => mon.checkAll());
every(10_000, 'websitechecks', () => mon.checkDueSites());
every(15_000, 'tcp-checks', () => mon.checkDueReach());
const maintenance = every(3600_000, 'onderhoud', () => {
  store.purge();
  const n = store.compact();
  if (n) console.log(`Samengevat: ${n} oude metingen tot uurgemiddelden`);
});
setTimeout(maintenance, 30_000);
const wpRefresh = every(10 * 60_000, 'wordpress.org', () => refreshWordpressVersions());
setTimeout(wpRefresh, 20_000);

// Heartbeat naar een externe dienst (healthchecks.io, Uptime Kuma push, Better Stack…):
// als die pings uitblijven, weet je dat het dashboard zelf niet meer draait.
every(60_000, 'heartbeat', async () => {
  const url = store.getSetting('heartbeatUrl', '');
  if (url) await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((e) => console.warn(`Heartbeat mislukt: ${e.message}`));
});

server.listen(config.port, config.host, () => {
  console.log(`ServerDash draait op http://${config.host}:${config.port}`);
});
