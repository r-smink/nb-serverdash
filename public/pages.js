'use strict';
/* global $, $$, esc, api, fmt, main, view, prefs, savePrefs, setConn, dialog, lvlFor, TYPES, LEVEL_LABEL, LEVEL_RANK, C,
   drawChartSet, observeCharts, sparkSvg, me, isAdmin, boot, updateIncidentBadge */

// ---------- gedeelde stukjes ----------

const BACKUP_STATUS = { success: 'Geslaagd', warnings: 'Geslaagd met waarschuwingen', error: 'MISLUKT', unknown: 'Onbekend (geen sessielog)' };
const LVL_ORDER = (a, b) => (LEVEL_RANK[b] || 0) - (LEVEL_RANK[a] || 0);
const byName = (a, b) => a.name.localeCompare(b.name, 'nl', { numeric: true });

function forecastHtml(list) {
  const growing = (list || []).filter((f) => f.perDay != null && f.perDay > 0.05);
  if (!growing.length) return (list || []).some((f) => f.perDay != null) ? '<p class="note">📈 Schijven groeien niet merkbaar (7 dagen).</p>' : '';
  return growing.map((f) => `<p class="note ${f.days != null && f.days < 14 ? 'lvl-warn' : ''}">📈 <b>${esc(f.mount)}</b> groeit
    ${fmt.num(f.perDay, 2)}%/dag${f.bytesPerDay ? ` (${fmt.bytes(f.bytesPerDay)}/dag)` : ''} —
    ${f.days != null ? `vol over <b>${f.days < 1 ? '< 1 dag' : `${Math.round(f.days)} dagen`}</b>` : 'nog ruim een jaar'}</p>`).join('');
}

function segHtml(id, options, current) {
  return `<div class="seg" id="${id}">${options.map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(current) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

function onSeg(id, fn) {
  $(`#${id}`).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b));
    fn(b.dataset.v);
  };
}

function dotCell(level, text) {
  return `<span class="lvl-${level}" style="display:inline-flex;align-items:center;gap:8px"><span class="dot"></span>${text ?? ''}</span>`;
}

function barCell(value, max, cls = '') {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return `<span class="cellbar ${cls}"><i style="width:${w}%"></i></span>`;
}

// ---------- verbruik ----------

function renderUsage() {
  const nav = view.nav;
  const st = { range: prefs.usageRange || 604800, tab: prefs.usageTab || 'users', onlySubs: prefs.onlySubs !== false, data: null };
  main.innerHTML = `
    <div class="toolbar">
      <h2 style="margin-right:12px">Top-verbruikers</h2>
      ${segHtml('uRange', [[86400, '24u'], [604800, '7 dagen'], [2592000, '30 dagen']], st.range)}
      ${segHtml('uTab', [['users', 'Abonnementen'], ['domains', 'Domeinen'], ['servers', 'Servers']], st.tab)}
      <label class="check" id="subsWrap"><input type="checkbox" id="onlySubs" ${st.onlySubs ? 'checked' : ''}> Alleen klantabonnementen</label>
    </div>
    <p class="note">Gebruik dit om te zien welke abonnementen de meeste resources gebruiken: kandidaten voor een duurder pakket of een rustigere server.
      CPU wordt per systeemgebruiker (Plesk-abonnement) opgeteld uit de procesmetingen; requests komen uit de access-logs van alle domeinen.</p>
    <section class="panel" id="usagePanel" style="margin-top:8px"><p class="muted">Laden…</p></section>`;
  onSeg('uRange', (v) => { st.range = +v; prefs.usageRange = st.range; savePrefs(); load(); });
  onSeg('uTab', (v) => { st.tab = v; prefs.usageTab = v; savePrefs(); draw(); });
  $('#onlySubs').onchange = (e) => { st.onlySubs = e.target.checked; prefs.onlySubs = st.onlySubs; savePrefs(); draw(); };

  async function load() {
    try {
      const d = await api(`/usage?range=${st.range}`);
      if (nav !== view.nav) return;
      st.data = d;
      draw();
      setConn(true);
    } catch (e) { setConn(false, e.message); }
  }

  function draw() {
    const d = st.data;
    if (!d) return;
    $('#subsWrap').classList.toggle('hidden', st.tab !== 'users');
    const hours = d.range / 3600;
    if (st.tab === 'users') {
      const list = d.users.filter((u) => !st.onlySubs || u.domain).slice(0, 100);
      const max = Math.max(...list.map((u) => u.cores), 0.01);
      $('#usagePanel').innerHTML = `
        <div class="table-wrap" style="max-height:none"><table>
          <thead><tr><th>#</th><th>Abonnement / gebruiker</th><th>Hoofddomein</th><th>Server</th>
            <th class="num">CPU-uren</th><th class="num">Gem. cores</th><th class="num">Max. RAM</th><th class="num">Disk I/O</th></tr></thead>
          <tbody>${list.map((u, i) => `<tr>
            <td class="muted">${i + 1}</td><td><b>${esc(u.user)}</b></td>
            <td>${u.domain ? esc(u.domain) : '<span class="muted">systeem</span>'}</td>
            <td><a href="#/server/${u.server_id}">${esc(u.server)}</a></td>
            <td class="num">${fmt.num(u.cpu_s / 3600, 1)}</td>
            <td class="num">${barCell(u.cores, max)}${fmt.num(u.cores, 2)}</td>
            <td class="num">${fmt.bytes(u.rss)}</td><td class="num">${fmt.bytes(u.io)}</td></tr>`).join('')
            || '<tr><td colspan="8" class="muted">Nog geen verbruiksdata (wordt per uur opgebouwd uit de agentmetingen)</td></tr>'}</tbody>
        </table></div>
        <p class="note">Gem. cores = gemiddeld aantal volledig belaste CPU-cores over ${fmt.num(hours, 0)} uur. Eén klant met gemiddeld 1,0 core gebruikt dus continu een hele core.</p>`;
    } else if (st.tab === 'domains') {
      const list = d.domains.slice(0, 100);
      const max = Math.max(...list.map((x) => x.req), 1);
      $('#usagePanel').innerHTML = `
        <div class="table-wrap" style="max-height:none"><table>
          <thead><tr><th>#</th><th>Domein</th><th>Server</th><th class="num">Requests</th><th class="num">Gem./min</th>
            <th class="num">Bandbreedte</th><th class="num">5xx</th><th class="num">Login-aanvallen</th></tr></thead>
          <tbody>${list.map((x, i) => `<tr>
            <td class="muted">${i + 1}</td><td><b>${esc(x.domain)}</b></td><td><a href="#/server/${x.server_id}">${esc(x.server)}</a></td>
            <td class="num">${barCell(x.req, max)}${fmt.int(x.req)}</td><td class="num">${fmt.num(x.req / (d.range / 60), 1)}</td>
            <td class="num">${fmt.bytes(x.bytes)}</td>
            <td class="num ${x.req && x.s5 / x.req > 0.05 ? 'hot' : ''}">${x.req ? fmt.pct((x.s5 / x.req) * 100, 1) : '–'}</td>
            <td class="num ${x.wpl + x.xml > 1000 ? 'warm' : ''}">${fmt.int(x.wpl + x.xml)}</td></tr>`).join('')
            || '<tr><td colspan="8" class="muted">Nog geen requestdata (agent 1.2+ nodig)</td></tr>'}</tbody>
        </table></div>`;
    } else {
      const list = [...d.servers].filter((s) => s.cpu != null).sort((a, b) => b.cpu - a.cpu);
      const calm = [...list].filter((s) => s.type === 'plesk').sort((a, b) => a.cpu - b.cpu).slice(0, 3).map((s) => s.id);
      $('#usagePanel').innerHTML = `
        <div class="table-wrap" style="max-height:none"><table>
          <thead><tr><th>Server</th><th>Type</th><th class="num">Gem. CPU</th><th class="num">Piek CPU</th><th class="num">Gem. load</th><th class="num">Cores</th><th class="num">RAM nu</th><th></th></tr></thead>
          <tbody>${list.map((s) => `<tr>
            <td><a href="#/server/${s.id}"><b>${esc(s.name)}</b></a></td><td>${TYPES[s.type] || esc(s.type)}</td>
            <td class="num">${barCell(s.cpu, 100, s.cpu > 70 ? 'crit' : s.cpu > 50 ? 'warn' : '')}${fmt.pct(s.cpu, 1)}</td>
            <td class="num">${fmt.pct(s.cpu_max)}</td><td class="num">${fmt.num(s.load1)}</td><td class="num">${s.cores ?? '–'}</td>
            <td class="num">${fmt.pct(s.mem_pct)}</td>
            <td>${calm.includes(s.id) ? '<span class="badge ok">ruimte over</span>' : s.cpu > 70 ? '<span class="badge sec">vol</span>' : ''}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="note">"Ruimte over" = de drie rustigste Plesk-servers in deze periode: geschikte kandidaten om drukke abonnementen naartoe te verhuizen.</p>`;
    }
  }

  load();
}

// ---------- onderhoud ----------

function renderMaintenance() {
  const nav = view.nav;
  const st = { data: null, wpOnlyOutdated: prefs.wpOnlyOutdated !== false, wpSearch: '' };
  main.innerHTML = `
    <section class="panel" style="margin-top:0" id="bkPanel"><p class="muted">Laden…</p></section>
    <section class="panel" id="updPanel"></section>
    <section class="panel" id="fcPanel"></section>
    <section class="panel" id="wpPanel"></section>`;

  async function load() {
    try {
      const d = await api('/maintenance');
      if (nav !== view.nav) return;
      st.data = d;
      draw();
      setConn(true);
    } catch (e) { setConn(false, e.message); }
  }

  function draw() {
    const d = st.data;
    const th = d.thresholds;
    const now = Date.now() / 1000;
    const servers = [...d.servers].sort(byName);

    // Back-ups
    const bkLevel = (s) => {
      if (s.backupCfg?.enabled === false) return 'muted';
      const b = s.backups;
      if (!b) return 'pending';
      if (!b.last) return 'warn';
      const lim = (s.backupCfg?.maxAgeHours || th.backupAge.warn) * 3600;
      const age = now - b.last.ts;
      if (b.last.status === 'error' || age > (s.backupCfg?.maxAgeHours ? lim * 2 : th.backupAge.crit * 3600)) return 'crit';
      if (age > lim || b.last.status === 'warnings') return 'warn';
      return 'ok';
    };
    const bk = servers.map((s) => ({ ...s, bl: bkLevel(s) })).sort((a, b) => LVL_ORDER(a.bl, b.bl) || byName(a, b));
    const bkCounts = { crit: bk.filter((s) => s.bl === 'crit').length, warn: bk.filter((s) => s.bl === 'warn').length, ok: bk.filter((s) => s.bl === 'ok').length };
    $('#bkPanel').innerHTML = `
      <div class="panel-head"><h3>Back-ups</h3>
        <span class="chip crit ${bkCounts.crit ? 'has' : ''}">${bkCounts.crit} probleem</span>
        <span class="chip warn ${bkCounts.warn ? 'has' : ''}">${bkCounts.warn} waarschuwing</span>
        <span class="chip ok">${bkCounts.ok} OK</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Server</th><th>Laatste back-up</th><th>Leeftijd</th><th>Resultaat</th><th class="num">Grootte</th><th>Bron</th></tr></thead>
        <tbody>${bk.map((s) => {
          const b = s.backups;
          return `<tr><td>${dotCell(s.bl === 'muted' ? 'muted' : s.bl, `<a href="#/server/${s.id}"><b>${esc(s.name)}</b></a>`)}</td>
            ${s.bl === 'muted' ? '<td colspan="5" class="muted">Back-upbewaking uitgeschakeld</td>'
              : !b ? `<td colspan="5" class="muted">${s.agent ? 'Nog geen gegevens (agent 1.2+ nodig)' : 'Geen agent'}</td>`
              : !b.last ? '<td colspan="5" class="lvl-warn">Geen back-up gevonden</td>'
              : `<td>${fmt.time(b.last.ts)}</td><td class="lvl-${s.bl}">${fmt.dur(now - b.last.ts)}</td>
                 <td>${BACKUP_STATUS[b.last.status] || esc(b.last.status)}</td><td class="num">${b.last.size ? fmt.bytes(b.last.size) : '–'}</td>
                 <td class="muted">${b.last.source === 'paths' ? 'eigen map' : 'Plesk'}</td>`}</tr>`;
        }).join('')}</tbody>
      </table></div>`;

    // Updates & versies
    const upd = [...servers].sort((a, b) => (b.updates?.security || 0) - (a.updates?.security || 0) || byName(a, b));
    $('#updPanel').innerHTML = `
      <div class="panel-head"><h3>Updates &amp; versies</h3>${d.newestPlesk ? `<span class="muted">nieuwste Plesk in je vloot: ${esc(d.newestPlesk)}</span>` : ''}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Server</th><th>Besturingssysteem</th><th>Kernel</th><th>Plesk</th><th class="num">Security</th><th class="num">Totaal</th><th>Herstart</th><th>Agent</th></tr></thead>
        <tbody>${upd.map((s) => `<tr>
          <td><a href="#/server/${s.id}"><b>${esc(s.name)}</b></a></td><td>${esc(s.os || '–')}</td><td class="muted">${esc(s.kernel || '–')}</td>
          <td class="${s.pleskBehind ? 'warm' : ''}">${esc(s.plesk || '–')}${s.pleskBehind ? ' ↓' : ''}</td>
          <td class="num ${s.updates?.security ? 'hot' : ''}">${s.updates ? s.updates.security : '–'}</td>
          <td class="num">${s.updates ? s.updates.total : '–'}</td>
          <td>${s.reboot ? '<span class="badge sec">nodig</span>' : ''}</td>
          <td class="muted">${esc(s.agent || '–')}</td></tr>`).join('')}</tbody>
      </table></div>`;

    // Schijfvoorspelling
    const fc = [];
    for (const s of servers) for (const f of s.forecast || []) fc.push({ ...f, server: s.name, id: s.id });
    const growing = fc.filter((f) => f.perDay != null && f.perDay > 0.05).sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9));
    $('#fcPanel').innerHTML = `
      <div class="panel-head"><h3>Schijfvoorspelling</h3><span class="muted">lineaire trend over 7 dagen · ${fc.length - growing.length} schijven stabiel</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Server</th><th>Mount</th><th class="num">Nu</th><th class="num">Groei/dag</th><th class="num">Vol over</th></tr></thead>
        <tbody>${growing.map((f) => {
          const cls = f.days != null && f.days <= th.diskDays.crit ? 'hot' : f.days != null && f.days <= th.diskDays.warn ? 'warm' : '';
          return `<tr><td><a href="#/server/${f.id}"><b>${esc(f.server)}</b></a></td><td>${esc(f.mount)}</td>
            <td class="num">${barCell(f.current, 100, lvlFor(f.current, th.disk))}${fmt.pct(f.current, 1)}</td>
            <td class="num">${fmt.num(f.perDay, 2)}%${f.bytesPerDay ? ` <span class="muted">(${fmt.bytes(f.bytesPerDay)})</span>` : ''}</td>
            <td class="num ${cls}">${f.days != null ? (f.days < 1 ? '< 1 dag' : `${Math.round(f.days)} dagen`) : '> 2 jaar'}</td></tr>`;
        }).join('') || '<tr><td colspan="5" class="muted">Geen enkele schijf groeit merkbaar.</td></tr>'}</tbody>
      </table></div>`;

    drawWp();
  }

  function drawWp() {
    const wp = st.data.wordpress;
    const q = st.wpSearch.toLowerCase();
    const sites = wp.sites
      .filter((s) => !st.wpOnlyOutdated || s.coreOutdated || s.outdatedPlugins.length || s.outdatedThemes.length)
      .filter((s) => !q || `${s.domain} ${s.server}`.toLowerCase().includes(q))
      .sort((a, b) => (b.coreOutdated - a.coreOutdated) || (b.outdatedPlugins.length - a.outdatedPlugins.length) || a.domain.localeCompare(b.domain));
    const outdatedCore = wp.sites.filter((s) => s.coreOutdated).length;
    const withPlugins = wp.sites.filter((s) => s.outdatedPlugins.length).length;
    const totalPlugins = wp.sites.reduce((a, s) => a + s.outdatedPlugins.length, 0);
    $('#wpPanel').innerHTML = `
      <div class="panel-head"><h3>WordPress</h3>
        <span class="chip">${wp.sites.length} installaties</span>
        <span class="chip crit ${outdatedCore ? 'has' : ''}">${outdatedCore} verouderde core${wp.core ? ` (nieuwste ${esc(wp.core)})` : ''}</span>
        <span class="chip warn ${withPlugins ? 'has' : ''}">${totalPlugins} plugin-updates op ${withPlugins} sites</span>
        <div class="right">
          <input id="wpSearch" type="search" placeholder="Zoek domein…" value="${esc(st.wpSearch)}" style="width:200px">
          <label class="check"><input type="checkbox" id="wpOnly" ${st.wpOnlyOutdated ? 'checked' : ''}> Alleen met updates</label>
        </div>
      </div>
      <p class="note">De agent leest versienummers uit de bestanden (zonder PHP uit te voeren); het dashboard vergelijkt ze met wordpress.org.
        Premium-plugins die niet op wordpress.org staan, kunnen niet gecontroleerd worden.</p>
      <div class="table-wrap" style="max-height:640px"><table>
        <thead><tr><th>Domein</th><th>Server</th><th>WordPress</th><th class="num">Plugins</th><th>Verouderde plugins &amp; thema's</th></tr></thead>
        <tbody>${sites.slice(0, 300).map((s) => `<tr>
          <td><b>${esc(s.domain)}</b><div class="muted mono" style="font-size:11px">${esc(s.path)}</div></td>
          <td><a href="#/server/${s.server_id}">${esc(s.server)}</a></td>
          <td class="${s.coreOutdated ? 'hot' : ''}">${esc(s.version || '?')}${s.coreOutdated ? ` → ${esc(wp.core)}` : ''}</td>
          <td class="num">${s.plugins}</td>
          <td style="white-space:normal">${[...s.outdatedPlugins, ...s.outdatedThemes.map((t) => ({ ...t, theme: true }))]
            .map((p) => `<span class="badge ${p.theme ? '' : 'sec'}" title="${p.theme ? 'thema' : 'plugin'}">${esc(p.slug)} ${esc(p.version || '?')} → ${esc(p.latest)}</span>`).join(' ')
            || '<span class="muted">alles actueel</span>'}</td></tr>`).join('')
          || `<tr><td colspan="5" class="muted">${wp.sites.length ? 'Geen sites met updates 🎉' : 'Nog geen WordPress-scan ontvangen (agent 1.2+, elke 6 uur)'}</td></tr>`}</tbody>
      </table></div>`;
    $('#wpSearch').oninput = (e) => { st.wpSearch = e.target.value; drawWp(); $('#wpSearch').focus(); $('#wpSearch').setSelectionRange(99, 99); };
    $('#wpOnly').onchange = (e) => { st.wpOnlyOutdated = e.target.checked; prefs.wpOnlyOutdated = st.wpOnlyOutdated; savePrefs(); drawWp(); };
  }

  load();
  view.timers.push(setInterval(load, 60_000));
}

// ---------- beveiliging ----------

function renderSecurity() {
  const nav = view.nav;
  const st = { range: prefs.secRange || 86400 };
  main.innerHTML = `
    <div class="toolbar"><h2 style="margin-right:12px">Beveiliging</h2>${segHtml('sRange', [[86400, '24u'], [604800, '7 dagen']], st.range)}</div>
    <div class="charts" id="charts" style="grid-template-columns:1fr">
      <div class="chart" id="c-attacks"><h4>Aanvallen en geblokkeerde verzoeken per uur — alle servers, 7 dagen<span></span></h4><div class="plot"></div></div>
    </div>
    <section class="panel" id="secServers"><p class="muted">Laden…</p></section>
    <div class="cols">
      <section class="panel" id="secAttacked"></section>
      <section class="panel">
        <h3>Wat kun je doen?</h3>
        <ul class="tips">
          <li><b>xmlrpc.php</b> wordt vrijwel alleen door bots gebruikt. Blokkeer het per site in WP Toolkit (Beveiliging → "Toegang tot xmlrpc.php blokkeren").</li>
          <li><b>wp-login.php</b>-aanvallen: zet de Fail2ban-jail <code>plesk-wordpress</code> aan en overweeg 2FA of een andere inlog-URL.</li>
          <li><b>SSH</b>: sta wachtwoordlogin niet toe (<code>PasswordAuthentication no</code>) en beperk SSH tot vaste IP's in de Plesk-firewall.</li>
          <li><b>ModSecurity</b>-blokkades die oplopen bij één site kunnen ook op een fout-positieve regel wijzen; controleer het Plesk-log.</li>
        </ul>
      </section>
    </div>`;
  onSeg('sRange', (v) => { st.range = +v; prefs.secRange = st.range; savePrefs(); load(); });
  observeCharts($('#charts'));

  async function load() {
    try {
      const d = await api(`/security?range=${st.range}`);
      if (nav !== view.nav) return;
      draw(d);
      setConn(true);
    } catch (e) { setConn(false, e.message); }
  }

  function draw(d) {
    const def = { key: 'attacks', y: 'int', src: 'sec', series: [['wpl', 'wp-login.php', C.orange, true], ['xml', 'xmlrpc.php', C.red, true], ['ssh_fail', 'SSH mislukt', C.purple], ['modsec', 'ModSecurity', C.blue]] };
    drawChartSet([def], { bucket: 3600, sec: d.series }, (x) => x.series, (x, m, series) => [m.sec.ts, ...series.map(([k]) => m.sec[k])], { syncKey: 'sec' });
    const rangeLabel = st.range > 86400 ? '7 dagen' : '24 uur';
    const rows = [...d.servers].sort((a, b) => {
      const t = (s) => (s.totals ? s.totals.wpl + s.totals.xml + s.totals.ssh_fail : 0);
      return t(b) - t(a) || byName(a, b);
    });
    $('#secServers').innerHTML = `
      <h3>Per server — ${rangeLabel}</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Server</th><th class="num">Fail2ban nu geblokkeerd</th><th>Jails</th><th class="num">SSH mislukt</th>
          <th class="num">wp-login POST</th><th class="num">xmlrpc POST</th><th class="num">ModSecurity</th></tr></thead>
        <tbody>${rows.map((s) => `<tr>
          <td><a href="#/server/${s.id}"><b>${esc(s.name)}</b></a></td>
          <td class="num ${s.f2b?.banned > 50 ? 'warm' : ''}">${s.f2b ? s.f2b.banned : '–'}</td>
          <td class="muted" style="white-space:normal">${(s.f2b?.jails || []).filter((j) => j.banned).map((j) => `${esc(j.name)} (${j.banned})`).join(', ')}</td>
          <td class="num">${s.totals ? fmt.int(s.totals.ssh_fail) : '–'}</td>
          <td class="num ${s.totals?.wpl > 1000 ? 'warm' : ''}">${s.totals ? fmt.int(s.totals.wpl) : '–'}</td>
          <td class="num ${s.totals?.xml > 1000 ? 'warm' : ''}">${s.totals ? fmt.int(s.totals.xml) : '–'}</td>
          <td class="num">${s.totals ? fmt.int(s.totals.modsec) : '–'}</td></tr>`).join('')}</tbody>
      </table></div>`;
    const max = Math.max(1, ...d.attacked.map((a) => a.wpl + a.xml));
    $('#secAttacked').innerHTML = `
      <h3>Meest aangevallen sites — ${rangeLabel}</h3>
      <table><thead><tr><th>Domein</th><th>Server</th><th class="num">wp-login</th><th class="num">xmlrpc</th></tr></thead>
        <tbody>${d.attacked.map((a) => `<tr><td><b>${esc(a.domain)}</b></td><td><a href="#/server/${a.server_id}">${esc(a.server)}</a></td>
          <td class="num">${barCell(a.wpl + a.xml, max)}${fmt.int(a.wpl)}</td><td class="num">${fmt.int(a.xml)}</td></tr>`).join('')
          || '<tr><td colspan="4" class="muted">Geen aanvallen geregistreerd</td></tr>'}</tbody></table>`;
  }

  load();
  view.timers.push(setInterval(load, 60_000));
}

// ---------- incidenten ----------

function renderIncidents() {
  const nav = view.nav;
  const st = { filter: prefs.incFilter || 'open', range: 30 * 86400 };
  main.innerHTML = `
    <div class="toolbar">
      <h2 style="margin-right:12px">Incidenten</h2>
      ${segHtml('iFilter', [['open', 'Open'], ['30', '30 dagen'], ['90', '90 dagen']], st.filter)}
      <span class="hint">Een incident opent automatisch zodra een server of website een waarschuwing of kritieke status krijgt, en sluit bij herstel.
        Bevestigen stopt de herhaalmeldingen.</span>
    </div>
    <section class="panel" id="incPanel" style="margin-top:0"><p class="muted">Laden…</p></section>`;
  onSeg('iFilter', (v) => { st.filter = v; prefs.incFilter = v; savePrefs(); load(); });

  async function load() {
    try {
      const q = st.filter === 'open' ? 'open=1' : `range=${+st.filter * 86400}`;
      const d = await api(`/incidents?${q}`);
      if (nav !== view.nav) return;
      draw(d.incidents);
      setConn(true);
    } catch (e) { setConn(false, e.message); }
  }

  function draw(list) {
    const now = Date.now() / 1000;
    $('#incPanel').innerHTML = `<div class="table-wrap" style="max-height:none"><table class="clickable">
      <thead><tr><th>Status</th><th>Onderwerp</th><th>Server</th><th>Probleem</th><th>Begonnen</th><th class="num">Duur</th><th>Bevestigd</th><th>Oorzaak</th><th class="num">📝</th></tr></thead>
      <tbody>${list.map((i) => `<tr data-id="${i.id}">
        <td>${i.ended ? '<span class="muted">✓ opgelost</span>' : dotCell(i.level, i.level === 'crit' ? 'Kritiek' : 'Waarschuwing')}</td>
        <td><b>${esc(i.title)}</b></td><td>${esc(i.server || '')}</td>
        <td class="cmd" style="font-family:inherit;max-width:380px" title="${esc(i.summary)}">${esc(i.summary)}</td>
        <td>${fmt.time(i.started)}</td><td class="num">${fmt.dur((i.ended || now) - i.started)}</td>
        <td>${i.ack_ts ? `✓ ${esc(i.ack_user)}` : i.ended ? '' : '<span class="lvl-warn">nee</span>'}</td>
        <td class="cmd" style="font-family:inherit;max-width:240px">${esc(i.cause)}</td>
        <td class="num">${i.notes || ''}</td></tr>`).join('')
        || `<tr><td colspan="9" class="muted">${st.filter === 'open' ? 'Geen openstaande incidenten 🎉' : 'Geen incidenten in deze periode'}</td></tr>`}</tbody>
    </table></div>`;
    $('#incPanel tbody').onclick = (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) location.hash = `#/incidenten/${tr.dataset.id}`;
    };
  }

  load();
  view.timers.push(setInterval(load, 30_000));
  const m = location.hash.match(/^#\/incidenten\/(\d+)/);
  if (m) incidentDialog(+m[1]).then(() => { load(); updateIncidentBadge(); });
}

async function incidentDialog(id) {
  let data;
  try { data = await api(`/incidents/${id}`); } catch (e) { alert(e.message); return; }
  return new Promise((resolve) => {
    const d = dialog('<div class="form" id="incBody"></div>');
    d.style.width = 'min(820px, 96vw)';
    d.addEventListener('close', () => {
      if (location.hash.startsWith('#/incidenten/')) history.replaceState(null, '', '#/incidenten');
      resolve();
    });

    const draw = () => {
      const { incident: i, notes, events } = data;
      const link = i.kind === 'site' ? `#/website/${i.entity_id}` : `#/server/${i.entity_id}`;
      $('#incBody', d).innerHTML = `
        <div class="dhead lvl-${i.ended ? 'ok' : i.level}"><span class="dot"></span><h3>${esc(i.title)}</h3>
          <span class="lvl-label">${i.ended ? 'Opgelost' : i.level === 'crit' ? 'Kritiek' : 'Waarschuwing'}</span>
          <a class="btn ghost small" style="margin-left:auto" href="${link}">Bekijken →</a></div>
        <dl class="kv">
          <dt>Probleem</dt><dd>${esc(i.summary)}</dd>
          <dt>Begonnen</dt><dd>${fmt.time(i.started)}</dd>
          <dt>${i.ended ? 'Opgelost' : 'Duurt nu'}</dt><dd>${i.ended ? `${fmt.time(i.ended)} (na ${fmt.dur(i.ended - i.started)})` : fmt.dur(Date.now() / 1000 - i.started)}</dd>
          <dt>Bevestigd</dt><dd>${i.ack_ts ? `${esc(i.ack_user)} om ${fmt.time(i.ack_ts)}` : 'nee'}</dd>
        </dl>
        <label>Oorzaak / oplossing<textarea id="cause" rows="2" ${isAdmin() ? '' : 'disabled'} placeholder="Bijv. backup-script liep vast; cron aangepast">${esc(i.cause)}</textarea></label>
        <div>
          <h3>Notities</h3>
          <ul class="events compact">${notes.map((n) => `<li><span class="t">${fmt.time(n.ts)}</span><span><b>${esc(n.user)}</b>: ${esc(n.text)}</span></li>`).join('') || '<li class="muted">Nog geen notities</li>'}</ul>
          ${isAdmin() ? '<div style="display:flex;gap:8px;margin-top:8px"><input id="noteText" placeholder="Notitie toevoegen…"><button class="btn small" id="addNote">Toevoegen</button></div>' : ''}
        </div>
        <div>
          <h3>Tijdlijn</h3>
          <ul class="events compact">${events.map((e) => `<li><span class="t">${fmt.time(e.ts)}</span><span class="lvl-${e.level}">${esc(e.message)}</span></li>`).join('') || '<li class="muted">Geen meldingen</li>'}</ul>
        </div>
        <div class="form-error" id="incErr"></div>
        <div class="actions">
          ${isAdmin() && !i.ended && !i.ack_ts ? '<button class="btn ghost" id="ack">Bevestigen (herinneringen stoppen)</button>' : ''}
          ${isAdmin() && !i.ended ? '<button class="btn ghost" id="closeInc">Handmatig afsluiten</button>' : ''}
          ${isAdmin() ? '<button class="btn ghost" id="saveCause">Oorzaak opslaan</button>' : ''}
          <button class="btn" id="done">Sluiten</button>
        </div>`;
      const act = async (fn) => {
        try { await fn(); data = await api(`/incidents/${id}`); draw(); } catch (e) { $('#incErr', d).textContent = e.message; }
      };
      $('#done', d).onclick = () => d.close();
      if ($('#ack', d)) $('#ack', d).onclick = () => act(() => api(`/incidents/${id}/ack`, { method: 'POST', body: {} }));
      if ($('#closeInc', d)) $('#closeInc', d).onclick = () => act(() => api(`/incidents/${id}/close`, { method: 'POST', body: {} }));
      if ($('#saveCause', d)) $('#saveCause', d).onclick = () => act(() => api(`/incidents/${id}`, { method: 'PUT', body: { cause: $('#cause', d).value } }));
      if ($('#addNote', d)) {
        const add = () => act(async () => {
          const text = $('#noteText', d).value.trim();
          if (text) await api(`/incidents/${id}/notes`, { method: 'POST', body: { text } });
        });
        $('#addNote', d).onclick = add;
        $('#noteText', d).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
      }
    };
    draw();
  });
}

// ---------- account ----------

async function renderAccount() {
  const nav = view.nav;
  const u = (await api('/me')).user;
  if (nav !== view.nav) return;
  main.innerHTML = `
    <div class="cols" style="align-items:start">
      <section class="panel" style="margin-top:0">
        <h3>Mijn account</h3>
        <dl class="kv"><dt>Gebruiker</dt><dd>${esc(u.username)}</dd><dt>Rol</dt><dd>${u.role === 'admin' ? 'Beheerder' : 'Alleen lezen'}</dd>
          <dt>Vorige login</dt><dd>${u.last_login ? fmt.time(u.last_login) : '–'}</dd></dl>
        <h3 style="margin-top:20px">Wachtwoord wijzigen</h3>
        <form class="form" id="pwForm">
          <label>Huidig wachtwoord<input type="password" name="current" required autocomplete="current-password"></label>
          <label>Nieuw wachtwoord (min. 10 tekens)<input type="password" name="password" required minlength="10" autocomplete="new-password"></label>
          <div class="form-error" id="pwErr"></div>
          <div class="actions"><button class="btn">Wijzigen</button></div>
        </form>
      </section>
      <section class="panel" style="margin-top:0" id="tfaPanel"></section>
    </div>`;

  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/account/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      alert('Wachtwoord gewijzigd. Log opnieuw in.');
      location.href = '/login.html';
    } catch (ex) { $('#pwErr').textContent = ex.message; }
  };

  const tfa = $('#tfaPanel');
  if (u.totp) {
    tfa.innerHTML = `
      <h3>Tweestapsverificatie</h3>
      <p>✅ 2FA staat aan. Bij het inloggen vraagt het dashboard om een code uit je authenticator-app.</p>
      <form class="form" id="tfaOff">
        <label>Wachtwoord om 2FA uit te zetten<input type="password" name="password" required></label>
        <div class="form-error" id="tfaErr"></div>
        <div class="actions"><button class="btn danger">2FA uitschakelen</button></div>
      </form>`;
    $('#tfaOff').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/account/2fa/disable', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        location.href = '/login.html';
      } catch (ex) { $('#tfaErr').textContent = ex.message; }
    };
  } else {
    tfa.innerHTML = `
      <h3>Tweestapsverificatie</h3>
      <p class="note">Beveilig je account met een code uit een authenticator-app (Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden…).</p>
      <button class="btn" id="tfaStart">2FA instellen</button>
      <div id="tfaSetup"></div>`;
    $('#tfaStart').onclick = async () => {
      const s = await api('/account/2fa/setup', { method: 'POST', body: {} });
      $('#tfaStart').remove();
      $('#tfaSetup').innerHTML = `
        <ol class="note"><li>Scan de QR-code met je authenticator-app.</li><li>Vul de code van 6 cijfers in.</li></ol>
        <div class="qr">${s.qr}</div>
        <p class="note">Kun je niet scannen? Voer deze sleutel handmatig in: <code class="mono">${esc(s.secret.match(/.{1,4}/g).join(' '))}</code></p>
        <form class="form" id="tfaOn">
          <label>Code uit de app<input name="code" inputmode="numeric" required pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code"></label>
          <div class="form-error" id="tfaErr"></div>
          <div class="actions"><button class="btn">Activeren</button></div>
        </form>`;
      $('#tfaOn').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/account/2fa/enable', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
          alert('2FA is geactiveerd. Log opnieuw in met je code.');
          location.href = '/login.html';
        } catch (ex) { $('#tfaErr').textContent = ex.message; }
      };
    };
  }
}

// ---------- tv-modus ----------

function renderTv() {
  const nav = view.nav;
  main.innerHTML = `
    <div class="tv-wrap">
      <div class="tv-head">
        <div class="brand"><span class="logo"></span>NextBuzz ServerDash</div>
        <div class="summary" id="tvSummary"></div>
        <div class="tv-clock" id="tvClock"></div>
        <a href="#/" class="btn ghost small" title="Sluiten (Esc)">✕</a>
      </div>
      <div id="tvProblems"></div>
      <div class="tv-grid" id="tvGrid"></div>
    </div>`;
  const clock = () => { const el = $('#tvClock'); if (el) el.textContent = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }); };
  clock();
  view.timers.push(setInterval(clock, 1000));
  const esc_ = (e) => { if (e.key === 'Escape') location.hash = '#/'; };
  document.addEventListener('keydown', esc_);
  view.cleanup.push(() => document.removeEventListener('keydown', esc_));

  async function load() {
    try {
      const d = await api('/tv');
      if (nav !== view.nav) return;
      draw(d);
    } catch { /* volgende poging */ }
  }

  function draw(d) {
    const servers = d.servers;
    const probS = servers.filter((s) => s.status.level === 'crit' || s.status.level === 'warn')
      .sort((a, b) => LVL_ORDER(a.status.level, b.status.level) || byName(a, b));
    const probW = d.websites.filter((w) => w.status.level === 'crit' || w.status.level === 'warn')
      .sort((a, b) => LVL_ORDER(a.status.level, b.status.level));
    const crit = probS.filter((s) => s.status.level === 'crit').length + probW.filter((w) => w.status.level === 'crit').length;
    const warn = probS.length + probW.length - crit;
    $('#tvSummary').innerHTML = `
      <span class="chip">${servers.length} servers · ${d.websites.length} websites</span>
      <span class="chip crit ${crit ? 'has' : ''}">${crit} kritiek</span>
      <span class="chip warn ${warn ? 'has' : ''}">${warn} waarschuwing</span>
      ${d.incidents ? `<span class="chip">${d.incidents} open incident${d.incidents === 1 ? '' : 'en'}</span>` : ''}`;
    document.title = crit ? `(${crit}) ServerDash TV` : 'ServerDash TV';

    $('#tvProblems').innerHTML = probS.length || probW.length ? `
      <div class="tv-problems">
        ${probS.map((s) => `<a class="tv-card lvl-${s.status.level}" href="#/server/${s.id}">
          <div class="tv-card-head"><span class="dot"></span>${esc(s.name)}<span class="badge">${TYPES[s.type] || ''}</span></div>
          <ul class="issues">${s.status.issues.filter((i) => i.level === 'crit' || i.level === 'warn').slice(0, 4).map((i) => `<li class="${i.level}">${esc(i.msg)}</li>`).join('')}</ul>
          ${s.summary && !s.status.offline ? `<div class="tv-mini">CPU ${fmt.pct(s.summary.cpu)} · RAM ${fmt.pct(s.summary.mem_pct)} · Disk ${fmt.pct(s.summary.disk?.pct)}</div>` : ''}
        </a>`).join('')}
        ${probW.map((w) => `<a class="tv-card lvl-${w.status.level}" href="#/website/${w.id}">
          <div class="tv-card-head"><span class="dot"></span>${esc(w.domain)}<span class="badge">${esc(w.server?.name || '')}</span></div>
          <ul class="issues">${w.status.issues.filter((i) => i.level === 'crit' || i.level === 'warn').slice(0, 3).map((i) => `<li class="${i.level}">${esc(i.msg)}</li>`).join('')}</ul>
        </a>`).join('')}
      </div>` : '<div class="tv-allgood">✓ Alles in orde</div>';

    $('#tvGrid').innerHTML = [...servers].sort(byName).map((s) => {
      const m = s.summary;
      return `<a class="tv-mini-tile lvl-${s.status.level}" href="#/server/${s.id}">
        <div class="tv-mini-name"><span class="dot"></span>${esc(s.name)}</div>
        ${m && !s.status.offline ? `<div class="tv-bars">
          <span title="CPU"><i style="width:${Math.min(100, m.cpu || 0)}%" class="${lvlFor(m.cpu, d.thresholds.cpu)}"></i></span>
          <span title="RAM"><i style="width:${Math.min(100, m.mem_pct || 0)}%" class="${lvlFor(m.mem_pct, d.thresholds.mem)}"></i></span>
          <span title="Disk"><i style="width:${Math.min(100, m.disk?.pct || 0)}%" class="${lvlFor(m.disk?.pct, d.thresholds.disk)}"></i></span>
        </div><div class="tv-mini-val">${fmt.pct(m.cpu)} CPU</div>` : `<div class="tv-mini-val">${s.status.offline ? 'offline' : '–'}</div>`}
      </a>`;
    }).join('');
  }

  load();
  view.timers.push(setInterval(load, 15_000));
}

// ---------- websites ontdekken ----------

async function discoverDialog() {
  const data = await api('/websites/discover');
  return new Promise((resolve) => {
    const total = data.servers.reduce((a, s) => a + s.domains.filter((x) => !x.monitored).length, 0);
    const d = dialog(`
      <form class="form" method="dialog">
        <h3>Websites ontdekken</h3>
        <p class="note">De agents (versie 1.2+) melden elk uur welke domeinen er in Plesk staan. Vink aan wat je wilt bewaken.
          ${data.autoSites.enabled ? '<br><b>Automatisch toevoegen staat aan</b>: nieuwe domeinen komen er vanzelf bij.' : 'Je kunt nieuwe domeinen ook automatisch laten toevoegen onder Beheer → Algemeen.'}</p>
        <div style="display:flex;gap:10px;align-items:center">
          <input id="dSearch" type="search" placeholder="Zoek domein…">
          <button type="button" class="btn ghost small" id="dAll">Alles selecteren</button>
          <button type="button" class="btn ghost small" id="dNone">Niets</button>
        </div>
        <div class="discover">${data.servers.map((s) => `
          <div class="disc-server">
            <div class="disc-head"><b>${esc(s.name)}</b> <span class="muted">${s.domains.length} domeinen${s.checked ? ` · ${fmt.ago(s.checked)}` : ' · nog geen gegevens'}</span></div>
            ${s.domains.map((x) => `<label class="check disc-item ${x.monitored ? 'muted' : ''}" data-d="${esc(x.domain)}">
              <input type="checkbox" data-server="${s.id}" value="${esc(x.domain)}" ${x.monitored ? 'checked disabled' : ''}> ${esc(x.domain)}${x.monitored ? ' <span class="badge">bewaakt</span>' : ''}</label>`).join('')}
          </div>`).join('') || '<p class="muted">Nog geen domeinen ontvangen.</p>'}</div>
        <label class="check"><input type="checkbox" id="dCheck" checked> Bereikbaarheid elke minuut controleren</label>
        <div class="form-error"></div>
        <div class="actions">
          <span class="muted" id="dCount" style="margin-right:auto">${total} nog niet bewaakt</span>
          <button class="btn ghost" value="cancel" formnovalidate>Annuleren</button>
          <button class="btn" value="ok">Geselecteerde toevoegen</button>
        </div>
      </form>`);
    d.style.width = 'min(760px, 96vw)';
    const boxes = () => $$('input[data-server]:not([disabled])', d).filter((b) => !b.closest('.disc-item').classList.contains('hidden'));
    $('#dSearch', d).oninput = (e) => {
      const q = e.target.value.toLowerCase();
      $$('.disc-item', d).forEach((el) => el.classList.toggle('hidden', !!q && !el.dataset.d.includes(q)));
    };
    $('#dAll', d).onclick = () => boxes().forEach((b) => { b.checked = true; });
    $('#dNone', d).onclick = () => boxes().forEach((b) => { b.checked = false; });
    $('form', d).addEventListener('submit', async (e) => {
      if (e.submitter?.value === 'cancel') return resolve(false);
      e.preventDefault();
      const items = $$('input[data-server]:checked:not([disabled])', d).map((b) => ({ server_id: +b.dataset.server, domain: b.value }));
      if (!items.length) { $('.form-error', d).textContent = 'Niets geselecteerd'; return; }
      try {
        const r = await api('/websites/bulk', { method: 'POST', body: { items, check_enabled: $('#dCheck', d).checked } });
        d.close();
        resolve(r.added > 0);
      } catch (ex) { $('.form-error', d).textContent = ex.message; }
    });
    d.addEventListener('cancel', () => resolve(false));
  });
}

// ---------- beheer: meldingen, algemeen, gebruikers ----------

const CHANNEL_DEFS = [
  ['webhook', 'Webhook', 'Slack, Mattermost, Discord of een Teams-workflow', [['url', 'URL', 'https://hooks.slack.com/services/…']]],
  ['email', 'E-mail (SMTP)', 'Via je eigen mailserver of bijv. Postmark/Mailgun', [
    ['host', 'SMTP-server', 'smtp.nextbuzz.nl'], ['port', 'Poort', '587', 'number'], ['secure', 'SSL/TLS direct (poort 465)', '', 'checkbox'],
    ['user', 'Gebruikersnaam', ''], ['pass', 'Wachtwoord', '', 'password'], ['from', 'Afzender', 'monitor@nextbuzz.nl'], ['to', 'Ontvangers (komma-gescheiden)', 'beheer@nextbuzz.nl']]],
  ['pushover', 'Pushover', 'Pushmeldingen op je telefoon (eenmalig ± €5)', [['token', 'App-token', '', 'password'], ['user', 'User/group key', '', 'password']]],
  ['ntfy', 'ntfy', 'Gratis pushmeldingen via de ntfy-app; kies een onraadbare topic-naam', [['url', 'Topic-URL', 'https://ntfy.sh/nextbuzz-alerts-x7k2'], ['token', 'Access token (optioneel)', '', 'password']]],
  ['twilio', 'SMS (Twilio)', 'SMS naar één of meer nummers', [['sid', 'Account SID', 'AC…'], ['token', 'Auth token', '', 'password'], ['from', 'Afzendernummer', '+31…'], ['to', 'Ontvangers (komma-gescheiden)', '+316…']]],
];

function drawNotifySettings(el, s) {
  const n = s.notify;
  el.innerHTML = `
    <h3>Meldingen</h3>
    <form class="form" id="nForm">
      <div class="row">
        <label>Herinnering sturen zolang een probleem niet bevestigd is, elke … minuten (0 = uit)
          <input type="number" min="0" max="1440" name="repeatMinutes" value="${n.repeatMinutes}"></label>
        <p class="note" style="align-self:end">Herstelmeldingen gaan naar de kanalen die het probleem ook kregen. Bevestig een incident op de pagina Incidenten om herinneringen te stoppen.</p>
      </div>
      <div class="channels">${CHANNEL_DEFS.map(([key, title, hint, fields]) => `
        <fieldset class="channel ${n[key].enabled ? 'on' : ''}" data-ch="${key}">
          <legend><label class="check"><input type="checkbox" name="${key}.enabled" ${n[key].enabled ? 'checked' : ''}> <b>${title}</b></label></legend>
          <p class="note">${hint}</p>
          ${fields.map(([f, label, ph, type]) => type === 'checkbox'
            ? `<label class="check"><input type="checkbox" name="${key}.${f}" ${n[key][f] ? 'checked' : ''}> ${label}</label>`
            : `<label>${label}<input name="${key}.${f}" type="${type || 'text'}" value="${esc(n[key][f])}" placeholder="${esc(ph)}" autocomplete="off"></label>`).join('')}
          <div class="row">
            <label>Vanaf niveau<select name="${key}.minLevel">
              <option value="warn" ${n[key].minLevel === 'warn' ? 'selected' : ''}>Waarschuwing + kritiek</option>
              <option value="crit" ${n[key].minLevel === 'crit' ? 'selected' : ''}>Alleen kritiek</option></select></label>
            <button type="button" class="btn ghost small" data-test="${key}" style="align-self:end">Test versturen</button>
          </div>
        </fieldset>`).join('')}
      </div>
      <div class="form-error" id="nMsg"></div>
      <div class="actions"><button class="btn">Meldingen opslaan</button></div>
    </form>`;
  const form = $('#nForm');
  const collect = () => {
    const fd = new FormData(form);
    const out = { repeatMinutes: +fd.get('repeatMinutes') };
    for (const [key, , , fields] of CHANNEL_DEFS) {
      out[key] = { enabled: fd.get(`${key}.enabled`) === 'on', minLevel: fd.get(`${key}.minLevel`) };
      for (const [f, , , type] of fields) out[key][f] = type === 'checkbox' ? fd.get(`${key}.${f}`) === 'on' : fd.get(`${key}.${f}`);
    }
    return out;
  };
  const msg = (text, ok) => { $('#nMsg').style.color = ok ? '#86efac' : ''; $('#nMsg').textContent = text; };
  form.onchange = (e) => {
    if (e.target.name?.endsWith('.enabled')) e.target.closest('fieldset').classList.toggle('on', e.target.checked);
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/settings', { method: 'PUT', body: { notify: collect() } }); msg('Opgeslagen ✓', true); } catch (ex) { msg(ex.message); }
  };
  form.onclick = async (e) => {
    const b = e.target.closest('button[data-test]');
    if (!b) return;
    try {
      await api('/settings', { method: 'PUT', body: { notify: collect() } });
      b.textContent = 'Bezig…';
      await api('/settings/test-notify', { method: 'POST', body: { channel: b.dataset.test } });
      msg(`Testmelding via ${b.dataset.test} verstuurd ✓`, true);
    } catch (ex) { msg(ex.message); } finally { b.textContent = 'Test versturen'; }
  };
}

function drawGeneralSettings(el, s) {
  const health = `${s.publicUrl || location.origin}/api/health`;
  el.innerHTML = `
    <h3>Algemeen</h3>
    <form class="form" id="gForm">
      <label class="check"><input type="checkbox" name="autoEnabled" ${s.autoSites.enabled ? 'checked' : ''}> Nieuwe Plesk-domeinen automatisch als website bewaken</label>
      <label class="check" style="margin-left:24px"><input type="checkbox" name="autoCheck" ${s.autoSites.check ? 'checked' : ''}> … inclusief bereikbaarheidscontrole elke minuut</label>
      <h3 style="margin-top:10px">Bewaking van het dashboard zelf</h3>
      <p class="note">Als het dashboard uitvalt, merk je dat niet via het dashboard. Gebruik daarom een externe controle:</p>
      <label>Heartbeat-URL (elke minuut aangeroepen, bijv. healthchecks.io of een Uptime Kuma push-monitor)
        <input name="heartbeatUrl" value="${esc(s.heartbeatUrl)}" placeholder="https://hc-ping.com/…"></label>
      <p class="note">Of laat een andere server <code>${esc(health)}</code> controleren: die geeft HTTP 503 als er 5 minuten geen agentdata binnenkomt.
        Kant-en-klaar script: <code>scripts/watchdog.sh</code> (zie README).</p>
      <div class="form-error" id="gMsg"></div>
      <div class="actions"><button class="btn">Opslaan</button></div>
    </form>`;
  $('#gForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/settings', { method: 'PUT', body: { autoSites: { enabled: fd.get('autoEnabled') === 'on', check: fd.get('autoCheck') === 'on' }, heartbeatUrl: fd.get('heartbeatUrl') } });
      $('#gMsg').style.color = '#86efac';
      $('#gMsg').textContent = 'Opgeslagen ✓';
    } catch (ex) { $('#gMsg').style.color = ''; $('#gMsg').textContent = ex.message; }
  };
}

async function drawUsersAdmin(el) {
  const { users } = await api('/users');
  el.innerHTML = `
    <div class="panel-head"><h3>Gebruikers</h3><div class="right"><button class="btn small" id="addUser">+ Gebruiker</button></div></div>
    <table><thead><tr><th>Naam</th><th>Rol</th><th>2FA</th><th>Laatste login</th><th></th></tr></thead>
      <tbody>${users.map((u) => `<tr>
        <td><b>${esc(u.username)}</b>${u.id === me.id ? ' <span class="muted">(jij)</span>' : ''}</td>
        <td><select data-role="${u.id}" ${u.id === me.id ? 'disabled' : ''} style="width:auto;padding:4px 8px">
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Beheerder</option>
          <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Alleen lezen</option></select></td>
        <td>${u.totp ? '✅' : '<span class="muted">uit</span>'}</td>
        <td>${u.last_login ? fmt.ago(u.last_login) : '<span class="muted">nooit</span>'}</td>
        <td class="actions">
          <button class="btn ghost small" data-act="pw" data-id="${u.id}">Wachtwoord</button>
          ${u.totp ? `<button class="btn ghost small" data-act="2fa" data-id="${u.id}">2FA resetten</button>` : ''}
          ${u.id !== me.id ? `<button class="btn danger small" data-act="del" data-id="${u.id}">Verwijderen</button>` : ''}
        </td></tr>`).join('')}</tbody></table>
    <p class="note">Beheerders kunnen alles wijzigen; "alleen lezen" kan meekijken (bijv. collega's of een tv-scherm) maar niets aanpassen.</p>`;
  const reload = () => drawUsersAdmin(el);
  el.onchange = async (e) => {
    const sel = e.target.closest('select[data-role]');
    if (!sel) return;
    try { await api(`/users/${sel.dataset.role}`, { method: 'PUT', body: { role: sel.value } }); } catch (ex) { alert(ex.message); }
    reload();
  };
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const u = users.find((x) => x.id === +b.dataset.id);
    try {
      if (b.id === 'addUser') {
        const r = await userDialog();
        if (r) reload();
      } else if (b.dataset.act === 'pw') {
        const pw = prompt(`Nieuw wachtwoord voor ${u.username} (min. 10 tekens):`);
        if (pw) { await api(`/users/${u.id}`, { method: 'PUT', body: { password: pw } }); alert('Wachtwoord gewijzigd'); }
      } else if (b.dataset.act === '2fa') {
        if (confirm(`2FA uitschakelen voor ${u.username}? (bijv. bij een kwijtgeraakte telefoon)`)) { await api(`/users/${u.id}`, { method: 'PUT', body: { reset2fa: true } }); reload(); }
      } else if (b.dataset.act === 'del') {
        if (confirm(`Gebruiker ${u.username} verwijderen?`)) { await api(`/users/${u.id}`, { method: 'DELETE' }); reload(); }
      }
    } catch (ex) { alert(ex.message); }
  };
}

function userDialog() {
  return new Promise((resolve) => {
    const d = dialog(`
      <form class="form" method="dialog">
        <h3>Gebruiker toevoegen</h3>
        <label>Gebruikersnaam<input name="username" required pattern="[\\w.@-]{2,64}" autocomplete="off"></label>
        <label>Wachtwoord (min. 10 tekens)<input name="password" type="password" required minlength="10" autocomplete="new-password"></label>
        <label>Rol<select name="role"><option value="viewer">Alleen lezen</option><option value="admin">Beheerder</option></select></label>
        <div class="form-error"></div>
        <div class="actions"><button class="btn ghost" value="cancel" formnovalidate>Annuleren</button><button class="btn" value="ok">Toevoegen</button></div>
      </form>`);
    $('form', d).addEventListener('submit', async (e) => {
      if (e.submitter?.value === 'cancel') return resolve(false);
      e.preventDefault();
      try {
        await api('/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        d.close();
        resolve(true);
      } catch (ex) { $('.form-error', d).textContent = ex.message; }
    });
    d.addEventListener('cancel', () => resolve(false));
  });
}

boot();
