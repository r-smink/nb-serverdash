// Meldingen (webhook, e-mail, Pushover, ntfy, SMS via Twilio), meldingsregels, incidenten, herinneringen en escalatie.
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

// ---------- meldingsregels ----------

// Kanalen waarvan een regel de ontvanger(s) mag vervangen, en welk veld dat is.
const OVERRIDE_FIELD = { email: 'to', twilio: 'to', webhook: 'url', ntfy: 'url' };
const TZ = process.env.TZ || 'Europe/Amsterdam';
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 2000);
const chans = (v) => [...new Set((Array.isArray(v) ? v : []).filter((c) => CHANNELS.includes(c)))];
const hhmm = (v, def) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : def);

function cleanTo(input) {
  const out = {};
  for (const [ch, f] of Object.entries(OVERRIDE_FIELD)) {
    const v = String(input?.[ch] || '').trim().slice(0, 1000);
    if (!v) continue;
    if (f === 'url' && !/^https?:\/\//i.test(v)) throw bad(`${ch}: URL moet met http(s):// beginnen`);
    out[ch] = v;
  }
  return out;
}

/** Valideert en normaliseert één regel. */
export function validateRule(r, i = 0) {
  const name = String(r?.name || '').trim().slice(0, 100);
  if (!name) throw bad(`Regel ${i + 1}: naam is verplicht`);
  const days = ids(r.days).filter((d) => d <= 7);
  return {
    id: typeof r.id === 'string' && /^[a-z0-9]{6,16}$/.test(r.id) ? r.id : Math.random().toString(36).slice(2, 10),
    name,
    enabled: r.enabled !== false,
    scope: ['all', 'servers', 'websites'].includes(r.scope) ? r.scope : 'all',
    servers: ids(r.servers),
    websites: ids(r.websites),
    kind: ['server', 'site'].includes(r.kind) ? r.kind : '',
    minLevel: r.minLevel === 'crit' ? 'crit' : 'warn',
    when: ['always', 'work', 'offhours'].includes(r.when) ? r.when : 'always',
    days: days.length ? days : [1, 2, 3, 4, 5],
    from: hhmm(r.from, '08:00'),
    until: hhmm(r.until, '18:00'),
    channels: chans(r.channels),
    to: cleanTo(r.to),
    exclusive: !!r.exclusive,
    escalate: {
      minutes: Math.max(0, Math.min(1440, Math.floor(+r.escalate?.minutes || 0))),
      channels: chans(r.escalate?.channels),
      to: cleanTo(r.escalate?.to),
    },
  };
}

export const getRules = () => store.getSetting('notifyRules', []);

export function saveRules(input) {
  if (!Array.isArray(input)) throw bad('Regels moeten een lijst zijn');
  const rules = input.slice(0, 200).map(validateRule);
  store.setSetting('notifyRules', rules);
  return rules;
}

/** Lokale weekdag (1 = maandag) en minuten sinds middernacht in de ingestelde tijdzone. */
function localTime(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now * 1000)).map((x) => [x.type, x.value]));
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  return { day, min: +parts.hour * 60 + +parts.minute };
}

const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3);

/** Valt `now` binnen de werktijden van de regel? (van > tot = over middernacht heen) */
export function inWorkHours(r, now) {
  const { day, min } = localTime(now);
  const from = toMin(r.from), until = toMin(r.until);
  if (from <= until) return r.days.includes(day) && min >= from && min < until;
  // nachtvenster, bijv. 22:00–06:00: het deel na middernacht hoort bij de dag ervoor
  if (min >= from) return r.days.includes(day);
  return min < until && r.days.includes(day === 1 ? 7 : day - 1);
}

/** Hoort een server/website bij deze regel? (zonder niveau en tijdvenster) */
function inScope(r, e) {
  if (!r.enabled || !e) return false;
  if (r.kind && r.kind !== e.kind) return false;
  if (r.scope === 'servers') return r.servers.includes(e.serverId);
  if (r.scope === 'websites') return e.kind === 'site' && r.websites.includes(e.id);
  return true;
}

function ruleApplies(r, e, level, now) {
  if (!inScope(r, e) || RANK[level] < RANK[r.minLevel]) return false;
  if (r.when === 'work') return inWorkHours(r, now);
  if (r.when === 'offhours') return !inWorkHours(r, now);
  return true;
}

/** Regels die voor een server/website kunnen gelden (voor de detailpagina's). */
export const rulesFor = (e) => getRules().filter((r) => inScope(r, e)).map((r) => ({ id: r.id, name: r.name, exclusive: r.exclusive }));

/** Kanaalconfig met de ontvanger(s) van een regel eroverheen. */
function withOverride(cfg, ch, to) {
  const f = OVERRIDE_FIELD[ch];
  return f && to?.[ch] ? { ...cfg[ch], [f]: to[ch] } : cfg[ch];
}

/** Ontdubbelde, verstuurbare doelen: [{ch, c, source}] (source = 'default' of regel-id). */
function uniqueTargets(list) {
  const seen = new Set();
  return list.filter((t) => {
    if (!READY[t.ch](t.c)) return false;
    const key = `${t.ch}|${t.c.to || t.c.url || t.c.user || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const defaultTargets = (cfg, level) =>
  CHANNELS.filter((ch) => cfg[ch].enabled && RANK[level] >= RANK[cfg[ch].minLevel]).map((ch) => ({ ch, c: cfg[ch], source: 'default' }));
const ruleTargets = (cfg, r) => r.channels.map((ch) => ({ ch, c: withOverride(cfg, ch, r.to), source: r.id }));
const escalationTargets = (cfg, r) => r.escalate.channels.map((ch) => ({ ch, c: withOverride(cfg, ch, r.escalate.to), source: r.id }));

/** Doelen voor een melding over server/website `e` op `level`. */
export function targetsFor(e, level, now) {
  const cfg = getNotifyConfig();
  const rules = getRules();
  const list = [];
  // "Standaardmeldingen niet versturen" kijkt alleen naar de scope, niet naar niveau of tijdvenster:
  // anders zou "dev-server: alleen kritiek via e-mail" waarschuwingen alsnog via de standaard laten lopen.
  if (!rules.some((r) => r.exclusive && inScope(r, e))) list.push(...defaultTargets(cfg, level));
  for (const r of rules) if (ruleApplies(r, e, level, now)) list.push(...ruleTargets(cfg, r));
  return uniqueTargets(list);
}

/** Doelen voor een herstelmelding: dezelfde bronnen (standaard, regels, escalaties) als bij het probleem. */
function recoveryTargets(state, level) {
  const cfg = getNotifyConfig();
  const rules = new Map(getRules().filter((r) => r.enabled).map((r) => [r.id, r]));
  const list = [];
  for (const src of state.sent) {
    if (src === 'default') list.push(...defaultTargets(cfg, level));
    else if (rules.has(src)) list.push(...ruleTargets(cfg, rules.get(src)));
  }
  for (const id of state.esc) if (rules.has(id)) list.push(...escalationTargets(cfg, rules.get(id)));
  return uniqueTargets(list);
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

const CHANNEL_NAME = { webhook: 'webhook', email: 'e-mail', pushover: 'Pushover', ntfy: 'ntfy', twilio: 'sms' };

function sendTo(targets, m) {
  return Promise.all(targets.map(async (t) => {
    try {
      await SENDERS[t.ch](t.c, m);
      return { channel: t.ch, source: t.source, ok: true };
    } catch (e) {
      console.warn(`Melding via ${t.ch} mislukt: ${e.message}`);
      return { channel: t.ch, source: t.source, ok: false, error: e.message };
    }
  }));
}

/** Testmelding via één kanaal, ongeacht of het standaard aan staat. */
export async function notify(m, { only }) {
  const c = getNotifyConfig()[only];
  if (!c) return [];
  if (!READY[only](c)) return [{ channel: only, ok: false, error: 'niet volledig ingesteld' }];
  return sendTo([{ ch: only, c, source: 'test' }], m);
}

/** Testmelding naar de kanalen en escalatiekanalen van één (nog niet opgeslagen) regel. */
export function testRule(input, m) {
  const r = validateRule(input);
  const cfg = getNotifyConfig();
  const targets = uniqueTargets([...ruleTargets(cfg, r), ...escalationTargets(cfg, r)]);
  if (!targets.length) throw bad('Deze regel heeft geen (volledig ingestelde) kanalen');
  return sendTo(targets, m);
}

/** Schrijft bij het incident via welke kanalen een melding ging (en wat mislukte). */
function logSent(incId, what, results) {
  if (!incId) return;
  if (!results.length) { store.addIncidentNote(incId, 'systeem', `${what}: geen kanalen volgens de meldingsinstellingen`); return; }
  const names = new Map(getRules().map((r) => [r.id, r.name]));
  const by = (r) => `${CHANNEL_NAME[r.channel] || r.channel}${r.source !== 'default' ? ` (regel ${names.get(r.source) || '?'})` : ''}`;
  const ok = results.filter((r) => r.ok).map(by);
  const failed = results.filter((r) => !r.ok).map((r) => `${by(r)}: ${r.error}`);
  store.addIncidentNote(incId, 'systeem', `${what} verstuurd${ok.length ? ` via ${ok.join(', ')}` : ''}${failed.length ? ` — mislukt: ${failed.join('; ')}` : ''}`);
}

const stateOf = (inc) => {
  try { return { sent: [], esc: [], ...JSON.parse(inc?.notify_state || '{}') }; } catch { return { sent: [], esc: [] }; }
};

/** Verstuurt een melding over een incident, logt het resultaat en onthoudt welke bronnen gemeld hebben. */
async function send(inc, what, targets, m) {
  if (targets.length) {
    const st = stateOf(store.getIncident(inc.id));
    st.sent = [...new Set([...st.sent, ...targets.map((t) => t.source)])];
    store.updateIncident(inc.id, { notify_state: JSON.stringify(st) });
  }
  logSent(inc.id, what, await sendTo(targets, m));
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
  const msg = { level: lvl, title: `${ICON[lvl]} ${e.title} — ${LEVEL_TEXT[lvl]}`, text: summary, url: link(e.hash) };

  if (lvl === 'crit' || lvl === 'warn') {
    if (!open) {
      const inc = store.createIncident({ kind: e.kind, entity_id: e.id, server_id: e.serverId, title: e.title, level: lvl, summary, started: now, last_notified: silent ? null : now });
      if (!silent) send(inc, 'Melding', targetsFor(e, lvl, now), msg);
      return;
    }
    const fields = { summary };
    if (RANK[lvl] > RANK[open.level]) fields.level = lvl;
    if (!silent && prev !== undefined && prev !== lvl && prev !== 'pending') {
      fields.last_notified = now;
      send(open, `Melding (${LEVEL_TEXT[lvl].toLowerCase()})`, targetsFor(e, lvl, now), msg);
    }
    store.updateIncident(open.id, fields);
    return;
  }

  if (lvl === 'ok' && open) {
    store.updateIncident(open.id, { ended: now });
    const dur = Math.round((now - open.started) / 60);
    const st = stateOf(open);
    // Incidenten van vóór de meldingsregels hebben geen vastgelegde bronnen: dan de standaardkanalen.
    const targets = st.sent.length || st.esc.length ? recoveryTargets(st, open.level) : uniqueTargets(defaultTargets(getNotifyConfig(), open.level));
    send(open, 'Herstelmelding', targets,
      { level: 'ok', title: `${ICON.ok} ${e.title} — Hersteld`, text: `Weer normaal na ${dur} min (${open.summary})`, url: link(e.hash) });
  }
}

/** Herinneringen en escalaties voor incidenten die nog openstaan en niet bevestigd zijn. */
export function remind(currentStatus, now) {
  const cfg = getNotifyConfig();
  const escRules = getRules().filter((r) => r.enabled && r.escalate.minutes > 0 && r.escalate.channels.length);
  if (!cfg.repeatMinutes && !escRules.length) return;
  for (const inc of store.openIncidents()) {
    if (inc.ack_ts) continue;
    const status = currentStatus(inc);
    if (!status || (status.level !== 'crit' && status.level !== 'warn')) continue;
    const mins = Math.round((now - inc.started) / 60);
    const url = link(inc.kind === 'site' ? `#/website/${inc.entity_id}` : `#/server/${inc.entity_id}`);
    const e = { kind: inc.kind, id: inc.entity_id, serverId: inc.server_id };

    // Escalatie: per regel één keer per incident, zodra het lang genoeg onbevestigd openstaat.
    const st = stateOf(inc);
    const due = escRules.filter((r) => !st.esc.includes(r.id) && now - inc.started >= r.escalate.minutes * 60
      && inScope(r, e) && RANK[status.level] >= RANK[r.minLevel]);
    if (due.length) {
      st.esc.push(...due.map((r) => r.id));
      store.updateIncident(inc.id, { notify_state: JSON.stringify(st) });
      const targets = uniqueTargets(due.flatMap((r) => escalationTargets(cfg, r)));
      sendTo(targets, {
        level: status.level,
        title: `⏫ Escalatie: ${inc.title} — ${LEVEL_TEXT[status.level]}`,
        text: `Al ${mins} min niet bevestigd: ${problemText(status)}`,
        url,
      }).then((res) => logSent(inc.id, `Escalatie (${due.map((r) => r.name).join(', ')})`, res));
    }

    if (!cfg.repeatMinutes) continue;
    if (now - (inc.last_notified || inc.started) < cfg.repeatMinutes * 60) continue;
    store.updateIncident(inc.id, { last_notified: now });
    sendTo(targetsFor(e, status.level, now), {
      level: status.level,
      title: `${ICON[status.level]} Nog steeds ${LEVEL_TEXT[status.level].toLowerCase()}: ${inc.title}`,
      text: `Al ${mins} min: ${problemText(status)}. Bevestig het incident in het dashboard om herinneringen te stoppen.`,
      url,
    });
  }
}
