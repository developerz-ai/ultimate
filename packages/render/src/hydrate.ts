/**
 * The four hydration strategies, emitted as a per-island directive. `never` emits no
 * script tag and no runtime at all — that is what keeps the `site/` baseline at 0kb.
 * `interaction` replays the event that triggered the load, so a click during the fetch is
 * answered instead of swallowed.
 */

import type { HydrateStrategy } from '@ultimat3/core';
import { HYDRATE_STRATEGIES } from '@ultimat3/core';
import { escapeAttribute, escapeJsonContent } from './html';

export interface IslandDirective {
  /** Unique per INSTANCE: two of the same island on a page need two prop bags to find. */
  readonly islandId: string;
  /**
   * The client entry this instance came from — the unit a bundle is measured in and a budget
   * counts. Optional only because it arrived after `islandId`; `island()` always sets it.
   */
  readonly moduleId?: string;
  readonly strategy: HydrateStrategy;
  /** Build-id-immutable module URL for this island's chunk. */
  readonly entry: string;
  /** Serialized props; must be JSON. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Events replayed for `interaction`. */
  readonly events?: readonly string[];
  /** `rootMargin` for `visible`. */
  readonly rootMargin?: string;
}

export const DEFAULT_REPLAY_EVENTS = ['click', 'input', 'change', 'submit', 'keydown'] as const;

/**
 * How long `idle` waits before hydrating anyway. Exported because a second reader exists and it
 * has to agree: `x shot` leaves the page alone for this long before it photographs it, and a
 * settle shorter than this timeout reports an unhydrated page for one that hydrates perfectly.
 * The runtime string below interpolates it — two copies of one number is the drift axiom 2 refuses.
 */
export const IDLE_HYDRATE_TIMEOUT_MS = 2_000;

/**
 * Set by the runtime when the island's `mount()` RESOLVED. `el.__x` is set when `import()` is
 * called, so it answers "the chunk was requested" and nothing more — three facts (declared,
 * importing, running) had two observables between them, and the missing one is the half that gates.
 */
export const ISLAND_MOUNTED_ATTRIBUTE = 'data-x-mounted';

/**
 * Set by the runtime when `mount()` REJECTED, to the error's message. A failed island and one still
 * loading are the two states an agent most needs to tell apart, and with a success marker alone
 * they are the same absence.
 */
export const ISLAND_FAILED_ATTRIBUTE = 'data-x-failed';

/**
 * The island's markup wrapper. `never` gets attributes only, so the HTML is inert and the
 * runtime below is never emitted for that island.
 */
export function emitIslandAttributes(directive: IslandDirective): string {
  // `html.ts`'s escaper, not raw interpolation: a `"` in any of these values closes the attribute
  // and the rest of the string is markup. Author-controlled today — which is why it costs nothing
  // to route through the ONE escaper now, rather than after a build id or a prop-derived margin
  // starts carrying something the author did not type.
  const attr = (name: string, value: string): string => `${name}="${escapeAttribute(value)}"`;
  const attrs = [
    attr('data-x-island', directive.islandId),
    attr('data-x-hydrate', directive.strategy),
  ];
  if (directive.strategy !== 'never') {
    attrs.push(attr('data-x-entry', directive.entry));
    if (directive.rootMargin !== undefined) {
      attrs.push(attr('data-x-margin', directive.rootMargin));
    }
    if (directive.events !== undefined && directive.events.length > 0) {
      attrs.push(attr('data-x-events', directive.events.join(' ')));
    }
  }
  return attrs.join(' ');
}

/**
 * Props travel as a typed JSON script tag, never as an attribute (quoting hazards). The body is
 * escaped by `html.ts`'s one JSON escaper — this file had its own partial copy, and a second
 * escaper is how one of them ends up missing a character.
 */
export function emitIslandProps(directive: IslandDirective): string {
  if (directive.props === undefined || directive.strategy === 'never') return '';
  return (
    // The id goes through the SAME escaper every other attribute in this file does. Safe today —
    // `islandModuleId` reduces to `[a-z0-9-]` — which is exactly why it costs nothing to route it
    // now, rather than after an id starts being derived from something an author did not type.
    `<script type="application/json" data-x-props="${escapeAttribute(directive.islandId)}">` +
    `${escapeJsonContent(JSON.stringify(directive.props))}</script>`
  );
}

/** Strategies that need runtime support. `never` is absent by construction. */
export function requiredStrategies(
  directives: readonly IslandDirective[],
): ReadonlySet<Exclude<HydrateStrategy, 'never'>> {
  const set = new Set<Exclude<HydrateStrategy, 'never'>>();
  for (const directive of directives) {
    if (directive.strategy !== 'never') set.add(directive.strategy);
  }
  return set;
}

// `el.__x` holds the boot PROMISE, not a boolean flag: it is still "already booting" for the
// once-only guard, and a second caller now waits for the same mount instead of being handed a
// resolved promise. As a flag, a second click during the chunk's load short-circuited to
// `Promise.resolve()`, and the interaction runtime flushed its replay queue into an island that
// had not mounted — the events went to nothing and the listeners were already removed.
//
// The mount markers are what make the boot promise's OUTCOME readable from the DOM — by `x shot`,
// by an app's own test, by a human in devtools. `el.__x` exists from the moment `import()` is
// called, so it cannot tell a chunk that is still downloading from one whose `mount()` threw.
// The rejection handler rethrows: swallowing it would resolve `el.__x`, and the interaction
// runtime below would then flush its replay queue into an island that never mounted — the bug
// `el.__x`-as-a-promise was introduced to fix, reintroduced one layer further out.
const RUNTIME_PRELUDE = `
function boot(el){var e=el.getAttribute('data-x-entry');
if(!e)return Promise.resolve();if(el.__x)return el.__x;
var p=document.querySelector('script[data-x-props="'+el.getAttribute('data-x-island')+'"]');
var props=p?JSON.parse(p.textContent||'{}'):{};
return el.__x=import(e).then(function(m){return m.mount(el,props)}).then(
function(r){el.setAttribute('${ISLAND_MOUNTED_ATTRIBUTE}','');return r},
function(x){el.setAttribute('${ISLAND_FAILED_ATTRIBUTE}',x&&x.message||'1');throw x})}
function each(s,f){Array.prototype.forEach.call(document.querySelectorAll(s),f)}
function hush(){}
`.trim();
// `hush` above: `boot` rethrows, so every runtime below has to terminate the chain it starts or
// the page reports an unhandled rejection for a failure it already recorded on the element.

const RUNTIME_IDLE = `
each('[data-x-hydrate="idle"]',function(el){
var go=function(){boot(el).catch(hush)};
if('requestIdleCallback'in window)requestIdleCallback(go,{timeout:${IDLE_HYDRATE_TIMEOUT_MS}});else setTimeout(go,1)})
`.trim();

const RUNTIME_VISIBLE = `
each('[data-x-hydrate="visible"]',function(el){
var io=new IntersectionObserver(function(es){es.forEach(function(en){
if(en.isIntersecting){io.disconnect();boot(el).catch(hush)}})},{rootMargin:el.getAttribute('data-x-margin')||'200px'});
io.observe(el)})
`.trim();

// Event replay: the listener is registered before the chunk exists, records the event that
// woke the island, and re-dispatches it once mounted. Without this, the first click on a
// cold island is silently lost — the failure users read as "the button does nothing".
//
// `aim` is WHERE it is re-dispatched, and it is not `ev.target`. An island's `mount` opens with
// `el.textContent = ''` — the documented idiom, and what `settings`, `feed` and `like` all do — so
// by the time the replay runs, the node the visitor actually pressed has been detached and a
// `dispatchEvent` on it reaches nothing: "the button does nothing on the first press, and works on
// the second", which is indistinguishable from a slow network and is never reported as a bug.
//
// The runtime CAN tell the two mounts apart, per event, and that is what makes a repair possible
// instead of a refusal: `el.contains(ev.target)` after the mount answers "did this mount keep the
// node I caught the event on". Kept → replay there, which is what a takeover-style island
// (`contact-sales.island.tsx` attaches to the server's own form) needs.
//
// Replaced → the honest target is where the event would land NOW, so a pointer event is
// hit-tested again with `elementFromPoint`. That is the same answer the browser would have given
// had the visitor pressed a moment later, and it reaches a fresh descendant's own handler —
// dispatching at the island ROOT does not, because Solid's delegated listener sits on `document`
// and walks UP from the target (`solid-js/web`'s `eventHandler`), so a handler on a child of the
// root is never visited. The root is the last resort, not the repair: it is where an event with no
// coordinates goes (a `keydown` has no `clientX`), and where a hit landing outside this island goes
// — synthesizing a click on an element the visitor never pressed is worse than losing the replay.
// `typeof` and not `ev.clientX||ev.clientY`, because (0, 0) is a coordinate.
//
// `off` is BOTH arms of the `then`, and the rejection arm is the reason it is a named function.
// `boot` rethrows on purpose (see the prelude), so `el.__x` holds a rejected promise from the
// first failed mount onward — and a `.then` with no rejection handler makes a fresh rejected
// promise out of it on EVERY event, i.e. one unhandled rejection per user click, forever. The
// queue was the second half: nothing ever set `done`, so the listeners stayed attached and `q`
// grew by one retained `Event` — each holding a live `target` — per click, for an island that
// will never mount. Swallowing here loses no signal: the DOM already carries the failure as
// `data-x-failed`, which is the documented observable.
const RUNTIME_INTERACTION = `
function aim(el,ev){var t=ev.target;if(t&&el.contains(t))return t;
var x=ev.clientX,h=typeof x==='number'?document.elementFromPoint(x,ev.clientY):null;
return h&&el.contains(h)?h:el}
each('[data-x-hydrate="interaction"]',function(el){
var evs=(el.getAttribute('data-x-events')||'click').split(' ');
var q=[],done=false;
var off=function(){done=true;evs.forEach(function(n){el.removeEventListener(n,on,true)});q=[]};
var on=function(ev){if(done)return;q.push(ev);
boot(el).then(function(){var r=q;off();
r.forEach(function(ev){var c=new ev.constructor(ev.type,ev);aim(el,ev).dispatchEvent(c)})},off)};
evs.forEach(function(n){el.addEventListener(n,on,true)})})
`.trim();

const RUNTIME_PARTS: Readonly<Record<Exclude<HydrateStrategy, 'never'>, string>> = {
  idle: RUNTIME_IDLE,
  visible: RUNTIME_VISIBLE,
  interaction: RUNTIME_INTERACTION,
};

/**
 * Emission order, and the order the subsets below are enumerated in. Derived from core's one
 * declaration of the vocabulary, never restated: a second literal of this set is what
 * `bun run render-modes` refuses, and it refuses it on the MEMBERS, not on the name.
 */
const RUNTIME_ORDER: readonly Exclude<HydrateStrategy, 'never'>[] = HYDRATE_STRATEGIES.filter(
  (strategy): strategy is Exclude<HydrateStrategy, 'never'> => strategy !== 'never',
);

/**
 * The TEXT of the runtime script for exactly these strategies — the body a CSP `script-src` hash
 * is taken over. Split out of `hydrateRuntime` so the served document and the policy that admits
 * it read one function: a second copy of this concatenation is a hash that stops matching the
 * moment the runtime changes, and the failure it produces is an island that never boots on a page
 * that otherwise looks correct.
 */
const runtimeBody = (needed: ReadonlySet<Exclude<HydrateStrategy, 'never'>>): string =>
  [
    RUNTIME_PRELUDE,
    ...RUNTIME_ORDER.filter((strategy) => needed.has(strategy)).map(
      (strategy) => RUNTIME_PARTS[strategy],
    ),
  ].join('\n');

/**
 * Every body `hydrateRuntime` can emit: one per non-empty subset of the three strategies, seven in
 * all, deterministic. A policy that admits inline script by HASH has to enumerate them before the
 * socket opens — the alternative is a per-response nonce, which a `render: 'static'` page (a file
 * on disk) can never receive. Enumerated rather than derived from the route table because the
 * runtime is a function of the SET a document needs, and a table read at boot cannot answer for
 * a document assembled later.
 */
export const HYDRATE_RUNTIME_BODIES: readonly string[] = Array.from(
  { length: 2 ** RUNTIME_ORDER.length - 1 },
  (_unused, index) =>
    runtimeBody(new Set(RUNTIME_ORDER.filter((_s, bit) => (((index + 1) >> bit) & 1) === 1))),
);

/**
 * Emit only the runtime the page's islands actually use. A page of `never` islands gets
 * the empty string — an unused strategy must not cost a byte.
 */
export function hydrateRuntime(directives: readonly IslandDirective[]): string {
  const needed = requiredStrategies(directives);
  if (needed.size === 0) return '';
  return `<script type="module">${runtimeBody(needed)}</script>`;
}

/** Rough emitted size of the hydration runtime for a page, for the budget check. */
export function hydrateRuntimeBytes(directives: readonly IslandDirective[]): number {
  return new TextEncoder().encode(hydrateRuntime(directives)).byteLength;
}
