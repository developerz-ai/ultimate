// Sealed network: egress a test did not mock or allow fails with the URL and the line that fixes
// it, so nothing reaches the internet unreproducibly. `fetch` here, `WebSocket`/`Bun.connect` via
// `sealed-sockets.ts`, name resolution via `sealed-dns.ts` — one gate, one set of mocks and allows.

import { isSelfOrigin, peerAddressClass } from '@ultimat3/core';
import { NetworkOfflineError, NetworkRaceError, NetworkSealedError } from './errors';
import type { MockHandler, MockRoute } from './mock-route';
import { mockRoute, routeMatches, routeNamesHost } from './mock-route';
import type { LoggedRequest } from './request-log';
import { hasStreamBody, headersOf, isOpenEnded, readBody, requestProbe } from './request-log';
import type { DnsVerdict } from './sealed-dns';
import { ADDRESS_QUERIES, installDnsSeal } from './sealed-dns';
import { installSocketSeal } from './sealed-sockets';

export type FetchLike = typeof globalThis.fetch;

/**
 * `offline` is the cable pulled; `dropped` is the same for a request, but tells a transport its
 * connection was cut rather than closed — so it reconnects and resumes instead of resubscribing.
 */
export type NetworkState = 'online' | 'offline' | 'dropped';

interface SealState {
  readonly allowed: Set<string>;
  readonly mocks: MockRoute[];
  readonly log: LoggedRequest[];
  original: FetchLike | undefined;
  /** `installSocketSeal`'s undo, held beside `original` so one unseal restores all three dials. */
  restoreSockets: (() => void) | undefined;
  /** `installDnsSeal`'s undo, likewise. */
  restoreDns: (() => void) | undefined;
  network: NetworkState;
}

const state: SealState = {
  allowed: new Set(),
  mocks: [],
  log: [],
  original: undefined,
  restoreSockets: undefined,
  restoreDns: undefined,
  network: 'online',
};

const dialListeners = new Set<(call: LoggedRequest) => void>();

/**
 * Each dial as it is logged, synchronously and in the dialler's own async context — so a listener
 * can tell whose call it was (`exercise-report.ts`'s room). Internal: never on the barrel.
 */
export function onDial(listener: (call: LoggedRequest) => void): () => void {
  dialListeners.add(listener);
  return () => {
    dialListeners.delete(listener);
  };
}

const logDial = (call: LoggedRequest): void => {
  state.log.push(call);
  for (const listener of dialListeners) listener(call);
};

/**
 * What a mocked host resolves to: one `public` address (`classifyAddress`), so an SSRF screen
 * passes it, and never a host network — a screen refuses those. Never dialled: a dial pinned to it
 * carries the name in `Host`, which is how the mock answers it (`mock-route.ts`'s `namedUrl`).
 */
export const MOCKED_HOST_ADDRESS = '11.11.11.11';

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
  const kind = peerAddressClass(hostname);
  return kind === 'loopback' || kind === 'unspecified';
};

/** The socket dials' gate: the same allow-list, offline state and record as `fetch`. No mocks — a
 *  socket test injects its transport (`connect`, `client`), it does not intercept the dial. */
const socketRefusal = (url: string, method: string): Error | undefined => {
  logDial({ method, url, headers: {}, body: null });
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined; // Not a URL: the real constructor refuses it with its own SyntaxError.
  }
  // Offline before loopback, the order `fetch` checks in: offline cuts EVERY dial, this machine's
  // included, or a socket would reach a host the same test's `fetch` is refused.
  if (state.network !== 'online') {
    return new NetworkOfflineError({ url, method, mode: state.network });
  }
  if (isThisMachine(target.hostname)) return undefined;
  if (state.allowed.has(target.host)) return undefined;
  return new NetworkSealedError({ url, method, allowed: [...state.allowed], transport: 'socket' });
};

/** A host the allow-list names, whatever port it was allowed on: a lookup carries no port. */
const isAllowedName = (hostname: string): boolean =>
  [...state.allowed].some((host) => safeHost(`https://${host}`)?.split(':')[0] === hostname);

/**
 * The resolver's gate, in `fetch`'s order: offline refuses every name, this machine and an allowed
 * host resolve for real, as does a `LOOKUP` of an address literal (no query leaves; a `REVERSE` of
 * one does), a host a mock answers resolves to `MOCKED_HOST_ADDRESS` for an address query only,
 * the rest is `X_TEST_NETWORK_SEALED` — the code `fetch` would have raised a moment later.
 */
const dnsVerdict = (hostname: string, query: string): DnsVerdict => {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const url = `dns://${name}`;
  const method = query === 'LOOKUP' || query === 'REVERSE' ? query : `RESOLVE ${query}`;
  if (state.network !== 'online') {
    return { refused: new NetworkOfflineError({ url, method, mode: state.network }) };
  }
  const literal = query === 'LOOKUP' && peerAddressClass(name) !== undefined;
  if (isThisMachine(name) || literal || isAllowedName(name)) return { real: true };
  if (ADDRESS_QUERIES.has(query) && state.mocks.some((route) => routeNamesHost(route, name))) {
    return { answer: [MOCKED_HOST_ADDRESS] };
  }
  const allowed = [...state.allowed];
  // A record no mock answers (MX, TXT, a reverse) is lifted by `allowHost` alone: say that first.
  const transport = ADDRESS_QUERIES.has(query) ? 'dns' : 'dns-record';
  return { refused: new NetworkSealedError({ url, method, allowed, transport }) };
};

/** Replace global fetch, `WebSocket`, `Bun.connect` and the resolvers. Idempotent: sealing twice
 *  keeps the one set of originals around. */
export function sealNetwork(): void {
  if (state.original !== undefined) return;
  state.original = globalThis.fetch;
  state.restoreSockets = installSocketSeal(socketRefusal);
  state.restoreDns = installDnsSeal(dnsVerdict);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = methodOf(input, init);
    const probe = requestProbe(input, init);
    // In the log before the first await, so concurrent calls keep their order; every verdict below
    // is reached before the body is awaited too, so a call is judged by the state it was made in.
    const call = { method, url, headers: headersOf(probe), body: null as string | null };
    logDial(call);
    const openEnded = isOpenEnded(input, init);
    /** A finite body is in the entry when `fetch` settles; an open-ended one, once it ends. */
    const logBody = async (source: Request | undefined): Promise<void> => {
      const read = readBody(source).then((body) => {
        call.body = body;
      });
      if (!openEnded) await read;
    };
    // Ahead of the mocks on purpose: a test that mocked Stripe and then went offline is asserting
    // the offline path, and a mock that still answered would be the one thing that path never sees.
    if (state.network !== 'online') {
      const mode = state.network;
      await logBody(probe);
      throw new NetworkOfflineError({ url, method, mode });
    }
    const mock = state.mocks.find((route) => routeMatches(route, call));
    if (mock !== undefined) {
      const request =
        input instanceof Request && init === undefined ? input : new Request(input, init);
      // The probe left a stream out, and a mock is the one consumer that cannot lose backpressure.
      const logged = hasStreamBody(init) ? request.clone() : probe;
      // Asked before the body is awaited: an answer list goes in CALL order, so a slow POST made
      // first cannot let a later GET take its 503. A thrown answer rejects; it is awaited below.
      const answered = (async () => mock.handler(request))();
      answered.catch(() => undefined);
      await logBody(logged);
      return answered;
    }
    // A server this process booted is not egress — the port is one the kernel just handed us, so
    // there is nothing to allowlist ahead of time. Without this, a socket test's only option is to
    // unseal the network wholesale, which then hides the real egress it was meant to catch.
    const host = safeHost(url);
    const passes = isSelfOrigin(url) || (host !== undefined && state.allowed.has(host));
    const allowed = [...state.allowed];
    const original = state.original;
    if (passes) {
      if (original === undefined) throw new NetworkRaceError();
      // `(input, init)` as handed: `tls`, `unix` and `proxy` are Bun's own and no Request holds them.
      // Dialled before the body is read, so a stream's consumer is the real server, not the log.
      const dialled = original(input, init);
      dialled.catch(() => undefined);
      await logBody(probe);
      return dialled;
    }
    await logBody(probe);
    throw new NetworkSealedError({ url, method, allowed });
  }) as FetchLike;
}

export function unsealNetwork(): void {
  if (state.original === undefined) return;
  globalThis.fetch = state.original;
  state.original = undefined;
  state.restoreSockets?.();
  state.restoreSockets = undefined;
  state.restoreDns?.();
  state.restoreDns = undefined;
}

/** Whether the patch is installed. The `network` fixture seals before going offline, so that
 *  `offline()` has teeth in a process that deliberately unsealed (`ULTIMATE_TEST_ALLOW_NET=1`). */
export const isNetworkSealed = (): boolean => state.original !== undefined;

/** The one writer of the offline gate — `testNetwork()`. Never call it from a test body. */
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

/**
 * `match` is a URL, a prefix ending in `*` or a RegExp, every verb; a string may name one verb first
 * (`'POST https://…'`). `answer` is a handler, or a list answered in order with the last repeated,
 * where an `Error` is thrown: a 503-then-200 retry test is one registration and no counter.
 */
export function mockFetch(
  match: string | RegExp,
  answer: MockHandler | readonly (Response | Error)[],
): void {
  state.mocks.unshift(mockRoute(match, answer));
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

/** Every dial a test attempted, in order, refused ones included — what it sent, and to whom. */
export const requestLog = (): readonly LoggedRequest[] => [...state.log];

export function resetNetwork(): void {
  state.allowed.clear();
  state.mocks.length = 0;
  state.log.length = 0;
  state.network = 'online';
}

/** Everything `resetNetwork` clears, as a value — so a nested scope can put it back instead. */
export interface NetworkSnapshot {
  readonly allowed: readonly string[];
  readonly mocks: readonly MockRoute[];
  readonly log: readonly LoggedRequest[];
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
  log: [...state.log],
  network: state.network,
});

export function restoreCapturedNetwork(snapshot: NetworkSnapshot): void {
  state.allowed.clear();
  for (const host of snapshot.allowed) state.allowed.add(host);
  state.mocks.length = 0;
  state.mocks.push(...snapshot.mocks);
  state.log.length = 0;
  state.log.push(...snapshot.log);
  state.network = snapshot.network;
}
