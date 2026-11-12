/* Test fixture: the liquid-glass prototype kit 0.2.0 ownership guard, verbatim from its
   kit.js (lines 12-26), followed by a sentinel body instead of the real kit. */
(() => {
  'use strict';
  const VERSION = '0.2.0';
  const prior = window.LiquidGlass;
  if (prior) {
    const older = (a, b) => {
      const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
      for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
      return false;
    };
    // Same or newer kit already running (a patch re-ran this script): rescan only.
    // An older kit that can tear itself down hands over to this version.
    if (!older(prior.version, VERSION) || typeof prior.teardown !== 'function') { prior.scan(); return; }
    prior.teardown();
  }
  window.__legacyKitBody = (window.__legacyKitBody || 0) + 1;
  window.LiquidGlass = { version: VERSION, scan() {}, api() {}, destroy() {}, teardown() { delete window.LiquidGlass; } };
})();
