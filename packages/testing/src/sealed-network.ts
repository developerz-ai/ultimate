// Sealed network. Any egress a test did not explicitly mock or allow fails the test with the URL
// and the line that fixes it. A test that quietly reaches the internet is a test that fails in CI
// for reasons nobody can reproduce — so the default is "nothing gets out". Three dials are sealed:
// `fetch` here, `WebSocket` and `Bun.connect` through `sealed-sockets.ts`, all behind one gate.

import { classifyAddress, isSelfOrigin } from '@ultimat3/core';
import { NetworkOfflineError, NetworkRaceError, NetworkSealedError } from './errors';
import { installSocketSeal } from './sealed-sockets';

export type FetchLike = typeof globalThis.fetch;

/**
 * `offline` is the cable pulled; `dropped` is the same for a request, but tells a transport its
 * connection was cut rather than closed — so it reconnects and resumes instead of resubscribing.
 */
export type NetworkState = 'online' | 'offline' | 'dropped';

export interface MockRoute {
  /** Exact URL, or a prefix ending in `*`, or a RegExp. */
  readonly match: string | RegExp;
  readonly handler: (request: Request) => Response | Promise<Response>;
}

interface SealState {
  readonly allowed: Set<string>;
  readonly mocks: MockRoute[];
  readonly seen: string[];
  original: FetchLike | undefined;
  /** `installSocketSeal`'s undo, held beside `original` so one unseal restores all three dials. */
  restoreSockets: (() => void) | undefined;
  network: NetworkState;
}

const state: SealState = {
  allowed: new Set(),
  mocks: [],
  seen: [],
  original: undefined,
  restoreSockets: undefined,
  network: 'online',
};

const matches = (route: MockRoute, url: string): boolean => {
  if (route.match instanceof RegExp) {
    // A `g`/`y` pattern's `test` resumes at `lastIndex`: without the reset, every other call missed.
    route.match.lastIndex = 0;
    return route.match.test(url);
  }
  if (route.match.endsWith('*')) return url.startsWith(route.match.slice(0, -1));
  return route.match === url;
};

const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const methodOf = (input: RequestInfo | URL, init: RequestInit | undefined): string => {
  if (init?.method !== undefined) return init.method.toUpperCase();
  if (typeof input === 'object' && 'method' in input) return input.method.toUpperCase();
  return 'GET';
};

/**
 * A raw socket to THIS machine is not egress, whichever port: it is how a test reaches the
 * scripted server it `Bun.listen`ed and the compose services the live suites run against, none of
 * which announce through `markListening`. What fails unreproducibly in CI is the internet, and a
 * loopback dial with nothing behind it fails the same way on every machine.
 */
const isThisMachine = (hostname: string): boolean => {
  if (hostname.toLowerCase() === 'localhost') return true;
  const kind = classifyAddress(hostname);
  return kind === 'loopback' || kind === 'unspecified';
};

/** The socket dials' gate: the same allow-list, offline state and record as `fetch`. No mocks — a
 *  socket test injects its transport (`connect`, `client`), it does not intercept the dial. */
const socketRefusal = (url: string, method: string): Error | undefined => {
  state.seen.push(url);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined; // Not a URL: the real constructor refuses it with its own SyntaxError.
  }
  if (isThisMachine(target.hostname)) return undefined;
  if (state.network !== 'online') {
    return new NetworkOfflineError({ url, method, mode: state.network });
  }
  if (state.allowed.has(target.host)) return undefined;
  return new NetworkSealedError({ url, method, allowed: [...state.allowed], transport: 'socket' });
};

/** Replace global fetch, `WebSocket` and `Bun.connect`. Idempotent: sealing twice keeps the one
 *  set of originals around. */
export function sealNetwork(): void {
  if (state.original !== undefined) return;
  state.original = globalThis.fetch;
  state.restoreSockets = installSocketSeal(socketRefusal);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    state.seen.push(url);
    // Ahead of the mocks on purpose: a test that mocked Stripe and then went offline is asserting
    // the offline path, and a mock that still answered would be the one thing that path never sees.
    if (state.network !== 'online') {
      throw new NetworkOfflineError({
        url,
        method: methodOf(input, init),
        mode: state.network,
      });
    }
    const mock = state.mocks.find((route) => matches(route, url));
    if (mock !== undefined) {
      return mock.handler(input instanceof Request ? input : new Request(url, init));
    }
    // A server this process booted is not egress — the port is one the kernel just handed us, so
    // there is nothing to allowlist ahead of time. Without this, a socket test's only option is to
    // unseal the network wholesale, which then hides the real egress it was meant to catch.
    const host = safeHost(url);
    if (isSelfOrigin(url) || (host !== undefined && state.allowed.has(host))) {
      const original = state.original;
      if (original === undefined) throw new NetworkRaceError();
      return original(input, init);
    }
    throw new NetworkSealedError({
      url,
      method: methodOf(input, init),
      allowed: [...state.allowed],
    });
  }) as FetchLike;
}

export function unsealNetwork(): void {
  if (state.original === undefined) return;
  globalThis.fetch = state.original;
  state.original = undefined;
  state.restoreSockets?.();
  state.restoreSockets = undefined;
}

/** Whether the patch is installed. The `network` fixture seals before going offline, so that
 *  `offline()` has teeth in a process that deliberately unsealed (`ULTIMATE_TEST_ALLOW_NET=1`). */
export const isNetworkSealed = (): boolean => state.original !== undefined;

/** The one writer of the offline gate — `createTestNetwork()`. Never call it from a test body. */
export function setNetworkState(next: NetworkState): void {
  state.network = next;
}

export const networkState = (): NetworkState => state.network;

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Let one host through for real. Deliberately per-host, never per-test-file or global. */
export function allowHost(host: string): void {
  state.allowed.add(host);
}

export function mockFetch(
  match: string | RegExp,
  handler: (request: Request) => Response | Promise<Response>,
): void {
  state.mocks.unshift({ match, handler });
}

/** Convenience for the common case: a JSON body and a status. */
export function mockJson(match: string | RegExp, body: unknown, status = 200): void {
  mockFetch(
    match,
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

/** Every URL a test attempted, in order — the fastest way to see what a failure actually called. */
export const requestedUrls = (): readonly string[] => [...state.seen];

export function resetNetwork(): void {
  state.allowed.clear();
  state.mocks.length = 0;
  state.seen.length = 0;
  state.network = 'online';
}

/** Everything `resetNetwork` clears, as a value — so a nested scope can put it back instead. */
export interface NetworkSnapshot {
  readonly allowed: readonly string[];
  readonly mocks: readonly MockRoute[];
  readonly seen: readonly string[];
  readonly network: NetworkState;
}

/**
 * Capture before a nested install, restore after — the pair `captureDeterminism` /
 * `restoreCapturedDeterminism` already ships for the clock, and for the same reason. `bun test` is
 * ONE process: a `bootApp` that ended by CLEARING this gate took the outer scope's allow-list, its
 * mocks and its offline state with it, so an outer fixture that was offline came back online
 * because an inner boot finished. Teardown restores; it never uninstalls.
 */
export const captureNetwork = (): NetworkSnapshot => ({
  allowed: [...state.allowed],
  mocks: [...state.mocks],
  seen: [...state.seen],
  network: state.network,
});

export function restoreCapturedNetwork(snapshot: NetworkSnapshot): void {
  state.allowed.clear();
  for (const host of snapshot.allowed) state.allowed.add(host);
  state.mocks.length = 0;
  state.mocks.push(...snapshot.mocks);
  state.seen.length = 0;
  state.seen.push(...snapshot.seen);
  state.network = snapshot.network;
}
