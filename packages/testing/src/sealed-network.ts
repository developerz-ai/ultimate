// Sealed network. Any egress a test did not explicitly mock or allow fails the test with the URL
// and the line that fixes it. A test that quietly reaches the internet is a test that fails in CI
// for reasons nobody can reproduce — so the default is "nothing gets out".

import { isSelfOrigin } from '@ultimat3/core';
import { NetworkOfflineError, NetworkRaceError, NetworkSealedError } from './errors';

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
  network: NetworkState;
}

const state: SealState = {
  allowed: new Set(),
  mocks: [],
  seen: [],
  original: undefined,
  network: 'online',
};

const matches = (route: MockRoute, url: string): boolean => {
  if (route.match instanceof RegExp) return route.match.test(url);
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

/** Replace global fetch. Idempotent: sealing twice keeps the one original around. */
export function sealNetwork(): void {
  if (state.original !== undefined) return;
  state.original = globalThis.fetch;
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
