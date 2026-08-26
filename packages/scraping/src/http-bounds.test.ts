// The second transport's per-request deadline and body cap when they are not numbers.
//
// Its own file, and its own subject: `http.test.ts` asserts what a request DOES, and every test
// here asserts that a request never left. Both bounds fail late and in the wrong voice without a
// screen — `AbortSignal.timeout(NaN)` throws a bare `TypeError` (no code, no fix, straight into a
// job's retry classifier as unclassified), and `readWithinLimit`'s own refusal arrives after the
// call was made, so a POST with a non-finite cap has already been performed when the refusal is
// raised. The cap is the only thing between a hostile stream and the worker's heap, so its
// refusal has to come first.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
import { testClock } from './clock';
import { httpOverFetch } from './http';
import type { NetworkEntry } from './rings';
import { createRing } from './rings';
import { EMPTY_SESSION } from './session-state';

const NOT_A_BOUND: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; cause: string }> {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('an HTTP bound that is not a number was accepted');
}

/** Counts what reached the network, which is the assertion every test here really makes. */
const transport = (timeoutMs = 1_000) => {
  const calls: string[] = [];
  const network = createRing<NetworkEntry>();
  const http = httpOverFetch({
    rules: { allowHosts: ['api.test'] },
    clock: testClock(),
    timeoutMs,
    network,
    session: () => Promise.resolve(EMPTY_SESSION),
    fetch: (url) => {
      calls.push(url);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    },
  });
  return { http, calls };
};

describe('unit · the HTTP leg, bounded', () => {
  for (const value of NOT_A_BOUND) {
    test(`a per-call timeout of ${String(value)} is refused before the request leaves`, async () => {
      const { http, calls } = transport();
      const error = await refusal(() =>
        http.request('https://api.test/orders', { timeout: value }),
      );
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('timeout');
      expect(calls).toEqual([]);
    });

    test(`a maxBytes of ${String(value)} is refused before the request leaves`, async () => {
      const { http, calls } = transport();
      const error = await refusal(() =>
        http.request('https://api.test/orders', { maxBytes: value }),
      );
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('maxBytes');
      // The whole point of the position: a POST with a bad cap must not be performed and then
      // refused. `readWithinLimit`'s own screen fires only once the response is in hand.
      expect(calls).toEqual([]);
    });
  }

  // The session default is the same number by another route: `scrape-run.ts` hands it the run's
  // `pageTimeout`, so an app's declaration reaches this without any call ever naming a timeout.
  test("the session's own default deadline is screened too", async () => {
    const { http, calls } = transport(Number.NaN);
    const error = await refusal(() => http.request('https://api.test/orders'));
    expect(error.code).toBe('X_INVARIANT');
    expect(error.cause).toContain('timeout');
    expect(calls).toEqual([]);
  });

  // Both floors are 1. A zero deadline aborts on the tick the request is armed, so every call is
  // `X_SCRAPE_TIMEOUT` and no endpoint is ever reachable; a zero cap puts every response over,
  // so every call is `X_SCRAPE_BODY_TOO_LARGE`. Neither is a caller declining a feature.
  test('a zero deadline and a zero cap are refused', async () => {
    const { http } = transport();
    expect(
      (await refusal(() => http.request('https://api.test/o', { timeout: 0 }))).cause,
    ).toContain('timeout');
    expect(
      (await refusal(() => http.request('https://api.test/o', { maxBytes: 0 }))).cause,
    ).toContain('maxBytes');
  });

  test('1ms and 1 byte are accepted, so the floor refuses zero and nothing above it', async () => {
    const { http, calls } = transport();
    // One byte is under the body, so this is the CAP answering rather than the screen — which is
    // exactly the boundary being pinned: 1 is a legal cap and 0 is not.
    expect((await refusal(() => http.request('https://api.test/o', { maxBytes: 1 }))).code).toBe(
      'X_SCRAPE_BODY_TOO_LARGE',
    );
    expect(calls).toHaveLength(1);
  });
});
