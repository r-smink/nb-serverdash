'use strict';
const form = document.getElementById('login');
const step2 = document.getElementById('step2');
const codeInput = form.elements.code;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const body = Object.fromEntries(new FormData(form));
  if (step2.classList.contains('hidden')) delete body.code;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Inloggen mislukt');
    if (j.needCode) {
      document.getElementById('step1').classList.add('hidden');
      step2.classList.remove('hidden');
      codeInput.required = true;
      codeInput.focus();
      return;
    }
    location.href = '/';
  } catch (ex) {
    err.textContent = ex.message;
    if (!step2.classList.contains('hidden')) { codeInput.value = ''; codeInput.focus(); }
  }
});
