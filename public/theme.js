'use strict';
// Zet het thema vóór de eerste render (geen flits van het verkeerde thema). Licht is standaard.
(function () {
  let t = 'light';
  try { t = localStorage.getItem('sd-theme') || 'light'; } catch { /* geen opslag beschikbaar */ }
  document.documentElement.dataset.theme = t;
})();

function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('sd-theme', t); } catch { /* negeren */ }
  window.dispatchEvent(new Event('themechange'));
}
