// The inline script the harness page runs BEFORE the island's chunk: the sealed network, the
// pinned clock and the readiness signal. A classic `<script>` in `<head>` evaluates before any
// module script, which is the only ordering in which a component's first `fetch` can be caught.
//
// A string and not a module, deliberately: this runs in the browser and the CLI has no bundler in
// the path that serves a page. `@ultimat3/testing`'s `sealNetwork()` patches THIS process's
// `globalThis.fetch` and cannot reach the page's realm.

import type { IslandRouteStub } from '@ultimat3/testing';

/**
 * Consecutive animation frames with an unchanged activity counter before a page is called ready.
 * QUIET, never zero in flight: a state whose fixture is deliberately `pending` has a request that
 * never settles, so waiting for zero hangs forever — and a fixed sleep photographs whatever a slow
 * machine had painted by then.
 */
export const QUIET_FRAMES = 3;

/** The one global the CLI reads back. Namespaced so an app's own page state can never collide. */
export const HARNESS_GLOBAL = '__xShot';

/**
 * Embedded as a JS string literal, so `<` is escaped: a `</script` anywhere inside a stub body
 * would otherwise end the tag and the rest of the page would be parsed as markup. Escaping the
 * character rather than the sequence is the total form — there is no second spelling of it.
 */
const embed = (value: unknown): string => JSON.stringify(value ?? null).replaceAll('<', '\\u003c');

export interface HarnessScriptOptions {
  readonly stubs: readonly IslandRouteStub[];
  /** The frozen instant, with an explicit offset — the manifest's `now`. */
  readonly now: string;
  /** The IANA zone every unzoned `Intl.DateTimeFormat` in the page is given. */
  readonly timeZone: string;
}

/**
 * The seal. Four egress surfaces, and an unmatched request on any of them REJECTS while recording
 * itself: a component whose fetch quietly hangs paints its own loading branch, and the picture then
 * shows a fixture gap dressed up as a real component state.
 *
 * `activity` counts a request STARTING and a request SETTLING, which is what lets readiness be
 * "nothing changed for N frames" rather than "nothing is in flight" — the second is unreachable for
 * a `pending` fixture, which is a state an author declares on purpose.
 */
const sealScript = (stubs: readonly IslandRouteStub[]): string => `
var W=window.${HARNESS_GLOBAL};var STUBS=${embed(stubs)};
function bump(){W.activity+=1}
function stubFor(method,path){var k=method.toUpperCase()+' '+path;
for(var i=0;i<STUBS.length;i+=1){if(k.indexOf(STUBS[i].match)===0)return STUBS[i].respond}
W.unstubbed.push(k);return null}
// Pathname AND query: the vocabulary says a stub's \`match\` is a PREFIX, so \`'GET /api/quota'\`
// catching \`/api/quota?window=day\` is a property of the key carrying the query, not of the match.
function pathOf(url){try{var u=new URL(url,location.href);return u.pathname+u.search}catch(e){return String(url)}}
function refuse(k){return new Error('x shot: no stub answers '+k+' — declare it in the state\\'s routes')}
function answer(respond,k){
if(respond===null)return Promise.reject(refuse(k));
if(respond.kind==='pending')return new Promise(function(){});
if(respond.kind==='offline')return Promise.reject(new TypeError('x shot: offline fixture for '+k));
return Promise.resolve(new Response(JSON.stringify(respond.body===undefined?null:respond.body),
{status:respond.status||200,headers:{'content-type':'application/json'}}))}
window.fetch=function(input,init){
var url=typeof input==='string'?input:(input&&input.url)||String(input);
var method=(init&&init.method)||(typeof input==='object'&&input&&input.method)||'GET';
var path=pathOf(url);var k=method.toUpperCase()+' '+path;
var respond=stubFor(method,path);bump();
return answer(respond,k).then(function(r){bump();return r},function(e){bump();throw e})};
// A socket and an event stream have no stub vocabulary at all, so both are refused outright and
// recorded: a live component that opened one would otherwise sit in its loading branch forever.
window.WebSocket=function(url){W.unstubbed.push('WS '+url);throw refuse('WS '+url)};
window.EventSource=function(url){W.unstubbed.push('SSE '+url);throw refuse('SSE '+url)};
var RealXHR=window.XMLHttpRequest;
window.XMLHttpRequest=function(){var xhr=new RealXHR();var open=xhr.open;
xhr.open=function(method,url){W.unstubbed.push(String(method).toUpperCase()+' '+pathOf(url));
return open.apply(xhr,arguments)};return xhr};
// Nothing here serves a service worker, and one an earlier page registered would answer requests
// this seal never sees. A no-op registration keeps a component that asks from throwing.
if(navigator.serviceWorker)navigator.serviceWorker.register=function(){return Promise.resolve(undefined)};
`;

/**
 * The clock, pinned in both halves. A harness that freezes the INSTANT and leaves the zone ambient
 * renders `12:00` on one machine and `14:00` on the next, and the review diff then reports a
 * component change that never happened — so the zone is filled in for every `Intl.DateTimeFormat`
 * built without one, and the instant replaces the argumentless `new Date()`.
 *
 * `toLocaleString` on a Date is NOT covered: it reaches the engine's own Intl and not this global.
 * The framework's rule is that no date is formatted without an explicit `timeZone`, so a component
 * obeying it is pinned; one that does not is a blind spot the verdict names rather than hides.
 */
const clockScript = (now: string, timeZone: string): string => `
var FIXED=${embed(Date.parse(now))};var ZONE=${embed(timeZone)};
class ShotDate extends Date{constructor(){if(arguments.length===0)super(FIXED);else super(...arguments)}
static now(){return FIXED}}
window.Date=ShotDate;
var RealDTF=Intl.DateTimeFormat;
function zoned(options){return options&&options.timeZone?options:Object.assign({},options,{timeZone:ZONE})}
function ShotDTF(locales,options){return new RealDTF(locales,zoned(options))}
ShotDTF.prototype=RealDTF.prototype;
ShotDTF.supportedLocalesOf=RealDTF.supportedLocalesOf.bind(RealDTF);
Intl.DateTimeFormat=ShotDTF;
`;

/**
 * Ready is quiet, not idle. Fonts first — a picture taken mid-swap photographs the fallback face —
 * then `QUIET_FRAMES` consecutive frames in which nothing started and nothing settled.
 */
const readyScript = (): string => `
var last=-1;var still=0;
function tick(){var seen=W.activity;
if(seen===last)still+=1;else{still=0;last=seen}
if(still>=${QUIET_FRAMES}){W.ready=true;return}
requestAnimationFrame(tick)}
(document.fonts?document.fonts.ready:Promise.resolve()).then(function(){requestAnimationFrame(tick)});
`;

/** The whole prelude, in the one order that works: state, seal, clock, then the readiness watch. */
export function harnessScript(options: HarnessScriptOptions): string {
  return [
    `window.${HARNESS_GLOBAL}={harness:true,activity:0,ready:false,unstubbed:[]};`,
    sealScript(options.stubs),
    clockScript(options.now, options.timeZone),
    readyScript(),
  ].join('\n');
}

/**
 * What the CLI evaluates before every capture, as one expression — `CdpPageLike.evaluate` takes
 * the string form only. Every clause is a fact a picture cannot carry: a host that never attached,
 * a mount that rejected, a box of zero pixels, a box holding nothing, a request nobody stubbed.
 *
 * `selector` is the crop target the manifest declared; the island's own host element when absent.
 */
export const readinessProbe = (selector: string): string =>
  `(function(){var W=window.${HARNESS_GLOBAL}||{};` +
  'var host=document.querySelector("[data-x-island]");' +
  `var box=document.querySelector(${JSON.stringify(selector)})||host;` +
  'var r=box?box.getBoundingClientRect():{width:0,height:0,x:0,y:0};' +
  'return{harness:W.harness===true,ready:W.ready===true,' +
  'unstubbed:(W.unstubbed||[]).slice(),' +
  'attached:host!==null&&document.body.contains(host),' +
  'mounted:host!==null&&host.hasAttribute("data-x-mounted"),' +
  'failed:host&&host.hasAttribute("data-x-failed")?host.getAttribute("data-x-failed"):null,' +
  // Children OR text: a component that renders one text node has painted, and one that mounted
  // and rendered nothing is the silence a non-zero box would otherwise read as success.
  'filled:box?(box.children.length>0||(box.textContent||"").trim().length>0):false,' +
  'box:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}};})()';
