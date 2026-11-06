// Single responsibility: the browser half of real-user timings — the text of `/x-client-vitals.js`.
// `PerformanceObserver` for LCP, CLS, INP and FCP, the navigation entry for TTFB, and ONE
// `sendBeacon` when the page is hidden. Generated as a string so a document with the feature off
// carries no byte of it; the route that receives the beacon is `client-vitals-route.ts`.

import { finiteOption } from '@ultimat3/core';

/** Named by every document on a surface `clientErrors.vitals.surfaces` lists. */
export const CLIENT_VITALS_SCRIPT_PATH = '/x-client-vitals.js';

/** Where the beacon lands. Beside `/_client-errors`: a framework route no page can shadow. */
export const CLIENT_VITALS_PATH = '/_client-vitals';

/** The timings a beacon may carry. CLOSED: the route drops any other name. */
export const CLIENT_VITAL_NAMES = ['lcp', 'fcp', 'inp', 'ttfb', 'cls'] as const;

export type ClientVitalName = (typeof CLIENT_VITAL_NAMES)[number];

/**
 * The script. Rules it keeps, each one a line below:
 * - sampled ONCE per page view, here, against `rate`: a page view that rolled out observes nothing;
 * - every timing is milliseconds from navigation start; CLS is the largest session window (gaps
 *   under 1 s, windows capped at 5 s), counting no shift that followed input; INP is the slowest
 *   interaction the view saw, which is the metric's own reading under 50 interactions;
 * - one beacon per page view, on the first `visibilitychange` to hidden (or `pagehide`), naming the
 *   path the view LOADED at — the client router swaps the path under a tab, and a timing taken on
 *   one page must not be filed under the next;
 * - a `text/plain` blob: `sendBeacon` with a JSON content type is a preflighted request some
 *   browsers drop silently, and the route parses the body whatever it was labelled;
 * - it never throws: an observer type this browser lacks is skipped, and every callback is wrapped.
 */
export function clientVitalsScript(sampleRate: number): string {
  // Interpolated into script text: a number `config.ts` already screened, screened again here
  // because a `NaN` would print as an identifier and sample every view or none.
  const rate = finiteOption('clientVitalsScript', 'sampleRate', sampleRate);
  return `(function(){try{
if(!(Math.random()<${rate})||typeof PerformanceObserver!=='function')return;
var v={},p=location.pathname,sent=0,cs=0,cw=0,cf=0,cl=0;
function ob(t,f,o){try{new PerformanceObserver(function(l){try{l.getEntries().forEach(f)}catch(x){}}).observe(o||{type:t,buffered:true})}catch(x){}}
ob('largest-contentful-paint',function(e){v.lcp=e.startTime});
ob('paint',function(e){if(e.name==='first-contentful-paint')v.fcp=e.startTime});
ob('event',function(e){if(e.interactionId&&(!(v.inp>=e.duration)))v.inp=e.duration},{type:'event',buffered:true,durationThreshold:16});
ob('layout-shift',function(e){if(e.hadRecentInput)return;var t=e.startTime;
if(cw&&t-cl<1000&&t-cf<5000){cw+=e.value}else{cw=e.value;cf=t}cl=t;if(cw>cs)cs=cw;v.cls=cs});
try{var n=performance.getEntriesByType('navigation')[0];if(n&&n.responseStart>0)v.ttfb=n.responseStart}catch(x){}
function send(){try{if(sent)return;sent=1;
if(navigator.sendBeacon)navigator.sendBeacon('${CLIENT_VITALS_PATH}',new Blob([JSON.stringify({path:p,vitals:v})],{type:'text/plain'}))}catch(x){}}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')send()});
addEventListener('pagehide',send);
}catch(x){}})();
`;
}

/** The tag a document on a listed surface carries. */
export const clientVitalsHead = (): string =>
  `<script src="${CLIENT_VITALS_SCRIPT_PATH}" defer></script>`;
