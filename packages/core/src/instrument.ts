// Single responsibility: the ONE instrumentation bus — `instrument()` publishes a named event,
// `subscribe()` hears it, `subscribed()` lets an emitter skip building a payload nobody reads.
// Every observer the framework has (OTLP spans and logs, metrics, `x dev`'s recorder, the `/_x`
// panels, app code) is a subscriber here; no package keeps a `set*Observer` slot of its own.

import { renderThrowable } from './error-render';
import type { InstrumentEventMap } from './instrument-events';
import { logger } from './logger';

/** Every event name the bus carries — the framework's (`INSTRUMENT_EVENTS`) and the app's own. */
export type InstrumentName = keyof InstrumentEventMap & string;

/** `entity` for `entity.row`, `render` and `render.isr` for `render.isr.regenerate`. */
type PrefixesOf<N extends string> = N extends `${infer Head}.${infer Rest}`
  ? Head | `${Head}.${PrefixesOf<Rest>}`
  : never;

/**
 * What `subscribe()` accepts: an exact name, a dot-segment prefix of one (`'entity'` hears
 * `entity.row`, `entity.bulk` and `entity.cross_tenant`; `'ent'` hears nothing and does not
 * compile), or `'*'` for everything.
 */
export type InstrumentPattern = InstrumentName | PrefixesOf<InstrumentName> | '*';

/** The names a pattern hears. */
export type MatchedName<P extends InstrumentPattern> = P extends '*'
  ? InstrumentName
  : Extract<InstrumentName, P | `${P}.${string}`>;

/** One delivered event: discriminated on `name`, so a prefix subscriber narrows with a switch. */
export type InstrumentEvent<N extends InstrumentName = InstrumentName> = {
  readonly [K in N]: { readonly name: K; readonly payload: InstrumentEventMap[K] };
}[N];

export type InstrumentHandler<P extends InstrumentPattern> = (
  event: InstrumentEvent<MatchedName<P>>,
) => void;

type AnyHandler = (event: { readonly name: string; readonly payload: unknown }) => void;

interface Subscription {
  readonly pattern: string;
  readonly handler: AnyHandler;
  /** Cleared by the unsubscribe, read per call: a dispatch in flight skips it from then on. */
  live: boolean;
}

/** Replaced, never mutated: a dispatch in flight keeps the list it started with. */
let subscriptions: readonly Subscription[] = [];
/** name → the subscriptions it reaches, in order. Dropped whole on every (un)subscribe. */
let routes = new Map<string, readonly Subscription[]>();
/** Names being dispatched on this stack — a handler re-emitting one is not re-delivered to it. */
const dispatching = new Set<string>();

const NONE: readonly Subscription[] = Object.freeze([]);

/** Failures contained since the last reset — `subscriberFailures()`. */
let failures = 0;
/** handler → the event names it has already been reported failing on: one line per pair. */
let reported = new WeakMap<AnyHandler, Set<string>>();

function matches(pattern: string, name: string): boolean {
  return pattern === '*' || pattern === name || name.startsWith(`${pattern}.`);
}

function routeOf(name: string): readonly Subscription[] {
  if (subscriptions.length === 0) return NONE;
  const known = routes.get(name);
  if (known !== undefined) return known;
  const found = subscriptions.filter((sub) => matches(sub.pattern, name));
  const route = found.length === 0 ? NONE : Object.freeze(found);
  routes.set(name, route);
  return route;
}

/**
 * Hear every event `pattern` matches. Handlers run synchronously, on the emitter's stack, in the
 * order they subscribed — so `tryUseContext()` and `currentSpanContext()` inside one answer for
 * the code that emitted. Returns the unsubscribe; calling it twice is a no-op.
 *
 * A subscriber can never break the work it observes: a handler that throws — or returns a promise
 * that rejects — is CONTAINED. The other handlers still run, the emitter never sees the failure,
 * and it is logged once per handler and event name as `instrument.subscriber_failed`. An observer
 * is not an input: a `policy.decision` subscriber cannot deny, a `mail.deliver` one cannot make a
 * delivered message look failed and get it sent twice.
 */
export function subscribe<P extends InstrumentPattern>(
  pattern: P,
  handler: InstrumentHandler<P>,
): () => void {
  const subscription: Subscription = { pattern, handler: handler as AnyHandler, live: true };
  subscriptions = [...subscriptions, subscription];
  routes = new Map();
  return () => {
    if (!subscription.live) return;
    subscription.live = false;
    subscriptions = subscriptions.filter((candidate) => candidate !== subscription);
    routes = new Map();
  };
}

/**
 * Whether anything hears `name`. An emitter asks BEFORE it builds a payload that costs something —
 * reading a row's before-image, copying bound values — so an app with no subscriber pays one map
 * read per event and allocates nothing (axiom 6).
 */
export function subscribed(name: InstrumentName): boolean {
  return routeOf(name).length > 0;
}

/**
 * Publish one event. Fired for EVERY occurrence — before, and regardless of, trace sampling — so a
 * subscriber counting statements or decisions sees unsampled traffic too.
 *
 * Re-entrancy: a handler may emit other events (a subscriber that logs emits `log.record`), but an
 * event emitted from inside a handler of the SAME name is not delivered again — that is the loop a
 * `'*'` subscriber that logs would otherwise spin forever.
 */
export function instrument<N extends InstrumentName>(
  name: N,
  payload: InstrumentEventMap[N],
): void {
  const route = routeOf(name);
  if (route.length === 0 || dispatching.has(name)) return;
  const event = { name, payload };
  dispatching.add(name);
  try {
    for (const subscription of route) {
      // Unsubscribed by an earlier handler of this same dispatch: not called again.
      if (subscription.live) deliver(subscription.handler, event);
    }
  } finally {
    dispatching.delete(name);
  }
}

function deliver(
  handler: AnyHandler,
  event: { readonly name: string; readonly payload: unknown },
): void {
  let returned: unknown;
  try {
    returned = handler(event);
  } catch (thrown) {
    contain(handler, event.name, thrown);
    return;
  }
  // The handler type says `void`, and an `async` handler still satisfies it: a rejection left
  // unhandled would take the process down from a subscriber nobody awaited.
  if (isThenable(returned)) {
    returned.then(undefined, (rejected: unknown) => contain(handler, event.name, rejected));
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function contain(handler: AnyHandler, name: string, error: unknown): void {
  failures += 1;
  const names = reported.get(handler) ?? new Set<string>();
  if (names.has(name)) return;
  names.add(name);
  reported.set(handler, names);
  try {
    logger.error('instrument.subscriber_failed', { event: name, error: renderThrowable(error) });
  } catch {
    // The logger is total; this is the belt to its braces — containment must not throw either.
  }
}

/** How many subscriber failures were contained since the last reset — every one, not only the logged. */
export function subscriberFailures(): number {
  return failures;
}

/** How many subscriptions are live — a count that climbs across a test is an unsubscribe missed. */
export function subscriberCount(): number {
  return subscriptions.length;
}

/** TEST SEAM: drop every subscription. A suite that subscribes unsubscribes; this is the backstop. */
export function resetInstrumentation(): void {
  for (const subscription of subscriptions) subscription.live = false;
  subscriptions = [];
  routes = new Map();
  dispatching.clear();
  failures = 0;
  reported = new WeakMap();
}
