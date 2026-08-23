// The shared in-flight JWKS refresh, on its own: a cold cache under load must be ONE outbound
// request, the slot must be free again the instant that request settles — rejection included — a
// refresh that NEVER settles must not hold the slot for ever, and the late answer from one the
// client gave up on must not land on top of the key set that replaced it.

import { describe, expect, test } from 'bun:test';
import type { Scheduler } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import { createJwksClient } from './jwks';

const NOW = new Date('2026-08-16T12:00:00.000Z');

/** A `fetch` whose every call is held open until a test hands it a body. */
function heldFetch(): {
  readonly calls: number;
  fetch: () => Promise<Response>;
  settle(index: number, body: unknown): void;
  fail(index: number, reason: unknown): void;
} {
  const pending: Array<{ resolve: (value: Response) => void; reject: (reason: unknown) => void }> =
    [];
  return {
    get calls(): number {
      return pending.length;
    },
    fetch: (): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    settle(index, body): void {
      pending[index]?.resolve(new Response(JSON.stringify(body)));
    },
    fail(index, reason): void {
      pending[index]?.reject(reason);
    },
  };
}

/**
 * Every refusal here is `X_OAUTH_TOKEN_INVALID` — the key set served is empty, and only the COUNT
 * of outbound requests is asserted. Attached at the CALL, never at the await: a rejection with no
 * handler yet is an unhandled rejection the runner reports as this file's failure.
 */
const swallow = (call: Promise<unknown>): Promise<void> =>
  call.then(
    () => undefined,
    () => undefined,
  );

/** A macrotask turn: long enough for every queued continuation to have run. */
const flush = async (): Promise<void> => {
  await new Promise<void>((done) => {
    setTimeout(done, 0);
  });
};

/** Captures the deadline the client asked for; the test, not the clock, decides when it fires. */
interface Timer {
  readonly schedule: Scheduler;
  /** The delay the client asked for, or `undefined` if it scheduled nothing. */
  readonly ms: number | undefined;
  fire(): void;
}

const controlledTimer = (): Timer => {
  let ms: number | undefined;
  let pending = (): void => {};
  return {
    schedule: (fn, delay) => {
      ms = delay;
      pending = fn;
      return (): void => {
        pending = (): void => {};
      };
    },
    get ms(): number | undefined {
      return ms;
    },
    fire(): void {
      pending();
    },
  };
};

describe('the JWKS refresh is single-flighted', () => {
  test('N concurrent cold callers issue ONE outbound request', async () => {
    const clock = frozenClock(NOW);
    const served = heldFetch();
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      fetch: served.fetch,
    });

    const callers = Array.from({ length: 20 }, () => swallow(keys.keyFor('k1', 'RS256')));
    await flush();
    expect(served.calls).toBe(1);

    served.settle(0, { keys: [] });
    await Promise.all(callers);
    expect(served.calls).toBe(1);
  });

  // The slot is cleared by ASSIGNMENT (`inflight = null` inside a `.finally`), not by identity —
  // so the question is whether a slow refresh can clear a slot a LATER refresh already took.
  // It cannot, and this test is the shape of the reason: the ONLY writer that puts a promise in
  // the slot is a caller that found it empty, and the slot is emptied by the incumbent's own
  // `.finally`, which runs before any such caller can exist. So a caller arriving at any point
  // before that — including after the transport has answered but before the refresh has finished
  // parsing and importing — JOINS the incumbent, and a replacement only ever starts on an empty
  // slot. Two generations, five callers, and never a third request.
  test('a caller joins the refresh in the slot; the next generation starts only once it is free', async () => {
    const clock = frozenClock(NOW);
    const served = heldFetch();
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      ttlMs: 60_000,
      fetch: served.fetch,
    });

    const first = swallow(keys.keyFor('k1', 'RS256'));
    await flush();
    const joiner = swallow(keys.keyFor('k1', 'RS256'));
    await flush();
    expect(served.calls).toBe(1);

    // The transport has answered, but the refresh is still reading the body and importing keys.
    // Past the TTL too, so nothing here is served from cache — and still one request, because the
    // slot is occupied. This is the window a clobber would have to live in, and it has no room.
    served.settle(0, { keys: [] });
    clock.advance(120_000);
    const midSettle = swallow(keys.keyFor('k2', 'RS256'));
    expect(served.calls).toBe(1);

    await Promise.all([first, joiner, midSettle]);

    // Slot free, incumbent's clear already run: now a refresh starts, and a concurrent caller
    // joins THAT one.
    const second = swallow(keys.keyFor('k2', 'RS256'));
    await flush();
    const lateJoiner = swallow(keys.keyFor('k2', 'RS256'));
    await flush();
    expect(served.calls).toBe(2);

    served.settle(1, { keys: [] });
    await Promise.all([second, lateJoiner]);
    // Two generations, two requests. A live slot dropped would show as a third; a settled one left
    // behind would show as a caller resolving against a key set nothing fetched for it.
    expect(served.calls).toBe(2);
  });

  test('a REJECTED refresh clears the slot, so one IdP outage is not cached for ever', async () => {
    const clock = frozenClock(NOW);
    const served = heldFetch();
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      ttlMs: 60_000,
      fetch: served.fetch,
    });

    const failing = swallow(keys.keyFor('k1', 'RS256'));
    await flush();
    served.fail(0, new Error('connection reset'));
    await failing;

    clock.advance(120_000);
    const retried = swallow(keys.keyFor('k1', 'RS256'));
    await flush();
    expect(served.calls).toBe(2);
    served.settle(1, { keys: [] });
    await retried;
  });
});

// A refresh that never settles used to hold the slot for the life of the process, and every later
// caller joined a promise nothing would ever resolve. `AbortSignal.timeout` bounds only the DEFAULT
// transport — `options.fetch` is app-injected, and a `fetch` that ignores its signal is exactly the
// wedge. The deadline evicts the KEY, never the work: the wedged refresh keeps running and its own
// callers keep their promise, so the worst case is one duplicate JWKS fetch and never a failed
// verification. That asymmetry is why this is a fix and not a risk.
describe('a wedged refresh does not hold the slot for ever', () => {
  test('the deadline is TWICE the transport timeout, derived and never invented', () => {
    const clock = frozenClock(NOW);
    const served = heldFetch();
    const timer = controlledTimer();
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      timeoutMs: 4_000,
      schedule: timer.schedule,
      fetch: served.fetch,
    });

    void swallow(keys.keyFor('k1', 'RS256'));
    expect(timer.ms).toBe(8_000);
  });

  test('past the deadline the key is free, so a later caller refreshes instead of joining', async () => {
    const clock = frozenClock(NOW);
    const served = heldFetch();
    const timer = controlledTimer();
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      ttlMs: 60_000,
      schedule: timer.schedule,
      fetch: served.fetch,
    });

    const wedged = swallow(keys.keyFor('k1', 'RS256'));
    await flush();
    expect(served.calls).toBe(1);

    // Still inside the TTL, so nothing below is a staleness refresh — only the eviction can
    // explain a second request.
    timer.fire();
    const later = swallow(keys.keyFor('k1', 'RS256'));
    await flush();
    expect(served.calls).toBe(2);

    served.settle(1, { keys: [] });
    await later;
    // The wedged one is still running and still owns its own callers: evicting the key never
    // cancelled the work and never rejected anybody.
    served.settle(0, { keys: [] });
    await wedged;
  });
});

// The eviction's own consequence, and the reason it needs a fence. Two `fetchKeys` runs can now
// overlap — the evicted one and its replacement — and both END by installing what they read into
// the client's cache. Without a generation check the LATER-SETTLING one wins, so a refresh the
// client already gave up on can drop a newer key set on top of the one in use, and a login against
// a freshly rotated `kid` starts missing again. Unreachable before the deadline existed, because
// only one refresh could ever be in flight.
describe('a refresh the client gave up on cannot overwrite a newer key set', () => {
  const rsaPair = async (): Promise<CryptoKeyPair> =>
    (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;

  const publicJwk = async (pair: CryptoKeyPair, kid: string): Promise<Record<string, unknown>> => ({
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kid,
  });

  test('a late answer from an evicted refresh is read by its own callers and by nobody else', async () => {
    const pair = await rsaPair();
    const beforeRotation = { keys: [await publicJwk(pair, 'k1')] };
    const afterRotation = {
      keys: [await publicJwk(pair, 'k1'), await publicJwk(pair, 'k2')],
    };

    const clock = frozenClock(NOW);
    const served = heldFetch();
    const timer = controlledTimer();
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      ttlMs: 60_000,
      schedule: timer.schedule,
      fetch: served.fetch,
    });

    const wedged = swallow(keys.keyFor('k1', 'RS256'));
    await flush();
    timer.fire();

    // The replacement reads the rotated set and installs it.
    const replacement = keys.keyFor('k2', 'RS256');
    await flush();
    expect(served.calls).toBe(2);
    served.settle(1, afterRotation);
    expect(await replacement).toBeDefined();

    // Now the one the client gave up on finally answers, with the PRE-rotation set.
    served.settle(0, beforeRotation);
    await wedged;
    await flush();

    // `k2` is still cached and still inside the TTL, so this is answered with no request at all.
    // The COUNT is asserted before the await, deliberately: with the stale set installed this
    // read misses, starts a third request nothing in this test settles, and awaiting it first
    // would report the defect as a five-second timeout instead of as the extra request it is.
    const afterwards = keys.keyFor('k2', 'RS256');
    void swallow(afterwards);
    await flush();
    expect(served.calls).toBe(2);
    expect(await afterwards).toBeDefined();
  });
});
