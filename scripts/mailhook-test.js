// Stuurt voorbeeldmeldingen naar de webhook voor e-mailmeldingen en controleert de antwoorden.
//
//   node scripts/mailhook-test.js https://monitor.nextbuzz.nl/hooks/mail/<token>
//   HOOK_URL=http://127.0.0.1:8080/hooks/mail/<token> node scripts/mailhook-test.js
//
// Maak het token aan in Beheer → E-mailmeldingen (webhook). De meldingen staan daarna op het overzicht en in de tv-modus.
// Met --recover wordt op het eind ook "hersteld" gestuurd voor de eerste site.

const url = process.argv.find((a) => /^https?:\/\//.test(a)) || process.env.HOOK_URL;
if (!url || !/\/hooks\/mail\/[^/]+$/.test(url)) {
  console.error('Gebruik: node scripts/mailhook-test.js <webhook-URL>  (…/hooks/mail/<token>)');
  process.exit(2);
}
const base = url.replace(/\/hooks\/mail\/[^/]+$/, '');
const token = url.split('/').pop();
const now = new Date().toISOString();

const payload = (event, site, mail = {}, extra = {}) => ({
  event, site_title: site.title, site_url: site.url, message: `${event} op ${site.title}`, text: '',
  mail: { to: ['jan.jansen@klant.nl'], subject: 'Je bestelling #1042 is ontvangen', error: '', backup_error: '',
    diagnose_code: '', diagnose_title: '', initiator: 'WooCommerce', log_id: 42, time: now, ...mail },
  suppressed: 0, maillog_url: `${site.url}/wp-admin/admin.php?page=nb-ocmonitor&tab=maillog&log=42`, ...extra,
});

const klant = { title: 'Bakkerij De Klant', url: 'https://klant.nl' };
const shop = { title: 'Fietsenshop Oost', url: 'https://www.fietsenshop-oost.nl' };
const praktijk = { title: 'Fysio Praktijk Zuid', url: 'https://fysiozuid.nl' };

let failed = 0;
async function check(name, expected, { body, raw, path = `/hooks/mail/${token}`, headers = {} }) {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: raw ?? JSON.stringify(body),
  }).catch((e) => ({ status: `fout: ${e.message}`, text: async () => '' }));
  const text = await r.text();
  const ok = r.status === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FOUT'} ${String(r.status).padEnd(4)} (verwacht ${expected})  ${name}  ${text.slice(0, 80)}`);
}

await check('smtp.failed (auth)', 200, { body: payload('smtp.failed', klant, {
  error: 'SMTP Error: Could not authenticate.', diagnose_code: 'auth', diagnose_title: 'Inloggen bij de SMTP-server lukt niet' }) });
await check('smtp.failed opnieuw (dedupe, suppressed 3)', 200, { body: payload('smtp.failed', klant, {
  subject: 'Wachtwoord opnieuw instellen', to: ['p.devries@gmail.com', 'info@klant.nl'], initiator: 'WordPress',
  error: 'SMTP Error: Could not authenticate.', diagnose_title: 'Inloggen bij de SMTP-server lukt niet' }, { suppressed: 3 }) });
await check('smtp.backup_used (Bearer-header)', 200, { path: '/hooks/mail', headers: { Authorization: `Bearer ${token}` },
  body: payload('smtp.backup_used', shop, { error: 'Connection timed out (110)', diagnose_title: 'SMTP-server reageert niet',
    initiator: 'Contact Form 7', subject: 'Nieuw bericht via het contactformulier' }, { source: 'oc-panel', panel_url: 'https://oc.nextbuzz.nl' }) });
await check('smtp.failed zonder diagnose, met <script> in velden', 200, { body: payload('smtp.failed', { title: '<img src=x onerror=alert(1)>Praktijk', url: praktijk.url }, {
  error: '550 5.7.1 <script>alert(1)</script> Relaying denied', subject: '"><b>Afspraakbevestiging</b>', initiator: 'Amelia' },
{ maillog_url: 'javascript:alert(1)' }) });
await check('smtp.test', 200, { body: payload('smtp.test', { title: 'Testsite NextBuzz', url: 'https://test.nextbuzz.nl' }, { to: [], subject: '', initiator: '' }) });
await check('onbekend event (genegeerd)', 200, { body: payload('smtp.whatever', klant) });
await check('onbekend token', 404, { path: '/hooks/mail/' + 'x'.repeat(43), body: payload('smtp.test', klant) });
await check('geen token', 404, { path: '/hooks/mail', body: payload('smtp.test', klant) });
await check('ongeldige JSON', 400, { raw: '{"event": "smtp.failed",' });
await check('JSON-array', 400, { raw: '[1,2,3]' });
await check('te groot (> 32 KB)', 413, { raw: JSON.stringify({ event: 'smtp.failed', text: 'x'.repeat(40 * 1024) }) });
await check('verkeerd Content-Type', 415, { raw: 'event=smtp.failed', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
if (process.argv.includes('--recover')) {
  await check('smtp.recovered (wist fout van klant.nl)', 200, { body: payload('smtp.recovered', klant) });
}

console.log(failed ? `\n${failed} controle(s) mislukt` : '\nAlle controles geslaagd');
process.exit(failed ? 1 : 0);
