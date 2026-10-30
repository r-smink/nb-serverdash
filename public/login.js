'use strict';
const form = document.getElementById('login');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const body = Object.fromEntries(new FormData(form));
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Inloggen mislukt');
    location.href = '/';
  } catch (ex) {
    err.textContent = ex.message;
  }
});
