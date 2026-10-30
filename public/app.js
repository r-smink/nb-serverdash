'use strict';
/* global uPlot */

// ---------- helpers ----------

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const main = $('#main');

const TYPES = { plesk: 'Plesk', nameserver: 'Nameserver', database: 'Database', other: 'Overig' };
const LEVEL_RANK = { crit: 4, warn: 3, pending: 2, ok: 1, muted: 0 };
const LEVEL_LABEL = { crit: 'Kritiek', warn: 'Waarschuwing', pending: 'Wacht op data', ok: 'OK', muted: 'Gepauzeerd' };
const C = {
  blue: '#2A6FDB', green: '#1F9D55', purple: '#7C5CD6', orange: '#E8A317', red: '#E22830',
  teal: '#14A098', pink: '#D9468F', grey: '#9B9B98', yellow: '#C9A100', cyan: '#2BA3D9',
};
const PALETTE = [C.blue, C.green, C.orange, C.purple, C.teal, C.pink, C.yellow, C.red, C.cyan];

const fmt = {
  bytes(n) {
    if (n == null) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    n = +n;
    while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${i === 0 || n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
  },
  rate: (n) => (n == null ? '–' : `${fmt.bytes(n)}/s`),
  pct: (n, d = 0) => (n == null ? '–' : `${(+n).toFixed(d)}%`),
  num: (n, d = 2) => (n == null ? '–' : (+n).toFixed(d)),
  int: (n) => (n == null ? '–' : Math.round(n).toLocaleString('nl-NL')),
  dur(s) {
    if (s == null) return '–';
    s = Math.floor(s);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}u`;
    if (h) return `${h}u ${m}m`;
    if (m) return `${m}m ${s % 60}s`;
    return `${s}s`;
  },
  ago(ts) {
    if (!ts) return 'nooit';
    const s = Math.max(0, Date.now() / 1000 - ts);
    return s < 60 ? 'zojuist' : `${fmt.dur(s)} geleden`;
  },
  time: (ts) => new Date(ts * 1000).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
  clock: (ts) => new Date(ts * 1000).toLocaleTimeString('nl-NL'),
};

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401 && path !== '/login') {
    location.href = '/login.html';
    throw new Error('Niet ingelogd');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function setConn(ok, msg) {
  const el = $('#conn');
  el.classList.toggle('err', !ok);
  el.textContent = ok ? `Live · bijgewerkt ${new Date().toLocaleTimeString('nl-NL')}` : `Verbinding mislukt: ${msg}`;
}

const prefs = JSON.parse(localStorage.getItem('sd-prefs') || '{}');
const savePrefs = () => localStorage.setItem('sd-prefs', JSON.stringify(prefs));

function lvlFor(v, t) {
  if (v == null || !t) return '';
  return v >= t.crit ? 'crit' : v >= t.warn ? 'warn' : '';
}

// ---------- router ----------

const view = { nav: 0, timers: [], charts: [], cleanup: [] };

function resetView() {
  view.nav++;
  view.timers.forEach(clearInterval);
  view.charts.forEach((c) => c.destroy());
  view.cleanup.forEach((f) => f());
  view.timers = [];
  view.charts = [];
  view.cleanup = [];
}

// Ingelogde gebruiker; viewers krijgen geen beheerknoppen (.admin-only).
let me = { username: '', role: 'viewer' };
const isAdmin = () => me.role === 'admin';

const PAGES = [
  ['#/websites', () => renderWebsites()], ['#/verbruik', () => renderUsage()], ['#/onderhoud', () => renderMaintenance()],
  ['#/beveiliging', () => renderSecurity()], ['#/incidenten', () => renderIncidents()], ['#/beheer', () => renderAdmin()],
  ['#/account', () => renderAccount()], ['#/tv', () => renderTv()],
];

function route() {
  resetView();
  const h = location.hash || '#/';
  document.body.classList.toggle('tv', h.startsWith('#/tv'));
  const section = h.startsWith('#/website') ? '#/websites' : h.startsWith('#/server') ? '#/'
    : (PAGES.find(([p]) => h.startsWith(p))?.[0] || '#/');
  $$('.topbar nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === section));
  window.scrollTo(0, 0);
  let m = h.match(/^#\/server\/(\d+)/);
  if (m) return renderDetail(+m[1]);
  m = h.match(/^#\/website\/(\d+)/);
  if (m) return renderWebsite(+m[1]);
  const page = PAGES.find(([p]) => h.startsWith(p));
  if (page) return page[1]();
  return renderOverview();
}

async function boot() {
  try {
    me = (await api('/me')).user;
  } catch { return; }
  document.body.classList.toggle('role-viewer', !isAdmin());
  $('#whoami').textContent = `👤 ${me.username}`;
  window.addEventListener('hashchange', route);
  route();
  updateIncidentBadge();
  setInterval(updateIncidentBadge, 30_000);
}

async function updateIncidentBadge() {
  try {
    const d = await api('/incidents?open=1');
    const open = d.incidents.filter((i) => !i.ended);
    const b = $('#incBadge');
    b.textContent = open.length;
    b.classList.toggle('hidden', !open.length);
    b.classList.toggle('crit', open.some((i) => i.level === 'crit' && !i.ack_ts));
  } catch { /* volgende keer opnieuw */ }
}

/* global toggleTheme */
$('#themeToggle').onclick = toggleTheme;
// Grafieken lezen hun as-kleuren bij het tekenen; na een themawissel opnieuw tekenen.
window.addEventListener('themechange', () => { if (view.charts.length) route(); });

$('#logout').onclick = async () => {
  await api('/logout', { method: 'POST', body: {} }).catch(() => {});
  location.href = '/login.html';
};

// ---------- overzicht ----------

let overviewData = null;

function renderOverview() {
  const nav = view.nav;
  const filter = prefs.filter || 'all';
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Overzicht</h1><p>Plesk-, nameserver- en databaseservers — realtime.</p></div>
      <div class="right summary" id="summary"></div>
    </div>
    <div class="toolbar">
      <div class="filters">
        <input id="search" type="search" placeholder="Zoek server…" value="${esc(prefs.search || '')}">
        <div class="seg" id="typeFilter">
          ${[['all', 'Alle'], ['problems', 'Problemen'], ['plesk', 'Plesk'], ['nameserver', 'Nameserver'], ['database', 'Database']]
            .map(([k, l]) => `<button data-k="${k}" class="${filter === k ? 'on' : ''}">${l}</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="tile-groups" id="grid"><div class="empty">Laden…</div></div>
    <section class="panel"><h3>Recente meldingen</h3><ul class="events" id="events"></ul></section>`;

  $('#search').oninput = (e) => { prefs.search = e.target.value; savePrefs(); drawOverview(); };
  $('#typeFilter').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    prefs.filter = b.dataset.k;
    savePrefs();
    $$('#typeFilter button').forEach((x) => x.classList.toggle('on', x === b));
    drawOverview();
  };
  if (overviewData) drawOverview();
  loadOverview(nav);
  view.timers.push(setInterval(() => loadOverview(nav), 10_000));
}

async function loadOverview(nav) {
  try {
    const d = await api('/overview');
    if (nav !== view.nav) return;
    overviewData = d;
    drawOverview();
    setConn(true);
  } catch (e) {
    setConn(false, e.message);
  }
}

function drawOverview() {
  const d = overviewData;
  if (!d || !$('#grid')) return;
  const counts = { crit: 0, warn: 0, ok: 0, pending: 0, muted: 0 };
  d.servers.forEach((s) => counts[s.status.level]++);
  $('#summary').innerHTML = `
    <span class="chip">${d.servers.length} servers</span>
    <span class="chip crit ${counts.crit ? 'has' : ''}">${counts.crit} kritiek</span>
    <span class="chip warn ${counts.warn ? 'has' : ''}">${counts.warn} waarschuwing</span>
    <span class="chip ok">${counts.ok} OK</span>
    ${counts.pending ? `<span class="chip">${counts.pending} wachtend</span>` : ''}
    ${counts.muted ? `<span class="chip">${counts.muted} gepauzeerd</span>` : ''}
    ${d.openIncidents ? `<a class="chip warn has" href="#/incidenten">${d.openIncidents} open incident${d.openIncidents === 1 ? '' : 'en'}</a>` : ''}`;

  const q = (prefs.search || '').toLowerCase();
  const f = prefs.filter || 'all';
  const list = d.servers
    .filter((s) => f === 'all' || (f === 'problems' ? s.status.level === 'crit' || s.status.level === 'warn' : s.type === f))
    .filter((s) => !q || `${s.name} ${s.hostname} ${s.notes}`.toLowerCase().includes(q))
    .sort((a, b) => LEVEL_RANK[b.status.level] - LEVEL_RANK[a.status.level] || a.name.localeCompare(b.name, 'nl', { numeric: true }));

  $('#grid').innerHTML = list.length
    ? tileGroups(list, (s) => tileHtml(s, d))
    : `<div class="empty">${d.servers.length ? 'Geen servers die aan het filter voldoen.' : 'Nog geen servers. <a href="#/beheer">Voeg je eerste server toe</a>.'}</div>`;

  $('#events').innerHTML = eventsHtml(d.events, true) || '<li class="muted">Nog geen meldingen</li>';
  document.title = counts.crit ? `(${counts.crit}) ServerDash` : 'ServerDash';
}

// Kritieke tegels bovenaan in een eigen rij van 3, de rest (oranje, groen, wachtend) daaronder 4 op een rij.
function tileGroups(list, render) {
  const crit = list.filter((x) => x.status.level === 'crit');
  const order = { warn: 0, ok: 1, pending: 2, muted: 3 };
  const rest = list.filter((x) => x.status.level !== 'crit').sort((a, b) => order[a.status.level] - order[b.status.level]);
  return (crit.length ? `<div class="grid grid-crit">${crit.map(render).join('')}</div>` : '')
    + (rest.length ? `<div class="grid grid-rest">${rest.map(render).join('')}</div>` : '');
}

function meter(label, value, text, lvl) {
  const w = Math.min(100, Math.max(0, value || 0));
  return `<div class="meter ${lvl}"><span class="ml">${label}</span><span class="bar"><i style="width:${w}%"></i></span><span class="mv">${text}</span></div>`;
}

function sparkSvg(vals, max = 100) {
  if (!vals || !vals.some((v) => v != null)) return '<div class="spark"></div>';
  const w = 300, h = 40, n = vals.length;
  let line = '', area = '', seg = [];
  const flush = () => {
    if (seg.length) {
      area += `M${seg[0][0]},${h}L${seg.map((p) => p.join(',')).join('L')}L${seg[seg.length - 1][0]},${h}Z`;
      line += `M${seg.map((p) => p.join(',')).join('L')}`;
    }
    seg = [];
  };
  let gap = 0;
  vals.forEach((v, i) => {
    if (v == null) {
      if (++gap >= 3) flush(); // alleen echte gaten (>= 3 min) onderbreken de lijn
      return;
    }
    gap = 0;
    seg.push([((i / (n - 1)) * w).toFixed(1), (h - 1 - (Math.min(v, max) / max) * (h - 2)).toFixed(1)]);
  });
  flush();
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path class="a" d="${area}"/><path class="l" d="${line}" vector-effect="non-scaling-stroke"/></svg>`;
}

function tileHtml(s, d) {
  const th = d.thresholds, m = s.summary, lvl = s.status.level;
  const big = d.enlarge && lvl === 'crit';
  const issues = s.status.issues.filter((i) => i.level !== 'info' && i.level !== 'pending');
  let body;
  if (!m || s.status.offline) {
    body = `<div class="tile-empty">${esc(s.status.issues[0]?.msg || 'Geen data')}</div>`;
  } else {
    const loadPc = (m.load[0] ?? 0) / (m.cores || 1);
    body = `
      <div class="meters">
        ${meter('CPU', m.cpu, fmt.pct(m.cpu), lvlFor(m.cpu, th.cpu))}
        ${meter('RAM', m.mem_pct, fmt.pct(m.mem_pct), lvlFor(m.mem_pct, th.mem))}
        ${meter('Disk', m.disk?.pct, m.disk ? fmt.pct(m.disk.pct) : '–', lvlFor(m.disk?.pct, th.disk))}
        ${meter('Load', (loadPc / th.load.crit) * 100, fmt.num(m.load[0]), lvlFor(loadPc, th.load))}
      </div>
      ${sparkSvg(s.spark)}
      <div class="tile-foot"><span>↓ ${fmt.rate(m.net_rx)} ↑ ${fmt.rate(m.net_tx)}</span><span>up ${fmt.dur(m.uptime)}</span></div>`;
  }
  const showIssues = issues.length && (lvl === 'crit' || lvl === 'warn' || lvl === 'muted') && !s.status.offline;
  return `
    <a class="tile lvl-${lvl}${big ? ' big' : ''}" href="#/server/${s.id}" title="${esc(s.notes)}">
      <div class="tile-head"><span class="dot"></span><span class="tile-name">${esc(s.name)}</span><span class="badge">${TYPES[s.type] || esc(s.type)}</span></div>
      <div class="tile-host">${esc(s.hostname) || '&nbsp;'}${m?.cores ? ` · ${m.cores} cores · ${fmt.bytes(m.mem_total)}` : ''}</div>
      ${showIssues ? `<ul class="issues">${issues.slice(0, big ? 6 : 2).map((i) => `<li class="${i.level}">${esc(i.msg)}</li>`).join('')}</ul>` : ''}
      ${body}
    </a>`;
}

function eventsHtml(events, withServer) {
  return (events || []).map((e) => `
    <li class="${withServer ? '' : ''}">
      <span class="t">${fmt.time(e.ts)}</span>
      ${withServer ? `<a href="#/server/${e.server_id}"><b>${esc(e.server_name)}</b></a>` : ''}
      <span class="lvl-${e.level}">${esc(e.message)}</span>
    </li>`).join('');
}

// ---------- detail ----------

const RANGES = [['1u', 3600], ['6u', 21600], ['24u', 86400], ['7d', 604800], ['30d', 2592000]];

const CHART_DEFS = [
  { key: 'cpu', title: 'CPU-gebruik', y: 'pct', max: 100, series: [['cpu', 'Totaal', C.blue, true], ['cpu_user', 'User', C.green], ['cpu_system', 'System', C.purple], ['cpu_iowait', 'IO-wait', C.orange], ['cpu_steal', 'Steal', C.red]] },
  { key: 'load', title: 'Load average', y: 'num', series: [['load1', '1 min', C.blue, true], ['load5', '5 min', C.green], ['load15', '15 min', C.purple], ['cores', 'Cores', C.grey]] },
  { key: 'mem', title: 'Geheugen', y: 'pct', max: 100, series: [['mem_pct', 'In gebruik', C.teal, true], ['cache_pct', 'Cache', C.grey], ['swap_pct', 'Swap', C.orange]] },
  { key: 'diskio', title: 'Disk I/O', y: 'rate', series: [['disk_read', 'Lezen', C.blue, true], ['disk_write', 'Schrijven', C.pink, true]] },
  { key: 'util', title: 'Disk-belasting', y: 'pct', max: 100, series: [['disk_util', 'Utilisatie', C.orange, true], ['cpu_iowait', 'IO-wait', C.red]] },
  { key: 'net', title: 'Netwerk', y: 'rate', series: [['net_rx', 'Inkomend', C.green, true], ['net_tx', 'Uitgaand', C.blue, true]] },
  { key: 'space', title: 'Schijfruimte', y: 'pct', max: 100, dynamic: true },
  { key: 'procs', title: 'Processen & mailwachtrij', y: 'int', series: [['procs', 'Processen', C.purple, true], ['mailq', 'Mailwachtrij', C.yellow]] },
  { key: 'db', title: 'Database: verbindingen & queries', y: 'num', optional: true, series: [['db_conns', 'Verbindingen', C.teal, true], ['db_running', 'Actief', C.orange], ['db_qps', 'Queries/s', C.blue], ['db_slow', 'Trage queries/min', C.red]] },
  { key: 'reach', title: 'Bereikbaarheid (TCP vanaf dashboard)', y: 'ms', optional: true, src: 'reach', series: [['ms', 'Connect-tijd', C.green, true]] },
];

const Y_FMT = {
  pct: (v) => fmt.pct(v, v < 10 && v % 1 ? 1 : 0),
  num: (v) => fmt.num(v, v < 10 ? 2 : 1),
  rate: fmt.rate,
  int: fmt.int,
  ms: (v) => `${Math.round(v)} ms`,
  bytes: fmt.bytes,
};

// ---------- gedeelde grafieken ----------

/** Tekent (of ververst) een set grafieken in elementen #c-<key> .plot */
function drawChartSet(defs, m, seriesFor, dataFor, opts) {
  for (const def of defs) {
    const box = $(`#c-${def.key}`);
    if (!box) continue;
    const plot = $('.plot', box);
    const series = seriesFor(def, m);
    const data = dataFor(def, m, series);
    const sig = series.map((s) => s[0]).join('|');
    const existing = view.charts.find((c) => c._key === def.key);
    $('h4 span', box).textContent = m.bucket > 60 ? `gem. per ${fmt.dur(m.bucket)}` : '';

    const remove = () => { if (existing) { existing.destroy(); view.charts.splice(view.charts.indexOf(existing), 1); } };
    if (!data[0].length || !series.length) {
      remove();
      plot.innerHTML = '<div class="nodata">Geen data in deze periode</div>';
      continue;
    }
    if (existing && existing._sig === sig) {
      existing.setData(data);
      continue;
    }
    remove();
    plot.innerHTML = '';
    const u = makeChart(plot, def, series, data, opts);
    u._key = def.key;
    u._sig = sig;
    view.charts.push(u);
  }
}

function makeChart(el, def, series, data, { syncKey, onZoom, onPick }) {
  const yfmt = Y_FMT[def.y];
  const css = getComputedStyle(document.documentElement);
  const gridCol = css.getPropertyValue('--chart-grid').trim();
  const axis = {
    stroke: css.getPropertyValue('--chart-axis').trim(), grid: { stroke: gridCol, width: 1 }, ticks: { stroke: gridCol, width: 1 },
    font: "11px 'Hanken Grotesk', Segoe UI, sans-serif",
  };
  let down = null;
  return new uPlot({
    width: Math.max(300, el.clientWidth),
    height: 200,
    cursor: { sync: { key: syncKey }, drag: { x: true, y: false, setScale: false }, points: { size: 6 } },
    scales: {
      x: { time: true },
      y: { range: def.max ? [0, def.max] : (_u, _min, max) => [0, max > 0 ? max * 1.15 : 1] },
    },
    axes: [
      {
        ...axis,
        values: (self, vals) => {
          const span = self.scales.x.max - self.scales.x.min;
          const o = span > 2 * 86400 ? { day: '2-digit', month: '2-digit' }
            : span > 86400 ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
          return vals.map((v) => new Date(v * 1000).toLocaleString('nl-NL', o));
        },
      },
      { ...axis, size: 64, values: (_u, vals) => vals.map((v) => yfmt(v)) },
    ],
    series: [
      { value: (_u, v) => (v == null ? '–' : fmt.time(v)) },
      ...series.map(([, label, color, fill]) => ({
        label, stroke: color, width: 1.6, fill: fill ? `${color}1f` : undefined,
        value: (_u, v) => (v == null ? '–' : yfmt(v)), points: { show: false },
        dash: label === 'Cores' ? [4, 4] : undefined,
      })),
    ],
    hooks: {
      setSelect: [(self) => {
        if (self.select.width < 8) return;
        const min = self.posToVal(self.select.left, 'x');
        const max = self.posToVal(self.select.left + self.select.width, 'x');
        self.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
        onZoom?.(min, max);
      }],
      ready: [(self) => {
        self.over.addEventListener('mousedown', (e) => { down = [e.clientX, e.clientY]; });
        self.over.addEventListener('mouseup', (e) => {
          if (!down) return;
          const moved = Math.abs(e.clientX - down[0]) > 4;
          down = null;
          const idx = self.cursor.idx;
          if (moved || idx == null) return;
          onPick?.(self.data[0][idx]);
        });
      }],
    },
  }, data, el);
}

function observeCharts(container) {
  const ro = new ResizeObserver(() => {
    for (const u of view.charts) {
      const w = u.root.parentElement.clientWidth;
      if (w && Math.abs(w - u.width) > 2) u.setSize({ width: w, height: 200 });
    }
  });
  ro.observe(container);
  view.cleanup.push(() => ro.disconnect());
}

function procRow(p) {
  const cpuCls = p.cpu >= 80 ? 'hot' : p.cpu >= 30 ? 'warm' : '';
  return `<tr>
    <td class="num">${p.pid}</td>
    <td>${esc(p.user)}</td>
    <td class="num ${cpuCls}"><span class="cellbar"><i style="width:${Math.min(100, p.cpu)}%"></i></span>${fmt.pct(p.cpu, 1)}</td>
    <td class="num">${fmt.bytes(p.rss)} <span class="muted">(${fmt.pct(p.mem, 1)})</span></td>
    <td class="num">${p.rio ? fmt.rate(p.rio) : '–'}</td>
    <td class="num">${p.wio ? fmt.rate(p.wio) : '–'}</td>
    <td class="num">${fmt.dur(p.ctime)}</td>
    <td class="num ${p.age > 3600 && p.cpu > 20 ? 'warm' : ''}">${fmt.dur(p.age)}</td>
    <td class="num">${p.thr}</td>
    <td class="cmd" title="${esc(p.cmd)}">${esc(p.cmd)}</td>
  </tr>`;
}

const PROC_TABS = [
  ['cpu', 'CPU', (a, b) => b.cpu - a.cpu],
  ['mem', 'Geheugen', (a, b) => b.rss - a.rss],
  ['io', 'Disk I/O', (a, b) => b.rio + b.wio - (a.rio + a.wio)],
  ['ctime', 'CPU-tijd', (a, b) => b.ctime - a.ctime],
  ['long', 'Langlopend', (a, b) => b.age - a.age],
];

function renderDetail(id) {
  const nav = view.nav;
  const st = { id, range: prefs.range || 3600, zoom: null, snap: null, info: null, metrics: null, chartKeys: {} };

  main.innerHTML = `
    <div id="dhead"></div>
    <div class="toolbar">
      <div class="seg" id="ranges">${RANGES.map(([l, r]) => `<button data-r="${r}" class="${r === st.range ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button id="resetZoom" class="btn ghost small hidden">Zoom resetten</button>
      <span class="hint">Sleep in een grafiek om in te zoomen · klik op een moment om de processen van dat moment te zien</span>
    </div>
    <div class="charts" id="charts">${CHART_DEFS.map((d) => `
      <div class="chart" id="c-${d.key}"><h4>${d.title}<span></span></h4><div class="plot"></div></div>`).join('')}
    </div>
    <section class="panel" id="procPanel"></section>
    <section class="panel hidden" id="dbPanel"></section>
    <div class="cols3">
      <section class="panel" id="usersPanel"></section>
      <section class="panel" id="svcPanel"></section>
      <section class="panel" id="diskPanel"></section>
    </div>
    <div class="cols3">
      <section class="panel" id="backupPanel"></section>
      <section class="panel" id="updatePanel"></section>
      <section class="panel" id="secPanel"></section>
    </div>
    <div class="cols">
      <section class="panel" id="infoPanel"></section>
      <section class="panel">
        <h3>Incidenten (30 dagen)</h3><ul class="events compact" id="incList"></ul>
        <h3 style="margin-top:16px">Meldingen</h3><ul class="events compact" id="eventList"></ul>
      </section>
    </div>`;

  $('#ranges').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    st.range = +b.dataset.r;
    prefs.range = st.range;
    savePrefs();
    $$('#ranges button').forEach((x) => x.classList.toggle('on', x === b));
    st.zoom = null;
    $('#resetZoom').classList.add('hidden');
    loadMetrics();
  };
  $('#resetZoom').onclick = () => {
    st.zoom = null;
    $('#resetZoom').classList.add('hidden');
    loadMetrics();
  };

  async function loadInfo() {
    try {
      const d = await api(`/servers/${id}`);
      if (nav !== view.nav) return;
      st.info = d;
      drawHead(d);
      drawSide(d);
      if (!st.snap) drawProcs();
      setConn(true);
    } catch (e) {
      if (nav !== view.nav) return;
      setConn(false, e.message);
      if (!st.info) main.innerHTML = `<div class="empty">${esc(e.message)} — <a href="#/">terug naar overzicht</a></div>`;
    }
  }

  async function loadMetrics() {
    try {
      const q = st.zoom ? `from=${Math.floor(st.zoom[0])}&to=${Math.ceil(st.zoom[1])}` : `range=${st.range}`;
      const m = await api(`/servers/${id}/metrics?${q}`);
      if (nav !== view.nav) return;
      st.metrics = m;
      drawCharts(m);
    } catch (e) {
      setConn(false, e.message);
    }
  }

  function drawHead(d) {
    const p = d.payload, lvl = d.status.level;
    const issues = d.status.issues.filter((i) => i.level !== 'pending');
    $('#dhead').innerHTML = `
      <div class="dhead lvl-${lvl}">
        <a href="#/" class="back" title="Terug">←</a>
        <span class="dot"></span>
        <h2>${esc(d.name)}</h2>
        <span class="badge">${TYPES[d.type] || esc(d.type)}</span>
        <span class="lvl-label">${LEVEL_LABEL[lvl]}</span>
      </div>
      <div class="dsub">${[esc(d.hostname), p?.system?.os && esc(p.system.os), p?.system?.plesk && `Plesk ${esc(p.system.plesk)}`,
        p?.cpu?.cores && `${p.cpu.cores} cores`, p?.mem?.total && `${fmt.bytes(p.mem.total)} RAM`, `laatst gezien ${fmt.ago(d.last_seen)}`]
        .filter(Boolean).join(' · ')}</div>
      ${issues.length ? `<div class="alert ${d.status.real === 'crit' ? '' : 'warn'}"><ul class="issues">${issues.map((i) => `<li class="${i.level}">${esc(i.msg)}</li>`).join('')}</ul></div>` : ''}`;
  }

  function seriesFor(def, m) {
    if (def.dynamic) {
      return Object.keys(m.disks.mounts).map((mount, i) => [mount, mount, PALETTE[i % PALETTE.length], true]);
    }
    const src = def.src ? m[def.src] : m.series;
    return def.series.filter(([k]) => (k !== 'mailq' && !def.optional) || (src[k] || []).some((v) => v != null && (k !== 'mailq' || v)));
  }

  function dataFor(def, m, series) {
    if (def.dynamic) return [m.disks.ts, ...series.map(([k]) => m.disks.mounts[k])];
    if (def.src) return [m[def.src].ts, ...series.map(([k]) => m[def.src][k])];
    return [m.series.ts, ...series.map(([k]) => (k === 'cores' ? m.series.ts.map(() => m.cores) : m.series[k]))];
  }

  const chartOpts = {
    syncKey: `sd-${id}`,
    onZoom: (min, max) => {
      st.zoom = [min, max];
      $('#resetZoom').classList.remove('hidden');
      loadMetrics();
    },
    onPick: (ts) => showSnapshot(ts),
  };
  const drawCharts = (m) => {
    for (const def of CHART_DEFS.filter((d) => d.optional)) $(`#c-${def.key}`).classList.toggle('hidden', !seriesFor(def, m).length);
    drawChartSet(CHART_DEFS, m, seriesFor, dataFor, chartOpts);
  };
  observeCharts($('#charts'));

  async function showSnapshot(ts) {
    try {
      const d = await api(`/servers/${id}/processes?ts=${Math.round(ts)}`);
      if (nav !== view.nav) return;
      if (!d.procs) { alert('Geen processnapshot beschikbaar rond dit moment (snapshots worden beperkt bewaard).'); return; }
      st.snap = d;
      drawProcs();
      drawUsers();
      $('#procPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { alert(e.message); }
  }

  function currentProcs() {
    return st.snap ? st.snap.procs : st.info?.payload?.procs;
  }

  function drawProcs() {
    const procs = currentProcs();
    const tab = prefs.procTab || 'cpu';
    const [, , sorter] = PROC_TABS.find((t) => t[0] === tab) || PROC_TABS[0];
    let list = [...(procs?.list || [])];
    if (tab === 'long') list = list.filter((p) => p.age >= 600);
    list.sort(sorter);
    list = list.slice(0, 40);
    const when = st.snap ? `op ${fmt.time(st.snap.ts)}` : '— live';
    $('#procPanel').innerHTML = `
      <div class="panel-head">
        <h3>Processen ${when}</h3>
        ${procs ? `<span class="muted">${procs.total} processen, ${procs.running} actief</span>` : ''}
        <div class="right">
          ${st.snap ? '<button class="btn small" id="liveBtn">Terug naar live</button>' : ''}
          <div class="seg tabs" id="procTabs">${PROC_TABS.map(([k, l]) => `<button data-k="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>
        </div>
      </div>
      ${tab === 'long' ? '<p class="note">Processen die langer dan 10 minuten draaien en CPU of disk gebruiken, gesorteerd op looptijd.</p>' : ''}
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th class="num">PID</th><th>Gebruiker</th><th class="num">CPU</th><th class="num">Geheugen</th>
            <th class="num">Lezen</th><th class="num">Schrijven</th><th class="num">CPU-tijd</th><th class="num">Looptijd</th>
            <th class="num">Threads</th><th>Commando</th>
          </tr></thead>
          <tbody>${list.map(procRow).join('') || '<tr><td colspan="10" class="muted">Geen processen</td></tr>'}</tbody>
        </table>
      </div>`;
    $('#procTabs').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      prefs.procTab = b.dataset.k;
      savePrefs();
      drawProcs();
    };
    const live = $('#liveBtn');
    if (live) live.onclick = () => { st.snap = null; drawProcs(); drawUsers(); };
  }

  function drawUsers() {
    const users = currentProcs()?.users || [];
    $('#usersPanel').innerHTML = `
      <h3>Verbruik per gebruiker / abonnement ${st.snap ? `<span class="muted">op ${fmt.time(st.snap.ts)}</span>` : ''}</h3>
      <div class="table-wrap" style="max-height:380px">
        <table>
          <thead><tr><th>Gebruiker</th><th class="num">Proc.</th><th class="num">CPU</th><th class="num">Geheugen</th><th class="num">Disk I/O</th></tr></thead>
          <tbody>${users.map((u) => `<tr>
            <td>${esc(u.user)}</td><td class="num">${u.procs}</td>
            <td class="num ${u.cpu >= 80 ? 'hot' : u.cpu >= 30 ? 'warm' : ''}">${fmt.pct(u.cpu, 1)}</td>
            <td class="num">${fmt.bytes(u.rss)}</td><td class="num">${u.rio + u.wio ? fmt.rate(u.rio + u.wio) : '–'}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">Geen data</td></tr>'}</tbody>
        </table>
      </div>`;
  }

  function drawSide(d) {
    const p = d.payload;
    drawUsers();

    const services = Object.entries(p?.services || {});
    const failed = (p?.failed || []).filter((u) => !(u.replace(/\.service$/, '') in (p?.services || {})));
    $('#svcPanel').innerHTML = `
      <h3>Services</h3>
      <table><tbody>
        ${services.map(([n, s]) => `<tr><td>${esc(n)}</td><td class="num"><span class="state ${s === 'active' ? '' : s === 'activating' || s === 'reloading' ? 'idle' : 'bad'}">${esc(s)}</span></td></tr>`).join('')}
        ${failed.map((u) => `<tr><td>${esc(u)}</td><td class="num"><span class="state bad">failed</span></td></tr>`).join('')}
        ${!services.length && !failed.length ? '<tr><td class="muted">Geen bewaakte services gevonden</td></tr>' : ''}
      </tbody></table>`;

    const th = d.thresholds;
    $('#diskPanel').innerHTML = `<h3>Schijven</h3>${(p?.disks || []).map((x) => `
      <div class="disk">
        <div class="disk-head"><b>${esc(x.mount)}</b><span>${fmt.bytes(x.used)} / ${fmt.bytes(x.total)} · ${fmt.pct(x.pct, 1)}</span></div>
        <div class="bar ${lvlFor(x.pct, th.disk)}"><i style="width:${Math.min(100, x.pct)}%"></i></div>
        <div class="sub">${esc(x.device)} · ${esc(x.fs)}${x.inodes_pct != null ? ` · inodes ${fmt.pct(x.inodes_pct, 1)}` : ''}</div>
      </div>`).join('') || '<p class="muted">Geen data</p>'}
      ${forecastHtml(d.forecast)}
      ${p?.diskio ? `<p class="note">I/O nu: lezen ${fmt.rate(p.diskio.read)} (${fmt.int(p.diskio.riops)} IOPS), schrijven ${fmt.rate(p.diskio.write)} (${fmt.int(p.diskio.wiops)} IOPS), utilisatie ${fmt.pct(p.diskio.util)}</p>` : ''}`;

    const sys = p?.system || {};
    const rows = [
      ['Hostname', sys.hostname], ['Besturingssysteem', sys.os], ['Kernel', sys.kernel], ['Plesk', sys.plesk],
      ['CPU', p?.cpu?.model && `${p.cpu.model} (${p.cpu.cores} cores)`], ['Geheugen', p?.mem && `${fmt.bytes(p.mem.total)} RAM, ${fmt.bytes(p.mem.swap_total)} swap`],
      ['Uptime', sys.uptime != null && fmt.dur(sys.uptime)], ['Load', p?.load?.map((v) => fmt.num(v)).join(' / ')],
      ['Mailwachtrij', p?.mailq != null && fmt.int(p.mailq)], ['Herstart nodig', sys.reboot_required ? 'Ja' : sys.hostname && 'Nee'],
      ['Agent', d.agent], ['Laatst gezien', d.last_seen && `${fmt.time(d.last_seen)} (${fmt.ago(d.last_seen)})`],
      ['TCP-check', d.reach ? `${d.reach.ok ? `OK, poort ${d.reach.port} in ${d.reach.ms} ms` : `MISLUKT (${d.reach.error || 'geen verbinding'}) op ${d.reach.ports.join(', ')}`} · ${d.reach.host} · ${fmt.ago(d.reach.ts)}`
        : d.reachTarget ? 'wacht op eerste controle' : 'uit (geen hostname)'],
      ['Notities', d.notes],
    ].filter(([, v]) => v);
    $('#infoPanel').innerHTML = `
      <div class="panel-head"><h3>Systeeminformatie</h3><div class="right"><a class="btn ghost small admin-only" href="#/beheer">Beheren</a></div></div>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <h3 style="margin-top:18px">Bewaakte websites</h3>
      <div class="site-links">${(d.websites || []).map((w) => `
        <a class="lvl-${w.level}" href="#/website/${w.id}"><span class="dot"></span>${esc(w.domain)}</a>`).join('')
        || '<span class="muted">Geen — voeg ze toe via <a href="#/websites">Websites</a></span>'}</div>`;

    $('#eventList').innerHTML = eventsHtml(d.events, false) || '<li class="muted">Geen meldingen</li>';
    $('#incList').innerHTML = d.incidents.map((i) => `
      <li><span class="t">${fmt.time(i.started)}</span><a href="#/incidenten/${i.id}" class="lvl-${i.ended ? 'ok' : i.level}">
        ${i.ended ? '✓' : '●'} ${esc(i.summary || i.title)} ${i.ended ? `(${fmt.dur(i.ended - i.started)})` : '(open)'}</a></li>`).join('')
      || '<li class="muted">Geen incidenten</li>';

    drawDbPanel(p?.mysql, d.dbs, d.dbs_ts, th);
    drawBackupPanel(d);
    drawUpdatePanel(d, p);
    drawSecPanel(p?.security);
  }

  function drawDbPanel(m, dbs, dbsTs, th) {
    const el = $('#dbPanel');
    el.classList.toggle('hidden', !m);
    if (!m) return;
    if (m.error) { el.innerHTML = `<h3>Database</h3><p class="muted">Kon MySQL/MariaDB niet uitlezen: ${esc(m.error)}</p>`; return; }
    const connPct = m.max_conn ? (m.conns / m.max_conn) * 100 : null;
    el.innerHTML = `
      <div class="panel-head"><h3>Database — ${esc(m.version || 'MySQL/MariaDB')}</h3><span class="muted">uptime ${fmt.dur(m.uptime)}</span></div>
      <div class="shares">
        <div class="share"><div class="share-head"><span>Verbindingen</span><b>${m.conns}${m.max_conn ? ` / ${m.max_conn}` : ''}</b></div>
          <div class="bar ${lvlFor(connPct, th.dbConn)}"><i style="width:${Math.min(100, connPct || 0)}%"></i></div>
          <small>piek ${m.max_used} · ${m.running} nu bezig</small></div>
        <div class="share"><div class="share-head"><span>Queries</span><b>${fmt.num(m.qps, 1)}/s</b></div>
          <small>trage queries: ${fmt.num(m.slow, 2)}/min (slow log ${esc(m.slow_log || '?')}, drempel ${esc(m.long_query_time || '?')} s)</small></div>
        <div class="share"><div class="share-head"><span>Buffer-pool hit</span><b>${fmt.pct(m.hit, 2)}</b></div>
          <small>${m.hit < 95 ? 'laag: overweeg een grotere innodb_buffer_pool_size' : 'gezond'}</small></div>
        <div class="share"><div class="share-head"><span>Replicatie</span><b>${m.repl ? (m.repl.lag != null ? `${m.repl.lag} s` : '?') : '–'}</b></div>
          <small>${m.repl ? `IO ${esc(m.repl.io)} · SQL ${esc(m.repl.sql)} · master ${esc(m.repl.master || '?')}${m.repl.error ? ` · ${esc(m.repl.error)}` : ''}` : 'geen replicatie ingesteld'}</small></div>
      </div>
      <div class="cols" style="gap:24px">
        <div>
          <h3 style="margin-top:16px">Lopende queries (langste eerst)</h3>
          <div class="table-wrap" style="max-height:320px"><table>
            <thead><tr><th class="num">Tijd</th><th>Gebruiker</th><th>Database</th><th>Status</th><th>Query</th></tr></thead>
            <tbody>${(m.long || []).map((q) => `<tr>
              <td class="num ${lvlFor(q.time, th.longQuery) === 'crit' ? 'hot' : lvlFor(q.time, th.longQuery) ? 'warm' : ''}">${fmt.dur(q.time)}</td>
              <td>${esc(q.user)}</td><td>${esc(q.db)}</td><td>${esc(q.state)}</td>
              <td class="cmd" title="${esc(q.info)}">${esc(q.info)}</td></tr>`).join('')
              || '<tr><td colspan="5" class="muted">Geen lopende queries</td></tr>'}</tbody>
          </table></div>
        </div>
        <div>
          <h3 style="margin-top:16px">Grootste databases ${dbsTs ? `<span class="muted" style="font-weight:400">· ${fmt.ago(dbsTs)}</span>` : ''}</h3>
          <div class="table-wrap" style="max-height:320px"><table>
            <thead><tr><th>Database</th><th class="num">Grootte</th><th class="num">Vrij te maken</th><th class="num">Tabellen</th></tr></thead>
            <tbody>${(dbs?.list || []).map(([n, size, free, tables]) => `<tr><td>${esc(n)}</td><td class="num">${fmt.bytes(size)}</td>
              <td class="num">${free > 50 * 1024 ** 2 ? fmt.bytes(free) : '–'}</td><td class="num">${tables}</td></tr>`).join('')
              || '<tr><td colspan="4" class="muted">Nog niet gemeten (elke 6 uur)</td></tr>'}</tbody>
          </table></div>
          <h3 style="margin-top:16px">Verbindingen per gebruiker</h3>
          <div class="site-links">${(m.users || []).map(([u, n]) => `<span class="badge">${esc(u)}: ${n}</span>`).join('') || '<span class="muted">–</span>'}</div>
        </div>
      </div>`;
  }

  function drawBackupPanel(d) {
    const b = d.backups, cfg = d.config?.backup || {};
    let body;
    if (cfg.enabled === false) body = '<p class="muted">Back-upbewaking staat uit voor deze server.</p>';
    else if (!b) body = '<p class="muted">Nog geen gegevens (agent 1.2+ nodig, controle elke 10 minuten).</p>';
    else if (!b.last) body = '<p class="lvl-warn">Geen back-up gevonden.</p>';
    else {
      const age = Date.now() / 1000 - b.last.ts;
      const lim = (cfg.maxAgeHours || d.thresholds.backupAge.warn) * 3600;
      const cls = b.last.status === 'error' || age > lim * 2 ? 'lvl-crit' : age > lim ? 'lvl-warn' : '';
      body = `<dl class="kv">
        <dt>Laatste back-up</dt><dd class="${cls}">${fmt.time(b.last.ts)} (${fmt.ago(b.last.ts)})</dd>
        <dt>Resultaat</dt><dd>${BACKUP_STATUS[b.last.status] || esc(b.last.status)}</dd>
        <dt>Grootte</dt><dd>${b.last.size ? fmt.bytes(b.last.size) : '–'}</dd>
        <dt>Bron</dt><dd>${b.last.source === 'paths' ? 'eigen back-upmap' : 'Plesk'} · <span class="muted mono">${esc(b.last.name)}</span></dd>
        ${b.count ? `<dt>Lokaal aanwezig</dt><dd>${b.count}</dd>` : ''}
        <dt>Gecontroleerd</dt><dd>${fmt.ago(b.checked)}</dd></dl>`;
    }
    $('#backupPanel').innerHTML = `<h3>Back-ups</h3>${body}`;
  }

  function drawUpdatePanel(d, p) {
    const u = d.updates;
    $('#updatePanel').innerHTML = `<h3>Updates</h3>${u ? `
      <div class="shares" style="grid-template-columns:1fr 1fr">
        <div class="share"><div class="share-head"><span>Security</span><b class="${u.security ? 'lvl-crit' : ''}">${u.security}</b></div></div>
        <div class="share"><div class="share-head"><span>Totaal</span><b>${u.total}</b></div></div>
      </div>
      <p class="note">${p?.system?.reboot_required ? '⚠ Herstart vereist · ' : ''}Plesk ${esc(p?.system?.plesk || '–')} · gecontroleerd ${fmt.ago(u.checked)}</p>
      <div class="site-links">${(u.packages || []).slice(0, 30).map(([n, sec]) => `<span class="badge ${sec ? 'sec' : ''}">${esc(n)}</span>`).join('')}</div>`
      : '<p class="muted">Nog geen gegevens (agent 1.2+ nodig, controle elk uur).</p>'}`;
  }

  function drawSecPanel(sec) {
    const f2b = sec?.f2b;
    $('#secPanel').innerHTML = `<div class="panel-head"><h3>Beveiliging</h3><div class="right"><a class="btn ghost small" href="#/beveiliging">Alle servers</a></div></div>
      ${f2b ? `<p>Fail2ban blokkeert nu <b>${f2b.banned}</b> IP-adres${f2b.banned === 1 ? '' : 'sen'}.</p>
        <table><tbody>${f2b.jails.map((j) => `<tr><td>${esc(j.name)}</td><td class="num">${j.banned} nu</td><td class="num muted">${j.total} totaal</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">Geen Fail2ban-gegevens.</p>'}
      ${sec ? `<p class="note">Laatste meting: ${sec.ssh_fail} mislukte SSH-logins, ${sec.wpl} POSTs op wp-login.php, ${sec.xml} op xmlrpc.php, ${sec.modsec} ModSecurity-blokkades.</p>` : ''}`;
  }

  loadInfo();
  loadMetrics();
  view.timers.push(setInterval(() => {
    loadInfo();
    if (!st.zoom) loadMetrics();
  }, 30_000));
}

// ---------- websites ----------

let websitesData = null;

function renderWebsites() {
  const nav = view.nav;
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Websites</h1><p>Bereikbaarheid, verkeer en serverbelasting per site.</p></div>
      <div class="right summary" id="summary"></div>
    </div>
    <div class="toolbar">
      <div class="filters">
        <input id="search" type="search" placeholder="Zoek website…" value="${esc(prefs.siteSearch || '')}">
        <select id="serverFilter" style="width:auto"><option value="">Alle servers</option></select>
        <button class="btn ghost admin-only" id="discoverSites">🔎 Ontdekken</button>
        <button class="btn admin-only" id="addSite">+ Website toevoegen</button>
      </div>
    </div>
    <div class="tile-groups sites" id="grid"><div class="empty">Laden…</div></div>`;

  $('#search').oninput = (e) => { prefs.siteSearch = e.target.value; savePrefs(); drawWebsites(); };
  $('#serverFilter').onchange = (e) => { prefs.siteServer = e.target.value; savePrefs(); drawWebsites(); };
  $('#discoverSites').onclick = async () => {
    if (await discoverDialog()) loadWebsites(nav);
  };
  $('#addSite').onclick = async () => {
    if (!websitesData) return;
    if (await websiteForm({}, websitesData.servers)) loadWebsites(nav);
  };
  if (websitesData) drawWebsites();
  loadWebsites(nav);
  view.timers.push(setInterval(() => loadWebsites(nav), 15_000));
}

async function loadWebsites(nav) {
  try {
    const d = await api('/websites');
    if (nav !== view.nav) return;
    websitesData = d;
    drawWebsites();
    setConn(true);
  } catch (e) {
    setConn(false, e.message);
  }
}

function drawWebsites() {
  const d = websitesData;
  if (!d || !$('#grid')) return;
  const sel = $('#serverFilter');
  if (sel.options.length === 1) {
    sel.insertAdjacentHTML('beforeend', [...d.servers].sort((a, b) => a.name.localeCompare(b.name, 'nl', { numeric: true }))
      .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join(''));
    sel.value = prefs.siteServer || '';
  }
  const counts = { crit: 0, warn: 0, ok: 0, pending: 0, muted: 0 };
  d.websites.forEach((w) => counts[w.status.level]++);
  $('#summary').innerHTML = `
    <span class="chip">${d.websites.length} websites</span>
    <span class="chip crit ${counts.crit ? 'has' : ''}">${counts.crit} kritiek</span>
    <span class="chip warn ${counts.warn ? 'has' : ''}">${counts.warn} waarschuwing</span>
    <span class="chip ok">${counts.ok} OK</span>`;

  const q = (prefs.siteSearch || '').toLowerCase();
  const sid = +prefs.siteServer || 0;
  const list = d.websites
    .filter((w) => !sid || w.server_id === sid)
    .filter((w) => !q || `${w.domain} ${w.server?.name || ''} ${w.notes} ${w.stats?.user || ''}`.toLowerCase().includes(q))
    .sort((a, b) => LEVEL_RANK[b.status.level] - LEVEL_RANK[a.status.level] || (b.stats?.cpu || 0) - (a.stats?.cpu || 0)
      || a.domain.localeCompare(b.domain));

  $('#grid').innerHTML = list.length ? tileGroups(list, (w) => siteTileHtml(w, d))
    : `<div class="empty">${d.websites.length ? 'Geen websites die aan het filter voldoen.' : 'Nog geen websites. Klik op "+ Website toevoegen" om een site op een van de Plesk-servers te bewaken.'}</div>`;
}

const errPct = (s) => {
  const total = s ? s.s2 + s.s3 + s.s4 + s.s5 : 0;
  return total > 0 ? (s.s5 / total) * 100 : null;
};

function siteTileHtml(w, d) {
  const th = d.thresholds, s = w.stats, c = w.check, lvl = w.status.level;
  const big = d.enlarge && lvl === 'crit';
  const issues = w.status.issues.filter((i) => i.level === 'crit' || i.level === 'warn');
  const stat = (label, value, cls = '') => `<div><span>${label}</span><b class="${cls}">${value}</b></div>`;
  const e5 = errPct(s);
  const spMax = Math.max(1, ...w.spark.filter((v) => v != null));
  return `
    <a class="tile lvl-${lvl}${big ? ' big' : ''}" href="#/website/${w.id}">
      <div class="tile-head"><span class="dot"></span><span class="tile-name">${esc(w.domain)}</span><span class="badge">${esc(w.server?.name || '?')}</span></div>
      <div class="tile-host">${[s?.user && esc(s.user), s?.disk != null && `${fmt.bytes(s.disk)} op schijf`].filter(Boolean).join(' · ') || '&nbsp;'}</div>
      ${issues.length ? `<ul class="issues">${issues.slice(0, big ? 6 : 2).map((i) => `<li class="${i.level}">${esc(i.msg)}</li>`).join('')}</ul>` : ''}
      <div class="site-stats">
        ${w.check_enabled ? stat('Respons', c?.ok ? `${c.ms} ms` : c ? 'down' : '–', c && !c.ok ? 'crit' : lvlFor(c?.ms, th.response))
          + stat('Uptime', w.uptime24 == null ? '–' : fmt.pct(w.uptime24, w.uptime24 < 100 ? 2 : 0), w.uptime24 != null && w.uptime24 < 99 ? 'warn' : '') : ''}
        ${stat('Req.', s?.found ? `${fmt.num(s.rpm, s.rpm < 10 ? 1 : 0)}/min` : '–')}
        ${stat('Verkeer', s?.found ? fmt.rate(s.bw) : '–')}
        ${stat('CPU', s?.found ? fmt.pct(s.cpu) : '–', lvlFor(s?.cpu, th.siteCpu))}
        ${stat('RAM', s?.found ? fmt.bytes(s.rss) : '–')}
      </div>
      ${sparkSvg(w.spark, spMax * 1.1)}
      <div class="tile-foot">
        <span>5xx ${e5 == null ? '–' : fmt.pct(e5, 1)}</span>
        <span>${c?.certDays != null ? `SSL ${c.certDays} d` : w.check_enabled ? '' : 'geen controle'}</span>
      </div>
    </a>`;
}

function websiteForm(w, servers) {
  return new Promise((resolve) => {
    const opts = [...servers].sort((a, b) => a.name.localeCompare(b.name, 'nl', { numeric: true }))
      .map((s) => `<option value="${s.id}" ${s.id === w.server_id ? 'selected' : ''}>${esc(s.name)}${s.type !== 'plesk' ? ` (${TYPES[s.type] || s.type})` : ''}</option>`).join('');
    const d = dialog(`
      <form class="form" method="dialog">
        <h3>${w.id ? 'Website bewerken' : 'Website toevoegen'}</h3>
        <div class="row">
          <label>Domein (zoals in Plesk)<input name="domain" required value="${esc(w.domain)}" placeholder="voorbeeld.nl"></label>
          <label>Draait op server<select name="server_id" required><option value="">Kies…</option>${opts}</select></label>
        </div>
        <label>Controle-URL<input name="url" value="${esc(w.url)}" placeholder="Standaard: https://&lt;domein&gt;/"></label>
        <div class="row">
          <label>Sleutelwoord op de pagina (optioneel)<input name="keyword" value="${esc(w.keyword)}" placeholder="bijv. ©, Winkelwagen"></label>
          <label class="check" style="align-self:end;padding-bottom:10px"><input type="checkbox" name="check_enabled" ${w.check_enabled === false ? '' : 'checked'}> Bereikbaarheid elke minuut controleren</label>
        </div>
        <label>Notities<textarea name="notes" rows="2" maxlength="2000">${esc(w.notes)}</textarea></label>
        <p class="note">CPU, geheugen, disk I/O, requests en schijfgebruik worden gemeten door de agent op de gekozen server
          (versie 1.1 of nieuwer). De agent herkent de site aan de Plesk-systeemgebruiker en de PHP-FPM-pool van het domein,
          en leest de logbestanden in <code>/var/www/vhosts/system/&lt;domein&gt;/logs</code>.</p>
        <div class="form-error"></div>
        <div class="actions">
          <button class="btn ghost" value="cancel" formnovalidate>Annuleren</button>
          <button class="btn" value="ok">${w.id ? 'Opslaan' : 'Toevoegen'}</button>
        </div>
      </form>`);
    const form = $('form', d);
    form.addEventListener('submit', async (e) => {
      if (e.submitter?.value === 'cancel') return resolve(null);
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      data.check_enabled = !!data.check_enabled;
      data.server_id = +data.server_id;
      try {
        const res = w.id
          ? await api(`/websites/${w.id}`, { method: 'PUT', body: data })
          : await api('/websites', { method: 'POST', body: data });
        d.close();
        resolve(res);
      } catch (ex) {
        $('.form-error', d).textContent = ex.message;
      }
    });
    d.addEventListener('cancel', () => resolve(null));
  });
}

const SITE_CHARTS = [
  { key: 'resp', title: 'Responstijd', y: 'ms', src: 'checks', check: true, series: [['ms', 'Responstijd', C.blue, true]] },
  { key: 'up', title: 'Beschikbaarheid', y: 'pct', max: 100, src: 'checks', check: true, series: [['up', 'Bereikbaar', C.green, true]] },
  { key: 'req', title: 'Requests per minuut', y: 'num', src: 'site', series: [['rpm', 'Totaal', C.blue, true], ['s4', '4xx', C.orange], ['s5', '5xx', C.red]] },
  { key: 'bw', title: 'Bandbreedte (verzonden)', y: 'rate', src: 'site', series: [['bw', 'Verzonden', C.teal, true]] },
  { key: 'scpu', title: 'CPU-gebruik van de site', y: 'pct', src: 'site', series: [['cpu', 'CPU (% van 1 core)', C.purple, true]] },
  { key: 'smem', title: 'Geheugen van de site', y: 'bytes', src: 'site', series: [['rss', 'RAM', C.teal, true]] },
  { key: 'sio', title: 'Disk I/O van de site', y: 'rate', src: 'site', series: [['rio', 'Lezen', C.blue, true], ['wio', 'Schrijven', C.pink, true]] },
  { key: 'sprocs', title: 'Processen van de site', y: 'int', src: 'site', series: [['procs', 'Processen', C.purple, true]] },
];

function renderWebsite(id) {
  const nav = view.nav;
  const st = { range: prefs.range || 3600, zoom: null, info: null, servers: null };

  main.innerHTML = `
    <div id="dhead"></div>
    <section class="panel share-panel" id="sharePanel" style="margin-top:0"></section>
    <div class="toolbar" style="margin-top:16px">
      <div class="seg" id="ranges">${RANGES.map(([l, r]) => `<button data-r="${r}" class="${r === st.range ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button id="resetZoom" class="btn ghost small hidden">Zoom resetten</button>
      <span class="hint">Sleep in een grafiek om in te zoomen</span>
    </div>
    <div class="charts" id="charts">${SITE_CHARTS.map((d) => `
      <div class="chart" id="c-${d.key}"><h4>${d.title}<span></span></h4><div class="plot"></div></div>`).join('')}
    </div>
    <div class="cols3">
      <section class="panel" id="pathsPanel"></section>
      <section class="panel" id="ipsPanel"></section>
      <section class="panel" id="agentsPanel"></section>
    </div>
    <section class="panel" id="sprocPanel"></section>
    <section class="panel" id="sinfoPanel"></section>`;

  $('#ranges').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    st.range = +b.dataset.r;
    prefs.range = st.range;
    savePrefs();
    $$('#ranges button').forEach((x) => x.classList.toggle('on', x === b));
    st.zoom = null;
    $('#resetZoom').classList.add('hidden');
    loadMetrics();
  };
  $('#resetZoom').onclick = () => { st.zoom = null; $('#resetZoom').classList.add('hidden'); loadMetrics(); };

  const chartOpts = {
    syncKey: `site-${id}`,
    onZoom: (min, max) => { st.zoom = [min, max]; $('#resetZoom').classList.remove('hidden'); loadMetrics(); },
  };
  observeCharts($('#charts'));

  async function loadInfo() {
    try {
      const d = await api(`/websites/${id}`);
      if (nav !== view.nav) return;
      st.info = d;
      draw(d);
      setConn(true);
    } catch (e) {
      if (nav !== view.nav) return;
      setConn(false, e.message);
      if (!st.info) main.innerHTML = `<div class="empty">${esc(e.message)} — <a href="#/websites">terug naar websites</a></div>`;
    }
  }

  async function loadMetrics() {
    try {
      const q = st.zoom ? `from=${Math.floor(st.zoom[0])}&to=${Math.ceil(st.zoom[1])}` : `range=${st.range}`;
      const m = await api(`/websites/${id}/metrics?${q}`);
      if (nav !== view.nav) return;
      const defs = SITE_CHARTS.filter((c) => !c.check || st.info?.check_enabled !== false);
      SITE_CHARTS.forEach((c) => $(`#c-${c.key}`).classList.toggle('hidden', !defs.includes(c)));
      drawChartSet(defs, m, (def) => def.series, (def, mm, series) => [mm[def.src].ts, ...series.map(([k]) => mm[def.src][k])], chartOpts);
    } catch (e) {
      setConn(false, e.message);
    }
  }

  function topList(title, rows, fmtKey) {
    const total = rows.reduce((a, [, n]) => a + n, 0) || 1;
    return `<h3>${title}</h3>
      <table class="toplist"><tbody>${rows.map(([k, n]) => `
        <tr><td class="cmd" title="${esc(k)}">${fmtKey ? fmtKey(k) : esc(k)}</td>
        <td class="num"><span class="cellbar"><i style="width:${(n / rows[0][1]) * 100}%"></i></span>${n}</td>
        <td class="num muted">${fmt.pct((n / total) * 100)}</td></tr>`).join('')
        || '<tr><td class="muted">Geen requests in de laatste meting</td></tr>'}</tbody></table>`;
  }

  function draw(d) {
    const s = d.fullStats, c = d.check, lvl = d.status.level, th = d.thresholds;
    const issues = d.status.issues.filter((i) => i.level !== 'pending');
    $('#dhead').innerHTML = `
      <div class="dhead lvl-${lvl}">
        <a href="#/websites" class="back" title="Terug">←</a>
        <span class="dot"></span>
        <h2>${esc(d.domain)}</h2>
        <a class="badge" href="#/server/${d.server_id}">${esc(d.server?.name || '?')}</a>
        <span class="lvl-label">${LEVEL_LABEL[lvl]}</span>
        <div class="right" style="margin-left:auto;display:flex;gap:8px">
          <a class="btn ghost small" href="${esc(d.url || `https://${d.domain}/`)}" target="_blank" rel="noopener noreferrer">Openen ↗</a>
          ${d.check_enabled ? '<button class="btn ghost small admin-only" id="checkNow">Nu controleren</button>' : ''}
          <button class="btn ghost small admin-only" id="editSite">Bewerken</button>
          <button class="btn danger small admin-only" id="delSite">Verwijderen</button>
        </div>
      </div>
      <div class="dsub">${[s?.user && `gebruiker ${esc(s.user)}`, s?.docroot && esc(s.docroot), d.stats_ts && `data ${fmt.ago(d.stats_ts)}`].filter(Boolean).join(' · ')}</div>
      ${issues.length ? `<div class="alert ${d.status.real === 'crit' ? '' : 'warn'}"><ul class="issues">${issues.map((i) => `<li class="${i.level}">${esc(i.msg)}</li>`).join('')}</ul></div>` : ''}`;

    const chk = $('#checkNow');
    if (chk) chk.onclick = async () => {
      chk.disabled = true;
      chk.textContent = 'Bezig…';
      try { await api(`/websites/${id}/check`, { method: 'POST', body: {} }); } catch (ex) { alert(ex.message); }
      loadInfo();
      loadMetrics();
    };
    $('#editSite').onclick = async () => {
      if (!st.servers) st.servers = (await api('/websites')).servers;
      if (await websiteForm(d, st.servers)) { loadInfo(); loadMetrics(); }
    };
    $('#delSite').onclick = async () => {
      if (!confirm(`Website ${d.domain} niet meer bewaken en alle historie verwijderen?`)) return;
      await api(`/websites/${id}`, { method: 'DELETE' });
      location.hash = '#/websites';
    };

    // Wat vraagt de site van de server?
    const si = d.serverInfo || {};
    const cpuShare = s?.found && si.cores ? s.cpu / si.cores : null;
    const memShare = s?.found && si.mem_total ? (s.rss / si.mem_total) * 100 : null;
    const e5 = errPct(s);
    const shareBar = (label, value, sub, cls) => `
      <div class="share"><div class="share-head"><span>${label}</span><b>${value}</b></div>
      ${sub}</div>`;
    const bar = (pct, cls = '') => `<div class="bar ${cls}"><i style="width:${Math.min(100, pct || 0)}%"></i></div>`;
    $('#sharePanel').innerHTML = `
      <h3>Wat vraagt deze website van ${esc(d.server?.name || 'de server')}? <span class="muted" style="font-weight:400">· laatste meting</span></h3>
      <div class="shares">
        ${shareBar('CPU', s?.found ? fmt.pct(s.cpu, 1) : '–',
          `${bar(cpuShare, lvlFor(s?.cpu, th.siteCpu))}<small>${cpuShare != null ? `${fmt.pct(cpuShare, 1)} van de totale servercapaciteit (${si.cores} cores) · server totaal ${fmt.pct(si.cpu)}` : 'van één core'}</small>`)}
        ${shareBar('Geheugen', s?.found ? fmt.bytes(s.rss) : '–',
          `${bar(memShare)}<small>${memShare != null ? `${fmt.pct(memShare, 1)} van ${fmt.bytes(si.mem_total)} RAM` : ''}</small>`)}
        ${shareBar('Requests', s?.found ? `${fmt.num(s.rpm, 1)}/min` : '–',
          `<small>2xx ${fmt.num(s?.s2, 1)} · 3xx ${fmt.num(s?.s3, 1)} · 4xx ${fmt.num(s?.s4, 1)} · 5xx ${fmt.num(s?.s5, 1)} per min${e5 != null ? ` (${fmt.pct(e5, 1)} fouten)` : ''}</small>`)}
        ${shareBar('Bandbreedte', s?.found ? fmt.rate(s.bw) : '–', '<small>verzonden naar bezoekers</small>')}
        ${shareBar('Disk I/O', s?.found ? fmt.rate(s.rio + s.wio) : '–', `<small>lezen ${fmt.rate(s?.rio)} · schrijven ${fmt.rate(s?.wio)}</small>`)}
        ${shareBar('Schijfruimte', s?.disk != null ? fmt.bytes(s.disk) : '–', '<small>webruimte, elke 6 uur gemeten</small>')}
        ${d.check_enabled ? shareBar('Responstijd', c?.ok ? `${c.ms} ms` : c ? 'down' : '–',
          `<small>${c?.ttfb != null ? `TTFB ${c.ttfb} ms · ` : ''}uptime 24u ${fmt.pct(d.uptime24, 2)} · 7d ${fmt.pct(d.uptime7d, 2)} · 30d ${fmt.pct(d.uptime30d, 2)}</small>`) : ''}
      </div>`;

    $('#pathsPanel').innerHTML = topList("Populairste URL's", s?.paths || []);
    $('#ipsPanel').innerHTML = topList('Meeste requests per IP', s?.ips || []);
    $('#agentsPanel').innerHTML = topList('User-agents (bots herkennen)', s?.agents || []);

    const procs = s?.top || [];
    $('#sprocPanel').innerHTML = `
      <div class="panel-head"><h3>Processen van deze site — live</h3><span class="muted">${s?.procs ?? 0} processen (PHP-FPM-pool, cron en scripts van ${esc(s?.user || 'de systeemgebruiker')})</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th class="num">PID</th><th>Gebruiker</th><th class="num">CPU</th><th class="num">Geheugen</th>
            <th class="num">Lezen</th><th class="num">Schrijven</th><th class="num">CPU-tijd</th><th class="num">Looptijd</th>
            <th class="num">Threads</th><th>Commando</th>
          </tr></thead>
          <tbody>${procs.map(procRow).join('') || '<tr><td colspan="10" class="muted">Geen processen actief</td></tr>'}</tbody>
        </table>
      </div>`;

    const rows = [
      ['Server', d.server && `${d.server.name} (${d.server.hostname})`], ['Systeemgebruiker', s?.user], ['Documentroot', s?.docroot],
      ['Logbestand', s?.log && `${s.log}${s.log_truncated ? ' (te groot, deels overgeslagen)' : ''}`],
      ['Controle-URL', d.check_enabled ? d.url : 'uitgeschakeld'], ['Sleutelwoord', d.keyword],
      ['Laatste controle', c && `${c.ok ? 'OK' : 'MISLUKT'} · ${c.status ? `HTTP ${c.status} · ` : ''}${c.ms} ms${c.error ? ` · ${c.error}` : ''} · ${fmt.ago(d.check_ts)}`],
      ['SSL-certificaat', c?.certValidTo && `${esc(c.certIssuer || '')} · geldig tot ${new Date(c.certValidTo * 1000).toLocaleDateString('nl-NL')} (${c.certDays} dagen)`],
      ['Notities', d.notes],
    ].filter(([, v]) => v);
    $('#sinfoPanel').innerHTML = `<h3>Details</h3><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  }

  loadInfo().then(loadMetrics);
  view.timers.push(setInterval(() => {
    loadInfo();
    if (!st.zoom) loadMetrics();
  }, 30_000));
}

// ---------- beheer ----------

function dialog(html) {
  const d = document.createElement('dialog');
  d.innerHTML = html;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

function serverForm(s = {}) {
  return new Promise((resolve) => {
    const d = dialog(`
      <form class="form" method="dialog">
        <h3>${s.id ? 'Server bewerken' : 'Server toevoegen'}</h3>
        <div class="row">
          <label>Naam<input name="name" required maxlength="100" value="${esc(s.name)}" placeholder="web01"></label>
          <label>Type<select name="type">${Object.entries(TYPES).map(([k, l]) => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <label>Hostname / IP<input name="hostname" maxlength="255" value="${esc(s.hostname)}" placeholder="web01.nextbuzz.nl"></label>
        <label>Notities<textarea name="notes" rows="3" maxlength="2000">${esc(s.notes)}</textarea></label>
        <details ${s.id ? '' : 'open'}><summary>Bereikbaarheid &amp; back-ups</summary>
          <div class="form" style="margin-top:10px">
            <div class="row">
              <label>TCP-poorten (leeg = standaard per type)<input name="ports" value="${esc(s.config?.ports || '')}" placeholder="bijv. 443,8443 of 22"></label>
              <label>Ander adres voor de TCP-check (optioneel)<input name="reachHost" value="${esc(s.config?.reachHost || '')}" placeholder="bijv. intern IP"></label>
            </div>
            <label class="check"><input type="checkbox" name="reach" ${s.config?.reach === false ? '' : 'checked'}> TCP-bereikbaarheid controleren vanaf het dashboard</label>
            <div class="row">
              <label class="check" style="align-self:end;padding-bottom:10px"><input type="checkbox" name="backupEnabled" ${s.config?.backup?.enabled === false ? '' : 'checked'}> Back-ups bewaken</label>
              <label>Back-up max. oud (uren, leeg = standaard)<input type="number" min="0" name="backupMaxAge" value="${s.config?.backup?.maxAgeHours || ''}"></label>
            </div>
          </div>
        </details>
        ${s.id ? `<label class="check"><input type="checkbox" name="muted" ${s.muted ? 'checked' : ''}> Gepauzeerd (onderhoud — geen meldingen, grijs in overzicht)</label>` : ''}
        <div class="form-error"></div>
        <div class="actions">
          <button class="btn ghost" value="cancel" formnovalidate>Annuleren</button>
          <button class="btn" value="ok">${s.id ? 'Opslaan' : 'Toevoegen'}</button>
        </div>
      </form>`);
    const form = $('form', d);
    form.addEventListener('submit', async (e) => {
      if (e.submitter?.value === 'cancel') return resolve(null);
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      data.muted = !!data.muted;
      data.config = {
        ports: data.ports, reachHost: data.reachHost, reach: !!data.reach,
        backup: { enabled: !!data.backupEnabled, maxAgeHours: +data.backupMaxAge || 0 },
      };
      try {
        const res = s.id
          ? await api(`/servers/${s.id}`, { method: 'PUT', body: data })
          : await api('/servers', { method: 'POST', body: data });
        d.close();
        resolve(res);
      } catch (ex) {
        $('.form-error', d).textContent = ex.message;
      }
    });
    d.addEventListener('cancel', () => resolve(null));
  });
}

function showInstall(name, res) {
  const d = dialog(`
    <div class="form">
      <h3>Agent installeren op ${esc(name)}</h3>
      <p class="note">Voer dit commando uit als root op de server. Het token wordt maar één keer getoond; kwijt? Gebruik dan "Nieuw token".</p>
      <div class="cmd-box"><pre id="cmd">${esc(res.installCommand)}</pre></div>
      <p class="note">
        De agent (Python 3, geen extra pakketten) wordt geïnstalleerd in <code>/opt/nb-agent</code> als systemd-service
        <code>nb-agent</code> en stuurt elke 30 seconden metrics via HTTPS naar dit dashboard. Er hoeven geen inkomende poorten open.<br>
        Token: <code>${esc(res.token)}</code><br>
        Verwijderen: <code>curl -fsSL ${esc(location.origin)}/agent/install.sh | sudo bash -s -- --uninstall</code>
      </p>
      <div class="actions">
        <button class="btn ghost" id="copy">Kopiëren</button>
        <button class="btn" id="done">Klaar</button>
      </div>
    </div>`);
  $('#copy', d).onclick = async () => {
    await navigator.clipboard.writeText(res.installCommand).catch(() => {});
    $('#copy', d).textContent = 'Gekopieerd ✓';
  };
  $('#done', d).onclick = () => d.close();
}

async function renderAdmin() {
  const nav = view.nav;
  main.innerHTML = `
    <div class="page-head"><div><h1>Beheer</h1><p>Servers en websites toevoegen, pauzeren, drempelwaarden, meldingen en gebruikers.</p></div></div>
    <section class="panel" style="margin-top:0">
      <div class="panel-head"><h3>Servers</h3><div class="right"><button class="btn" id="addBtn">+ Server toevoegen</button></div></div>
      <div class="table-wrap" id="srvTable"><p class="muted">Laden…</p></div>
    </section>
    <section class="panel" id="notifyPanel"></section>
    <section class="panel">
      <h3>Drempelwaarden</h3>
      <form id="thForm" class="form"></form>
    </section>
    <div class="cols">
      <section class="panel" id="generalPanel"></section>
      <section class="panel" id="usersAdmin"></section>
    </div>`;

  $('#addBtn').onclick = async () => {
    const res = await serverForm();
    if (!res) return;
    showInstall(res.server.name, res);
    loadServers();
  };

  async function loadServers() {
    const d = await api('/overview');
    if (nav !== view.nav) return;
    const list = d.servers.sort((a, b) => a.name.localeCompare(b.name, 'nl', { numeric: true }));
    $('#srvTable').innerHTML = `
      <table>
        <thead><tr><th>Status</th><th>Naam</th><th>Hostname</th><th>Type</th><th>Laatst gezien</th><th>Agent</th><th></th></tr></thead>
        <tbody>${list.map((s) => `
          <tr class="lvl-${s.status.level}">
            <td><span class="lvl-${s.status.level}" style="display:inline-flex;align-items:center;gap:8px"><span class="dot"></span>${LEVEL_LABEL[s.status.level]}</span></td>
            <td><a href="#/server/${s.id}"><b>${esc(s.name)}</b></a></td>
            <td>${esc(s.hostname)}</td>
            <td>${TYPES[s.type] || esc(s.type)}</td>
            <td>${fmt.ago(s.last_seen)}</td>
            <td>${esc(s.agent || '–')}</td>
            <td class="actions">
              <button class="btn ghost small" data-act="edit" data-id="${s.id}">Bewerken</button>
              <button class="btn ghost small" data-act="mute" data-id="${s.id}">${s.muted ? 'Hervatten' : 'Pauzeren'}</button>
              <button class="btn ghost small" data-act="token" data-id="${s.id}">Nieuw token</button>
              <button class="btn danger small" data-act="del" data-id="${s.id}">Verwijderen</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">Nog geen servers toegevoegd.</td></tr>'}
        </tbody>
      </table>`;
    $('#srvTable').onclick = async (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const s = list.find((x) => x.id === +b.dataset.id);
      try {
        if (b.dataset.act === 'edit') {
          if (await serverForm(s)) loadServers();
        } else if (b.dataset.act === 'mute') {
          await api(`/servers/${s.id}`, { method: 'PUT', body: { muted: !s.muted } });
          loadServers();
        } else if (b.dataset.act === 'token') {
          if (!confirm(`Nieuw token genereren voor ${s.name}? De huidige agent stopt dan met rapporteren tot je hem opnieuw installeert.`)) return;
          showInstall(s.name, await api(`/servers/${s.id}/token`, { method: 'POST', body: {} }));
        } else if (b.dataset.act === 'del') {
          if (!confirm(`Server "${s.name}" verwijderen inclusief alle historische data?`)) return;
          await api(`/servers/${s.id}`, { method: 'DELETE' });
          loadServers();
        }
      } catch (ex) { alert(ex.message); }
    };
  }

  async function loadSettings() {
    const s = await api('/settings');
    if (nav !== view.nav) return;
    const rows = [
      ['cpu', 'CPU-gebruik', '%, gemiddeld'], ['load', 'Load per core', 'load1 / cores, gemiddeld'],
      ['iowait', 'IO-wait', '%, gemiddeld'], ['mem', 'Geheugen', '% in gebruik'], ['swap', 'Swap', '%'],
      ['disk', 'Schijfruimte', '% per mount'], ['inodes', 'Inodes', '% per mount'], ['mailq', 'Mailwachtrij', 'aantal berichten'],
      ['response', 'Website: responstijd', 'ms'], ['ssl', 'Website: SSL verloopt binnen', 'dagen (lager = slechter)'],
      ['err5xx', 'Website: serverfouten', '% 5xx-responses'], ['siteCpu', 'Website: CPU', '% van één core, gemiddeld'],
      ['backupAge', 'Back-up ouder dan', 'uren'], ['diskDays', 'Schijf vol binnen', 'dagen bij huidige groei (lager = slechter)'],
      ['dbConn', 'Database-verbindingen', '% van max_connections'], ['replLag', 'Replicatie-achterstand', 'seconden'],
      ['longQuery', 'Langlopende query', 'seconden'], ['secUpdates', 'Security-updates', 'aantal (0 = alleen tonen, geen melding)'],
    ];
    const t = s.thresholds;
    $('#thForm').innerHTML = `
      <table class="th-table" style="width:auto">
        <thead><tr><th>Meting</th><th>Waarschuwing</th><th>Kritiek</th><th></th></tr></thead>
        <tbody>${rows.map(([k, l, hint]) => `<tr>
          <td>${l}</td>
          <td><input type="number" step="any" name="${k}.warn" value="${t[k].warn}"></td>
          <td><input type="number" step="any" name="${k}.crit" value="${t[k].crit}"></td>
          <td class="muted">${hint}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="row">
        <label>Gemiddelde over (minuten) voor CPU, load en IO-wait<input type="number" min="1" max="60" name="sustainMinutes" value="${t.sustainMinutes}"></label>
        <label>Offline na (seconden zonder data)<input type="number" min="60" name="offlineSeconds" value="${t.offlineSeconds}"></label>
      </div>
      <label class="check"><input type="checkbox" name="enlargeProblems" ${s.enlargeProblems ? 'checked' : ''}> Servers met een kritieke status vergroot tonen in het overzicht</label>
      <div class="form-error" id="thMsg"></div>
      <div class="actions">
        <button type="button" class="btn ghost" id="thReset">Standaardwaarden</button>
        <button class="btn">Opslaan</button>
      </div>`;
    const form = $('#thForm');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const thresholds = { sustainMinutes: +fd.get('sustainMinutes'), offlineSeconds: +fd.get('offlineSeconds') };
      for (const [k] of rows) thresholds[k] = { warn: +fd.get(`${k}.warn`), crit: +fd.get(`${k}.crit`) };
      try {
        await api('/settings', { method: 'PUT', body: { thresholds, enlargeProblems: fd.get('enlargeProblems') === 'on' } });
        $('#thMsg').style.color = 'var(--success-500)';
        $('#thMsg').textContent = 'Opgeslagen ✓';
      } catch (ex) {
        $('#thMsg').style.color = '';
        $('#thMsg').textContent = ex.message;
      }
    };
    $('#thReset').onclick = async () => {
      if (!confirm('Alle drempelwaarden terugzetten naar de standaard?')) return;
      await api('/settings', { method: 'PUT', body: { thresholds: s.defaults } });
      loadSettings();
    };
    drawNotifySettings($('#notifyPanel'), s);
    drawGeneralSettings($('#generalPanel'), s);
  }

  try {
    await Promise.all([loadServers(), loadSettings(), drawUsersAdmin($('#usersAdmin'))]);
    setConn(true);
  } catch (e) {
    setConn(false, e.message);
  }
}

