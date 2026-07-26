// The only JavaScript on this site. Inlined by build.ts into a blocking <head>
// script so the theme is on <html> before first paint — no flash of the wrong
// theme. Resolution order: explicit localStorage choice, then the OS preference.
// No eval, no new Function, no external request: safe under a strict CSP with the
// script hash build.ts writes to dist/csp.txt.
(() => {
  var root = document.documentElement;
  var KEY = 'theme';
  var mql = window.matchMedia('(prefers-color-scheme: dark)');

  function osTheme() {
    return mql.matches ? 'dark' : 'light';
  }

  function stored() {
    // Declared at the function root, not inside the try: `var` hoists there anyway, and
    // writing it inline reads as if it were block-scoped when it is not.
    var v = null;
    try {
      // Throws in Safari private mode and wherever storage is blocked by policy.
      v = localStorage.getItem(KEY);
    } catch (_e) {
      return null;
    }
    return v === 'dark' || v === 'light' ? v : null;
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
  }

  apply(stored() || osTheme());

  // Follow the OS only while the visitor has made no explicit choice.
  mql.addEventListener('change', () => {
    if (!stored()) apply(osTheme());
  });

  // Delegated so the listener can be attached before the button exists.
  document.addEventListener('click', (event) => {
    var target = event.target;
    if (!target?.closest) return;
    if (!target.closest('[data-theme-toggle]')) return;
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, next);
    } catch (_e) {
      /* private mode: the choice lasts for this page view only */
    }
    apply(next);
  });
})();
