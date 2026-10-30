// Meldingen (webhook, e-mail, Pushover, ntfy, SMS via Twilio), incidenten en herhaalmeldingen.
import nodemailer from 'nodemailer';
import { config } from './config.js';
import * as store from './db.js';

const RANK = { ok: 0, warn: 1, crit: 2 };
const LEVEL_TEXT = { crit: 'Kritiek', warn: 'Waarschuwing', ok: 'Hersteld' };
const ICON = { crit: '🔴', warn: '🟠', ok: '🟢' };
export const MASK = '••••••••';

export const DEFAULT_NOTIFY = {
  repeatMinutes: 30,
  webhook: { enabled: false, url: '', minLevel: 'warn' },
  email: { enabled: false, host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '', minLevel: 'warn' },
  pushover: { enabled: false, token: '', user: '', minLevel: 'crit' },
  ntfy: { enabled: false, url: 'https://ntfy.sh/', token: '', minLevel: 'warn' },
  twilio: { enabled: false, sid: '', token: '', from: '', to: '', minLevel: 'crit' },
};
const SECRETS = { email: ['pass'], pushover: ['token', 'user'], ntfy: ['token'], twilio: ['token'] };
const CHANNELS = ['webhook', 'email', 'pushover', 'ntfy', 'twilio'];

// ---------- configuratie ----------

export function getNotifyConfig() {
  const saved = store.getSetting('notify', null);
  const cfg = structuredClone(DEFAULT_NOTIFY);
  if (!saved) {
    // migratie van de oude losse webhook-instelling
    const old = store.getSetting('webhookUrl', '');
    if (old) Object.assign(cfg.webhook, { enabled: true, url: old });
    return cfg;
  }
  if (Number.isFinite(+saved.repeatMinutes)) cfg.repeatMinutes = +saved.repeatMinutes;
  for (const ch of CHANNELS) Object.assign(cfg[ch], saved[ch] || {});
  return cfg;
}

export function maskedNotifyConfig() {
  const cfg = getNotifyConfig();
  for (const [ch, fields] of Object.entries(SECRETS)) {
    for (const f of fields) if (cfg[ch][f]) cfg[ch][f] = MASK;
  }
  return cfg;
}

export function saveNotifyConfig(input) {
  const current = getNotifyConfig();
  const cfg = structuredClone(DEFAULT_NOTIFY);
  cfg.repeatMinutes = Math.max(0, Math.min(1440, Math.floor(+input.repeatMinutes || 0)));
  for (const ch of CHANNELS) {
    const src = input[ch] || {};
    for (const [k, def] of Object.entries(DEFAULT_NOTIFY[ch])) {
      let v = src[k] ?? current[ch][k];
      if (SECRETS[ch]?.includes(k) && v === MASK) v = current[ch][k];
      if (typeof def === 'boolean') v = !!v;
      else if (typeof def === 'number') v = Number.isFinite(+v) ? +v : def;
      else v = String(v ?? '').trim();
      cfg[ch][k] = v;
    }
    if (!RANK[cfg[ch].minLevel] && cfg[ch].minLevel !== 'warn') cfg[ch].minLevel = 'warn';
  }
  for (const [ch, key] of [['webhook', 'url'], ['ntfy', 'url']]) {
    if (cfg[ch][key] && !/^https?:\/\//i.test(cfg[ch][key])) throw Object.assign(new Error(`${ch}: URL moet met http(s):// beginnen`), { status: 400 });
  }
  store.setSetting('notify', cfg);
  return cfg;
}

// ---------- verzenden ----------

const timeout = () => AbortSignal.timeout(10_000);

async function sendWebhook(c, m) {
  const text = `${m.title}\n${m.text}${m.url ? `\n${m.url}` : ''}`;
  const r = await fetch(c.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: timeout(),
    body: JSON.stringify({ text, content: text, title: m.title, message: m.text, level: m.level, url: m.url }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

let mailer = null;
let mailerKey = '';
async function sendEmail(c, m) {
  const key = JSON.stringify([c.host, c.port, c.secure, c.user, c.pass]);
  if (!mailer || key !== mailerKey) {
    mailer = nodemailer.createTransport({
      host: c.host, port: c.port, secure: !!c.secure,
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    });
    mailerKey = key;
  }
  await mailer.sendMail({
    from: c.from || c.user, to: c.to, subject: m.title,
    text: `${m.text}\n\n${m.url || ''}\n\n— NextBuzz ServerDash`,
  });
}

async function sendPushover(c, m) {
  const body = new URLSearchParams({
    token: c.token, user: c.user, title: m.title, message: m.text,
    priority: m.level === 'crit' ? '1' : '0', ...(m.url ? { url: m.url, url_title: 'Open dashboard' } : {}),
  });
  const r = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body, signal: timeout() });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function sendNtfy(c, m) {
  const headers = {
    Title: encodeURIComponent(m.title).length === m.title.length ? m.title : m.title.replace(/[^\x20-\x7e]/g, '').trim(),
    Priority: m.level === 'crit' ? '5' : m.level === 'warn' ? '4' : '3',
    Tags: m.level === 'crit' ? 'rotating_light' : m.level === 'warn' ? 'warning' : 'white_check_mark',
  };
  if (m.url) headers.Click = m.url;
  if (c.token) headers.Authorization = `Bearer ${c.token}`;
  const r = await fetch(c.url, { method: 'POST', headers, body: m.text, signal: timeout() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

async function sendTwilio(c, m) {
  const auth = Buffer.from(`${c.sid}:${c.token}`).toString('base64');
  for (const to of c.to.split(/[,;\s]+/).filter(Boolean)) {
    const body = new URLSearchParams({ To: to, From: c.from, Body: `${m.title}: ${m.text}`.slice(0, 600) });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.sid)}/Messages.json`, {
      method: 'POST', headers: { Authorization: `Basic ${auth}` }, body, signal: timeout(),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
}

const SENDERS = { webhook: sendWebhook, email: sendEmail, pushover: sendPushover, ntfy: sendNtfy, twilio: sendTwilio };
const READY = {
  webhook: (c) => c.url, email: (c) => c.host && c.to, pushover: (c) => c.token && c.user,
  ntfy: (c) => c.url && c.url.replace(/\/+$/, '') !== 'https://ntfy.sh', twilio: (c) => c.sid && c.token && c.from && c.to,
};

/**
 * Verstuurt een melding naar alle ingeschakelde kanalen waarvan het minimale level gehaald wordt.
 * Herstelmeldingen gaan naar de kanalen die het oorspronkelijke probleem ook kregen.
 */
export async function notify(m, { prevLevel = null, only = null } = {}) {
  const cfg = getNotifyConfig();
  const results = [];
  await Promise.all(CHANNELS.map(async (ch) => {
    const c = cfg[ch];
    if (only ? only !== ch : !c.enabled) return;
    if (!READY[ch](c)) { if (only) results.push({ channel: ch, ok: false, error: 'niet volledig ingesteld' }); return; }
    const lvl = m.level === 'ok' ? (prevLevel || 'crit') : m.level;
    if (!only && RANK[lvl] < RANK[c.minLevel]) return;
    try {
      await SENDERS[ch](c, m);
      results.push({ channel: ch, ok: true });
    } catch (e) {
      console.warn(`Melding via ${ch} mislukt: ${e.message}`);
      results.push({ channel: ch, ok: false, error: e.message });
    }
  }));
  return results;
}

const link = (hash) => (config.publicUrl ? `${config.publicUrl}/${hash}` : '');

// ---------- incidenten ----------

const problemText = (status) => status.issues.filter((i) => i.level === 'crit' || i.level === 'warn').map((i) => i.msg).join(', ');

/**
 * Verwerkt een statuswijziging van een server of website: incident openen/bijwerken/sluiten en melden.
 * @param e {kind, id, serverId, title, hash}
 * @param silent  true bij opstarten/ongewijzigd level: wel incidenten openen of bijwerken, niet opnieuw melden
 */
export function handleTransition(e, prev, lvl, status, now, silent = false) {
  if (lvl === 'pending' || lvl === 'muted') return;
  const open = store.openIncident(e.kind, e.id);
  const summary = problemText(status);

  if (lvl === 'crit' || lvl === 'warn') {
    if (!open) {
      store.createIncident({ kind: e.kind, entity_id: e.id, server_id: e.serverId, title: e.title, level: lvl, summary, started: now, last_notified: silent ? null : now });
      if (!silent) notify({ level: lvl, title: `${ICON[lvl]} ${e.title} — ${LEVEL_TEXT[lvl]}`, text: summary, url: link(e.hash) });
      return;
    }
    const fields = { summary };
    if (RANK[lvl] > RANK[open.level]) fields.level = lvl;
    if (!silent && prev !== undefined && prev !== lvl && prev !== 'pending') {
      fields.last_notified = now;
      notify({ level: lvl, title: `${ICON[lvl]} ${e.title} — ${LEVEL_TEXT[lvl]}`, text: summary, url: link(e.hash) });
    }
    store.updateIncident(open.id, fields);
    return;
  }

  if (lvl === 'ok' && open) {
    store.updateIncident(open.id, { ended: now });
    const dur = Math.round((now - open.started) / 60);
    notify({ level: 'ok', title: `${ICON.ok} ${e.title} — Hersteld`, text: `Weer normaal na ${dur} min (${open.summary})`, url: link(e.hash) },
      { prevLevel: open.level });
  }
}

/** Herinneringen voor incidenten die nog openstaan en niet bevestigd zijn. */
export function remind(currentStatus, now) {
  const cfg = getNotifyConfig();
  if (!cfg.repeatMinutes) return;
  for (const inc of store.openIncidents()) {
    if (inc.ack_ts) continue;
    const last = inc.last_notified || inc.started;
    if (now - last < cfg.repeatMinutes * 60) continue;
    const status = currentStatus(inc);
    if (!status || (status.level !== 'crit' && status.level !== 'warn')) continue;
    store.updateIncident(inc.id, { last_notified: now });
    const mins = Math.round((now - inc.started) / 60);
    const hash = inc.kind === 'site' ? `#/website/${inc.entity_id}` : `#/server/${inc.entity_id}`;
    notify({
      level: status.level,
      title: `${ICON[status.level]} Nog steeds ${LEVEL_TEXT[status.level].toLowerCase()}: ${inc.title}`,
      text: `Al ${mins} min: ${problemText(status)}. Bevestig het incident in het dashboard om herinneringen te stoppen.`,
      url: link(hash),
    });
  }
}
