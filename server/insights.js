// Afgeleide inzichten: trendvoorspelling schijven en actuele WordPress-versies (api.wordpress.org).
import * as store from './db.js';

// ---------- schijfvoorspelling ----------

const forecastCache = new Map(); // serverId -> {ts, data}

/**
 * Lineaire regressie over de schijfvulling (%) van de afgelopen 7 dagen per mountpoint.
 * @returns [{mount, current, perDay, days}]  days = null als de schijf niet (merkbaar) groeit
 */
export function diskForecast(serverId, now = store.nowSec()) {
  const cached = forecastCache.get(serverId);
  if (cached && now - cached.ts < 900) return cached.data;
  const h = store.diskHistory(serverId, now - 7 * 86400);
  const out = [];
  for (const [mount, vals] of Object.entries(h.mounts)) {
    const pts = h.ts.map((t, i) => [t, vals[i]]).filter(([, v]) => v != null);
    if (pts.length < 12 || pts[pts.length - 1][0] - pts[0][0] < 86400) {
      out.push({ mount, current: pts.length ? pts[pts.length - 1][1] : null, perDay: null, days: null });
      continue;
    }
    const n = pts.length;
    const mx = pts.reduce((a, [t]) => a + t, 0) / n;
    const my = pts.reduce((a, [, v]) => a + v, 0) / n;
    let num = 0, den = 0;
    for (const [t, v] of pts) { num += (t - mx) * (v - my); den += (t - mx) ** 2; }
    const slope = den ? num / den : 0;           // % per seconde
    const perDay = slope * 86400;
    const current = pts[n - 1][1];
    // Vanaf het laatste punt doorrekenen; groei onder 0,05%/dag telt niet als groei.
    const days = perDay > 0.05 ? Math.max(0, (100 - current) / perDay) : null;
    out.push({ mount, current, perDay, days: days != null && days < 730 ? days : null });
  }
  forecastCache.set(serverId, { ts: now, data: out });
  return out;
}

// ---------- WordPress-versies ----------

const CACHE_KEY = 'wporg_cache';
const STALE = 12 * 3600;
let wp = store.getSetting(CACHE_KEY, null) || { core: null, coreTs: 0, plugins: {}, themes: {} };

export const wpCache = () => wp;

/** Vergelijkt versienummers: >0 als a nieuwer is dan b. */
export function cmpVersion(a, b) {
  const pa = String(a || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'NextBuzz-ServerDash/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

let refreshing = false;

/** Haalt ontbrekende of verouderde versies op bij wordpress.org (max. 80 per ronde). */
export async function refreshWporg(pluginSlugs, themeSlugs) {
  if (refreshing) return;
  refreshing = true;
  const now = store.nowSec();
  try {
    if (!wp.core || now - wp.coreTs > STALE) {
      try {
        const d = await getJson('https://api.wordpress.org/core/version-check/1.7/');
        wp.core = d.offers?.[0]?.current || wp.core;
        wp.coreTs = now;
      } catch (e) { console.warn(`wordpress.org core-check: ${e.message}`); }
    }
    let budget = 80;
    for (const [kind, slugs, url] of [
      ['plugins', pluginSlugs, (s) => `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(s)}&request[fields][sections]=0&request[fields][description]=0`],
      ['themes', themeSlugs, (s) => `https://api.wordpress.org/themes/info/1.2/?action=theme_information&request[slug]=${encodeURIComponent(s)}`],
    ]) {
      for (const slug of slugs) {
        const c = wp[kind][slug];
        if (c && now - c.ts < STALE) continue;
        if (budget-- <= 0) break;
        try {
          const d = await getJson(url(slug));
          wp[kind][slug] = { v: d.version || null, ts: now };   // null = niet op wordpress.org (premium/eigen)
        } catch (e) {
          wp[kind][slug] = { v: null, ts: now - STALE + 3600, err: e.message };  // over een uur opnieuw
        }
      }
    }
    store.setSetting(CACHE_KEY, wp);
  } finally {
    refreshing = false;
  }
}

/** Verrijkt de WordPress-scan van alle servers met "verouderd"-informatie. */
export function wordpressOverview(servers, extraOf) {
  const sites = [];
  const plugins = new Set();
  const themes = new Set();
  for (const s of servers) {
    const scan = extraOf(s).wordpress;
    for (const site of scan?.sites || []) {
      const outdatedPlugins = [];
      for (const [slug, version] of site.plugins || []) {
        plugins.add(slug);
        const latest = wp.plugins[slug]?.v;
        if (latest && cmpVersion(latest, version) > 0) outdatedPlugins.push({ slug, version, latest });
      }
      const outdatedThemes = [];
      for (const [slug, version] of site.themes || []) {
        themes.add(slug);
        const latest = wp.themes[slug]?.v;
        if (latest && cmpVersion(latest, version) > 0) outdatedThemes.push({ slug, version, latest });
      }
      sites.push({
        server_id: s.id, server: s.name, domain: site.domain, path: site.path, version: site.version,
        coreOutdated: !!(wp.core && site.version && cmpVersion(wp.core, site.version) > 0),
        plugins: (site.plugins || []).length, themes: (site.themes || []).length,
        outdatedPlugins, outdatedThemes, unknown: (site.plugins || []).filter(([slug]) => wp.plugins[slug] && !wp.plugins[slug].v).length,
      });
    }
  }
  return { core: wp.core, sites, plugins: [...plugins], themes: [...themes] };
}
