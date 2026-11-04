// Single responsibility: the browser half of client error reporting — the text of
// `/x-client-errors.js`. Two window listeners, one observer on the island failure marker, the caps,
// and a same-origin `fetch`. Generated as a string so `hydrate.ts` pays no byte for an app that
// has the feature off; the route that receives it is `client-errors-routes.ts`.

import { CLIENT_BUILD_META } from '@ultimat3/core';
import { ISLAND_FAILED_ATTRIBUTE, NAVIGATED_EVENT } from '@ultimat3/render';

/** Named by every `app/` document of an app that turned `clientErrors.enabled` on. */
export const CLIENT_ERRORS_SCRIPT_PATH = '/x-client-errors.js';

/** Where a report is POSTed. Beside `/_storage`: a framework route no page can shadow. */
export const CLIENT_ERRORS_PATH = '/_client-errors';

/** Reports one document may send. A loop that throws per frame costs five requests, not 60/s. */
export const CLIENT_ERRORS_MAX_REPORTS = 5;

/** Per-field caps, shared by the sender (which cuts) and the route (which refuses past them). */
export const CLIENT_ERRORS_LIMITS = Object.freeze({
  message: 1_000,
  stack: 8_000,
  path: 2_048,
  island: 128,
  build: 128,
});

/**
 * The script. Rules it keeps, each one a line below:
 * - an `error` counts only when its `filename` is on this origin, which drops an extension's, a
 *   CDN's and the opaque `Script error.` a cross-origin script raises; a `Script error.` with no
 *   stack is dropped wherever it claims to come from;
 * - a rejection whose stack names only other origins is someone else's;
 * - an island whose `mount()` rejected never reaches `unhandledrejection` (the hydration runtime
 *   catches it), so the `data-x-failed` marker is watched instead, including one set before this
 *   script ran;
 * - at most five per document and one per distinct message, the path with no query string, the
 *   build id the DOCUMENT was rendered by (`data-build` on this script's own tag), and `fetch`
 *   with `keepalive` so a report survives the tab closing;
 * - every cap is per DOCUMENT: the client router runs this script once per tab and swaps pages
 *   under it, so `NAVIGATED_EVENT` resets the count and the dedupe and rescans the new body; the
 *   dedupe key carries the path; the build is read at send time from the swapped-in
 *   `x-ultimate-build` meta (the tag's `data-build` when there is none); an island ELEMENT is
 *   reported once, so one the router carried across (`data-x-persist`) is not re-reported;
 * - it never throws and never reports itself: every listener is wrapped, the rejection of its
 *   own `fetch` is handled, and a failure raised while sending is not re-entered.
 */
export function clientErrorsScript(): string {
  const limits = CLIENT_ERRORS_LIMITS;
  return `(function(){try{
var d=document,o=location.origin,n=0,seen={},busy=0,A='${ISLAND_FAILED_ATTRIBUTE}';
var s=d.currentScript,b0=s&&s.getAttribute('data-build')||'';
function build(){var m=d.querySelector&&d.querySelector('meta[name="${CLIENT_BUILD_META}"]');return m&&m.getAttribute('content')||b0}
function cut(v,m){return typeof v==='string'?v.slice(0,m):''}
function send(k,m,st,i){if(busy||n>=${CLIENT_ERRORS_MAX_REPORTS})return;busy=1;try{
m=cut(m,${limits.message});var key=location.pathname+'|'+k+'|'+(i||'')+'|'+m;if(seen[key])return;seen[key]=1;n++;
var body={kind:k,message:m,path:cut(location.pathname,${limits.path}),build:cut(build(),${limits.build})};
st=cut(st,${limits.stack});if(st)body.stack=st;if(i)body.island=cut(i,${limits.island});
var p=fetch('${CLIENT_ERRORS_PATH}',{method:'POST',keepalive:true,credentials:'same-origin',
headers:{'content-type':'application/json'},body:JSON.stringify(body)});
if(p&&typeof p.then==='function')p.then(null,function(){})}catch(x){}finally{busy=0}}
window.addEventListener('error',function(e){try{var f=e&&e.filename;
if(typeof f!=='string'||f.indexOf(o+'/')!==0)return;var st=e.error&&e.error.stack;
if(e.message==='Script error.'&&!st)return;send('error',e.message,st)}catch(x){}});
window.addEventListener('unhandledrejection',function(e){try{var r=e&&e.reason;
var st=r&&typeof r.stack==='string'?r.stack:'';if(st&&st.indexOf(o+'/')<0)return;
send('rejection',r&&typeof r.message==='string'?r.message:String(r),st)}catch(x){}});
function isl(el){if(el&&el.getAttribute&&!el.__xr&&el.getAttribute(A)!==null){el.__xr=1;send('island',el.getAttribute(A),'',el.getAttribute('data-x-island'))}}
if(typeof MutationObserver==='function')new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){try{isl(ms[i].target)}catch(x){}}})
.observe(d.documentElement,{subtree:true,attributes:true,attributeFilter:[A]});
function scan(){var f=d.querySelectorAll('['+A+']');for(var j=0;j<f.length;j++)isl(f[j])}scan();
d.addEventListener('${NAVIGATED_EVENT}',function(){try{n=0;seen={};scan()}catch(x){}});
}catch(x){}})();
`;
}
