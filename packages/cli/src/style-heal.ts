// The inline script that heals a document whose render-blocking stylesheet failed to load: one
// reload, guarded per URL in `sessionStorage` so it cannot loop. Constant, so the served policy
// admits it by hash (`script-csp.ts`) — an inline `onerror=` handler is what `script-src` refuses.

/** The `sessionStorage` key holding the URL this tab already reloaded once for a missing sheet. */
export const STYLE_HEAL_KEY = 'x-style-heal';

/**
 * Why: during a rolling deploy with more than one web replica, a document from one build can name
 * a stylesheet only the other build serves; the answering pod's `404` leaves the page unstyled
 * (`style-routes.ts`). A reload is a fresh pair of requests and usually lands on one build.
 *
 * - Listens in the CAPTURE phase on `window`: a resource `error` does not bubble. It sits BEFORE
 *   the `<link>` in the head, because a parser-blocking script after a stylesheet runs only once
 *   that sheet settled, by which time its `error` was dispatched to nobody.
 * - Only while the document loads: after `load` it stops listening, so a sheet the soft-navigation
 *   router or a script appends later is never a reason to reload (the router has its own answer),
 *   and a copy the router runs into an already-loaded tab listens to nothing.
 * - Once per URL: the marker is set before reloading and cleared by a load whose sheets all
 *   arrived, so the next skew on this page heals again. No storage, no reload — never a loop.
 * - A GET of the same URL (`location.replace`), never `reload()`: an admin form POST renders its
 *   answer in place, and reloading that re-sends the form. With a fragment the same URL would only
 *   scroll, so there it is `reload()` — no POST answer carries one.
 */
export const STYLE_HEAL_BODY =
  "(function(){if(document.readyState==='complete')return;" +
  `var k='${STYLE_HEAL_KEY}',f=0;` +
  'function h(e){var l=e.target;' +
  "if(!l||l.tagName!=='LINK'||!/(^|\\s)stylesheet(\\s|$)/i.test(l.rel||''))return;f=1;" +
  'try{if(sessionStorage.getItem(k)===location.href)return;sessionStorage.setItem(k,location.href)}' +
  'catch(_){return}location.hash?location.reload():location.replace(location.href)}' +
  "addEventListener('error',h,true);" +
  "addEventListener('load',function(){removeEventListener('error',h,true);" +
  'if(!f)try{sessionStorage.removeItem(k)}catch(_){}})})()';

/** The tag a document carries ahead of its stylesheet links. */
export const STYLE_HEAL_TAG = `<script>${STYLE_HEAL_BODY}</script>`;
