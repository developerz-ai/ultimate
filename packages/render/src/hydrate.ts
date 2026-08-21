/**
 * The four hydration strategies, emitted as a per-island directive. `never` emits no
 * script tag and no runtime at all — that is what keeps the `site/` baseline at 0kb.
 * `interaction` replays the event that triggered the load, so a click during the fetch is
 * answered instead of swallowed.
 */

import type { HydrateStrategy } from '@ultimat3/core';
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
    `<script type="application/json" data-x-props="${directive.islandId}">` +
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
`.trim();

const RUNTIME_IDLE = `
each('[data-x-hydrate="idle"]',function(el){
var go=function(){boot(el)};
if('requestIdleCallback'in window)requestIdleCallback(go,{timeout:${IDLE_HYDRATE_TIMEOUT_MS}});else setTimeout(go,1)})
`.trim();

const RUNTIME_VISIBLE = `
each('[data-x-hydrate="visible"]',function(el){
var io=new IntersectionObserver(function(es){es.forEach(function(en){
if(en.isIntersecting){io.disconnect();boot(el)}})},{rootMargin:el.getAttribute('data-x-margin')||'200px'});
io.observe(el)})
`.trim();

// Event replay: the listener is registered before the chunk exists, records the event that
// woke the island, and re-dispatches it once mounted. Without this, the first click on a
// cold island is silently lost — the failure users read as "the button does nothing".
const RUNTIME_INTERACTION = `
each('[data-x-hydrate="interaction"]',function(el){
var evs=(el.getAttribute('data-x-events')||'click').split(' ');
var q=[],done=false;
var on=function(ev){if(done)return;q.push(ev);
boot(el).then(function(){done=true;evs.forEach(function(n){el.removeEventListener(n,on,true)});
q.forEach(function(ev){var c=new ev.constructor(ev.type,ev);ev.target.dispatchEvent(c)});q=[]})};
evs.forEach(function(n){el.addEventListener(n,on,true)})})
`.trim();

const RUNTIME_PARTS: Readonly<Record<Exclude<HydrateStrategy, 'never'>, string>> = {
  idle: RUNTIME_IDLE,
  visible: RUNTIME_VISIBLE,
  interaction: RUNTIME_INTERACTION,
};

/**
 * Emit only the runtime the page's islands actually use. A page of `never` islands gets
 * the empty string — an unused strategy must not cost a byte.
 */
export function hydrateRuntime(directives: readonly IslandDirective[]): string {
  const needed = requiredStrategies(directives);
  if (needed.size === 0) return '';
  const parts = (['idle', 'visible', 'interaction'] as const)
    .filter((strategy) => needed.has(strategy))
    .map((strategy) => RUNTIME_PARTS[strategy]);
  return `<script type="module">${RUNTIME_PRELUDE}\n${parts.join('\n')}</script>`;
}

/** Rough emitted size of the hydration runtime for a page, for the budget check. */
export function hydrateRuntimeBytes(directives: readonly IslandDirective[]): number {
  return new TextEncoder().encode(hydrateRuntime(directives)).byteLength;
}
