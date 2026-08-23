// What a live client IS on the server: one that serves the first render and opens no socket.
//
// The rule it exists for is `@ultimat3/ui`'s, one package over — no runtime and no DOM is a SERVER
// RENDER, and a server render gets an honest account of itself rather than a throw. A page whose
// whole body reads a live query could not server-render at all before this: `useConnection()` threw
// `X_LIVE_CLIENT_MISSING` and the route answered 500 (issue #271).
//
// It implements `LiveClientLike` and imports NO connection lifecycle — no `LiveClient`, no
// heartbeat, no wire protocol. Measured: reaching the class from here costs every island that
// calls `useLive` 18 kB it can never run.

import type { LiveClientLike, LiveHandle, LiveQueryRef, SignalFactory } from './client-contract';
import { ServerRenderLiveError } from './errors';
import type { JsonValue, Row } from './json';
import type { LiveState } from './live-rows';

/**
 * A signal that never changes, because nothing on the server can change it: one render, one pass,
 * no reactive runtime. The setter is kept rather than dropped so a caller that writes through it
 * reads its own write back — a signal that swallowed writes would be a different lie.
 */
const inertSignal: SignalFactory = <T>(initial: T): [() => T, (next: T) => void] => {
  let held = initial;
  return [
    (): T => held,
    (next: T): void => {
      held = next;
    },
  ];
};

/** Frozen, so a handle a page holds cannot be turned into a result set by writing to it. */
const NO_ROWS: readonly Row[] = Object.freeze([]);

/** Nothing was subscribed, so nothing is released — and a teardown never fails a render. */
const releaseNothing = (): void => undefined;

/**
 * The handle a server render gets for a live query: `loading`, never `offline` and never `live`.
 *
 * That is the one honest state — the rows arrive over a socket this render does not have, so the
 * page's own loading fallback is what the document carries until hydration replaces it. `offline`
 * would be read as a SETTLED answer (`state() !== 'loading'` is the gate `examples/dummy`'s feed
 * uses), so an empty result set would render "you have no posts" for a feed that has some.
 */
function serverRenderHandle<R extends Row>(): LiveHandle<R> {
  return {
    rows: () => NO_ROWS as readonly R[],
    state: (): LiveState => 'loading',
    cursor: () => null,
    unsubscribe: releaseNothing,
    [Symbol.dispose]: releaseNothing,
  };
}

/**
 * Every member that can only mean "talk to the socket" refuses; every member a render READS
 * answers what a server render actually is.
 *
 * `connected: true` is not a lie about the socket — `useConnection().offline` is a banner about
 * THIS visitor's connectivity, and the request being served is the proof it is up. Answering
 * `false` would server-render "you are offline" into every document, for a reader who is not, and
 * then remove it on hydrate.
 *
 * It registers nothing, which is what makes ONE instance per process safe under concurrent
 * renders: a client that kept a registration per `useLive` would grow by one entry per request,
 * forever, and hold a row window with each.
 */
function build(): LiveClientLike {
  return {
    signal: inertSignal,
    queue: undefined,
    connected: true,
    reconnectAt: () => null,
    appUpdateAvailable: () => null,
    useLive: <R extends Row>(_query: LiveQueryRef, _input: JsonValue): LiveHandle<R> =>
      serverRenderHandle<R>(),
    mutate: (): Promise<void> => {
      throw new ServerRenderLiveError({ operation: 'mutate()' });
    },
    drain: (): Promise<void> => {
      throw new ServerRenderLiveError({ operation: 'drain()' });
    },
    // A listener is accepted and never called: nothing on the server can change a queue that does
    // not exist. Refusing here would break `setLiveClient`, which registers one unconditionally.
    onQueueChange: () => releaseNothing,
  };
}

let held: LiveClientLike | null = null;

/** ONE per process, built on first use. It holds nothing per request — see `build` above. */
export function serverRenderLiveClient(): LiveClientLike {
  held ??= build();
  return held;
}
