// HTTP(S)-controle van websites: bereikbaarheid, responstijd, statuscode, sleutelwoord en SSL-geldigheid.
import http from 'node:http';
import https from 'node:https';

const MAX_BODY = 1024 * 1024;

function request(url, timeout, wantBody) {
  return new Promise((resolve) => {
    const started = performance.now();
    let cert = null;
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      agent: false,
      timeout,
      headers: { 'User-Agent': 'NextBuzz-ServerDash/1.0 (uptime check)', Accept: 'text/html,*/*' },
    }, (res) => {
      const ttfb = performance.now() - started;
      if (res.socket?.getPeerCertificate) {
        const c = res.socket.getPeerCertificate();
        if (c?.valid_to) cert = { validTo: Date.parse(c.valid_to), issuer: c.issuer?.O || c.issuer?.CN || '' };
      }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        if (!wantBody) return;
        size += d.length;
        if (size <= MAX_BODY) chunks.push(d);
      });
      res.on('end', () => resolve({
        status: res.statusCode, location: res.headers.location, ttfb, ms: performance.now() - started, cert,
        body: wantBody ? Buffer.concat(chunks).toString('utf8') : '',
      }));
      res.on('error', (e) => resolve({ error: e.message, ms: performance.now() - started }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout na ${timeout / 1000} s`)));
    req.on('error', (e) => resolve({ error: friendlyError(e), ms: performance.now() - started }));
    req.end();
  });
}

function friendlyError(e) {
  const map = {
    ENOTFOUND: 'DNS: domein niet gevonden', ECONNREFUSED: 'verbinding geweigerd', ECONNRESET: 'verbinding verbroken',
    CERT_HAS_EXPIRED: 'SSL-certificaat verlopen', DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed SSL-certificaat',
    ERR_TLS_CERT_ALTNAME_INVALID: 'SSL-certificaat hoort niet bij dit domein', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'SSL-keten onvolledig',
    EHOSTUNREACH: 'host onbereikbaar', ETIMEDOUT: 'timeout',
  };
  return map[e.code] || e.message;
}

/** Controleert een URL; volgt maximaal 5 redirects. */
export async function checkUrl(rawUrl, { keyword = '', timeout = 15000 } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return { ok: false, error: 'ongeldige URL', ms: 0 }; }
  let total = 0;
  let firstCert = null;
  for (let hop = 0; hop <= 5; hop++) {
    const r = await request(url, timeout, !!keyword);
    total += r.ms;
    if (!firstCert && r.cert) firstCert = r.cert;
    if (r.error) return { ok: false, error: r.error, ms: Math.round(total), url: url.href };
    if (r.status >= 300 && r.status < 400 && r.location) {
      url = new URL(r.location, url);
      continue;
    }
    const result = { ok: r.status < 400, status: r.status, ms: Math.round(total), ttfb: Math.round(r.ttfb), url: url.href };
    if (result.ok && keyword && !r.body.includes(keyword)) {
      result.ok = false;
      result.error = `sleutelwoord "${keyword}" niet gevonden`;
    }
    const cert = r.cert || firstCert;
    if (cert) {
      result.certDays = Math.floor((cert.validTo - Date.now()) / 86400000);
      result.certIssuer = cert.issuer;
      result.certValidTo = Math.floor(cert.validTo / 1000);
    }
    return result;
  }
  return { ok: false, error: 'te veel redirects', ms: Math.round(total), url: url.href };
}
