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
  blue: '#4c9aff', green: '#22c55e', purple: '#a78bfa', orange: '#f59e0b', red: '#ef4444',
  teal: '#14b8a6', pink: '#f472b6', grey: '#64748b', yellow: '#facc15', cyan: '#38bdf8',
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

function route() {
  resetView();
  const h = location.hash || '#/';
  $$('.topbar nav a').forEach((a) => {
    const href = a.getAttribute('href');
    a.classList.toggle('active', href === '#/' ? h === '#/' || h.startsWith('#/server') : h.startsWith(href));
  });
  window.scrollTo(0, 0);
  const m = h.match(/^#\/server\/(\d+)/);
  if (m) return renderDetail(+m[1]);
  if (h.startsWith('#/beheer')) return renderAdmin();
  return renderOverview();
}

window.addEventListener('hashchange', route);
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
    <div class="toolbar">
      <div class="summary" id="summary"></div>
      <div class="filters">
        <input id="search" type="search" placeholder="Zoek server…" value="${esc(prefs.search || '')}">
        <div class="seg" id="typeFilter">
          ${[['all', 'Alle'], ['problems', 'Problemen'], ['plesk', 'Plesk'], ['nameserver', 'Nameserver'], ['database', 'Database']]
            .map(([k, l]) => `<button data-k="${k}" class="${filter === k ? 'on' : ''}">${l}</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="grid" id="grid"><div class="empty">Laden…</div></div>
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
    ${counts.muted ? `<span class="chip">${counts.muted} gepauzeerd</span>` : ''}`;

  const q = (prefs.search || '').toLowerCase();
  const f = prefs.filter || 'all';
  const list = d.servers
    .filter((s) => f === 'all' || (f === 'problems' ? s.status.level === 'crit' || s.status.level === 'warn' : s.type === f))
    .filter((s) => !q || `${s.name} ${s.hostname} ${s.notes}`.toLowerCase().includes(q))
    .sort((a, b) => LEVEL_RANK[b.status.level] - LEVEL_RANK[a.status.level] || a.name.localeCompare(b.name, 'nl', { numeric: true }));

  $('#grid').innerHTML = list.length
    ? list.map((s) => tileHtml(s, d)).join('')
    : `<div class="empty">${d.servers.length ? 'Geen servers die aan het filter voldoen.' : 'Nog geen servers. <a href="#/beheer">Voeg je eerste server toe</a>.'}</div>`;

  $('#events').innerHTML = eventsHtml(d.events, true) || '<li class="muted">Nog geen meldingen</li>';
  document.title = counts.crit ? `(${counts.crit}) ServerDash` : 'ServerDash';
}

function meter(label, value, text, lvl) {
  const w = Math.min(100, Math.max(0, value || 0));
  return `<div class="meter ${lvl}"><span class="ml">${label}</span><span class="bar"><i style="width:${w}%"></i></span><span class="mv">${text}</span></div>`;
}

function sparkSvg(vals) {
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
    seg.push([((i / (n - 1)) * w).toFixed(1), (h - 1 - (Math.min(v, 100) / 100) * (h - 2)).toFixed(1)]);
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
];

const Y_FMT = {
  pct: (v) => fmt.pct(v, v < 10 && v % 1 ? 1 : 0),
  num: (v) => fmt.num(v, v < 10 ? 2 : 1),
  rate: fmt.rate,
  int: fmt.int,
};

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
    <div class="cols3">
      <section class="panel" id="usersPanel"></section>
      <section class="panel" id="svcPanel"></section>
      <section class="panel" id="diskPanel"></section>
    </div>
    <div class="cols">
      <section class="panel" id="infoPanel"></section>
      <section class="panel"><h3>Meldingen</h3><ul class="events compact" id="eventList"></ul></section>
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
    return def.series.filter(([k]) => k !== 'mailq' || m.series.mailq.some((v) => v));
  }

  function dataFor(def, m, series) {
    if (def.dynamic) return [m.disks.ts, ...series.map(([k]) => m.disks.mounts[k])];
    return [m.series.ts, ...series.map(([k]) => (k === 'cores' ? m.series.ts.map(() => m.cores) : m.series[k]))];
  }

  function drawCharts(m) {
    for (const def of CHART_DEFS) {
      const box = $(`#c-${def.key}`);
      const plot = $('.plot', box);
      const series = seriesFor(def, m);
      const data = dataFor(def, m, series);
      const sig = series.map((s) => s[0]).join('|');
      const existing = view.charts.find((c) => c._key === def.key);
      $('h4 span', box).textContent = m.bucket > 60 ? `gem. per ${fmt.dur(m.bucket)}` : '';

      if (!data[0].length) {
        if (existing) { existing.destroy(); view.charts.splice(view.charts.indexOf(existing), 1); }
        plot.innerHTML = '<div class="nodata">Geen data in deze periode</div>';
        continue;
      }
      if (existing && existing._sig === sig) {
        existing.setData(data);
        continue;
      }
      if (existing) { existing.destroy(); view.charts.splice(view.charts.indexOf(existing), 1); }
      plot.innerHTML = '';
      const u = makeChart(plot, def, series, data);
      u._key = def.key;
      u._sig = sig;
      view.charts.push(u);
    }
  }

  function makeChart(el, def, series, data) {
    const yfmt = Y_FMT[def.y];
    const axis = { stroke: '#8a97ad', grid: { stroke: '#ffffff0d', width: 1 }, ticks: { stroke: '#ffffff0d', width: 1 }, font: '11px Inter, Segoe UI, sans-serif' };
    let down = null;
    const u = new uPlot({
      width: Math.max(300, el.clientWidth),
      height: 200,
      cursor: { sync: { key: `sd-${id}` }, drag: { x: true, y: false, setScale: false }, points: { size: 6 } },
      scales: {
        x: { time: true },
        y: { range: def.max ? [0, def.max] : (_u, _min, max) => [0, max > 0 ? max * 1.15 : 1] },
      },
      axes: [
        {
          ...axis,
          values: (self, vals) => {
            const span = self.scales.x.max - self.scales.x.min;
            const opts = span > 2 * 86400 ? { day: '2-digit', month: '2-digit' }
              : span > 86400 ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
            return vals.map((v) => new Date(v * 1000).toLocaleString('nl-NL', opts));
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
          st.zoom = [min, max];
          $('#resetZoom').classList.remove('hidden');
          loadMetrics();
        }],
        ready: [(self) => {
          self.over.addEventListener('mousedown', (e) => { down = [e.clientX, e.clientY]; });
          self.over.addEventListener('mouseup', (e) => {
            if (!down) return;
            const moved = Math.abs(e.clientX - down[0]) > 4;
            down = null;
            const idx = self.cursor.idx;
            if (moved || idx == null) return;
            showSnapshot(self.data[0][idx]);
          });
        }],
      },
    }, data, el);
    return u;
  }

  function resizeCharts() {
    for (const u of view.charts) {
      const w = u.root.parentElement.clientWidth;
      if (w && Math.abs(w - u.width) > 2) u.setSize({ width: w, height: 200 });
    }
  }
  const ro = new ResizeObserver(() => resizeCharts());
  ro.observe($('#charts'));
  view.cleanup.push(() => ro.disconnect());

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
          <div class="seg" id="procTabs">${PROC_TABS.map(([k, l]) => `<button data-k="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>
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
      ${p?.diskio ? `<p class="note">I/O nu: lezen ${fmt.rate(p.diskio.read)} (${fmt.int(p.diskio.riops)} IOPS), schrijven ${fmt.rate(p.diskio.write)} (${fmt.int(p.diskio.wiops)} IOPS), utilisatie ${fmt.pct(p.diskio.util)}</p>` : ''}`;

    const sys = p?.system || {};
    const rows = [
      ['Hostname', sys.hostname], ['Besturingssysteem', sys.os], ['Kernel', sys.kernel], ['Plesk', sys.plesk],
      ['CPU', p?.cpu?.model && `${p.cpu.model} (${p.cpu.cores} cores)`], ['Geheugen', p?.mem && `${fmt.bytes(p.mem.total)} RAM, ${fmt.bytes(p.mem.swap_total)} swap`],
      ['Uptime', sys.uptime != null && fmt.dur(sys.uptime)], ['Load', p?.load?.map((v) => fmt.num(v)).join(' / ')],
      ['Mailwachtrij', p?.mailq != null && fmt.int(p.mailq)], ['Herstart nodig', sys.reboot_required ? 'Ja' : sys.hostname && 'Nee'],
      ['Agent', d.agent], ['Laatst gezien', d.last_seen && `${fmt.time(d.last_seen)} (${fmt.ago(d.last_seen)})`],
      ['Notities', d.notes],
    ].filter(([, v]) => v);
    $('#infoPanel').innerHTML = `
      <div class="panel-head"><h3>Systeeminformatie</h3><div class="right"><a class="btn ghost small" href="#/beheer">Beheren</a></div></div>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;

    $('#eventList').innerHTML = eventsHtml(d.events, false) || '<li class="muted">Geen meldingen</li>';
  }

  loadInfo();
  loadMetrics();
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
    <section class="panel" style="margin-top:0">
      <div class="panel-head"><h3>Servers</h3><div class="right"><button class="btn" id="addBtn">+ Server toevoegen</button></div></div>
      <div class="table-wrap" id="srvTable"><p class="muted">Laden…</p></div>
    </section>
    <section class="panel">
      <h3>Drempelwaarden &amp; meldingen</h3>
      <form id="thForm" class="form"></form>
    </section>`;

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
      <label>Webhook-URL voor meldingen (Slack, Mattermost, Discord, Teams-workflow…)<input name="webhookUrl" value="${esc(s.webhookUrl)}" placeholder="https://hooks.slack.com/services/…"></label>
      <label class="check"><input type="checkbox" name="enlargeProblems" ${s.enlargeProblems ? 'checked' : ''}> Servers met een kritieke status vergroot tonen in het overzicht</label>
      <div class="form-error" id="thMsg"></div>
      <div class="actions">
        <button type="button" class="btn ghost" id="testHook">Test webhook</button>
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
        await api('/settings', { method: 'PUT', body: { thresholds, webhookUrl: fd.get('webhookUrl'), enlargeProblems: fd.get('enlargeProblems') === 'on' } });
        $('#thMsg').style.color = '#86efac';
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
    $('#testHook').onclick = async () => {
      try {
        await api('/settings/test-webhook', { method: 'POST', body: {} });
        $('#thMsg').style.color = '#86efac';
        $('#thMsg').textContent = 'Testmelding verstuurd (sla eerst op als je de URL net hebt gewijzigd)';
      } catch (ex) { $('#thMsg').style.color = ''; $('#thMsg').textContent = ex.message; }
    };
  }

  try {
    await Promise.all([loadServers(), loadSettings()]);
    setConn(true);
  } catch (e) {
    setConn(false, e.message);
  }
}

route();
