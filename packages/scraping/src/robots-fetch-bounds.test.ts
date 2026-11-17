// The one `/robots.txt` read's deadline and cap when they are not numbers.
//
// Its own file because the outcome is not "the read fails" — it is that the read fails SILENTLY,
// on every origin, for the whole run. (It once failed OPEN: a deadline and an over-cap body
// answered `undefined`, which the gate reads as no rules. Both now fail closed — `{ unreachable }`
// — so a bad bound is every origin refused instead.) A `NaN` timeoutMs — `AbortSignal.timeout(NaN)`
// throws a bare `TypeError` — reaches the gate's own `.catch` with no error and no log line.
// `scrape-run.ts` feeds this the run's page timeout, so the value arrives from an app's
// `pageTimeout:` declaration.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
import type { ScrapeFetch } from './http';
import { robotsGate } from './robots';
import { robotsFetcher } from './robots-fetch';

const NOT_A_BOUND: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

/** Never called by a repaired construction — it exists to prove the read never left. */
const refusingFetch: ScrapeFetch = () =>
  Promise.resolve(new Response('User-agent: *\nDisallow: /', { status: 200 }));

function refusal(run: () => unknown): { code: string; cause: string } {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('a robots read bound that is not a number was accepted');
}

describe('unit · the robots read, bounded', () => {
  for (const value of NOT_A_BOUND) {
    test(`timeoutMs of ${String(value)} is refused, not read as "no restrictions"`, () => {
      const error = refusal(() => robotsFetcher({ timeoutMs: value, fetch: refusingFetch }));
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('timeoutMs');
    });

    test(`maxBytes of ${String(value)} is refused at construction, before any egress`, () => {
      const error = refusal(() => robotsFetcher({ maxBytes: value, fetch: refusingFetch }));
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('maxBytes');
    });
  }

  // Both floors are 1 and both are claims about what zero MEANS here. `timeoutMs: 0` is a deadline
  // that has already expired, so every read fails; `maxBytes: 0` puts every robots.txt over the
  // cap with no whole line inside it, with the identical outcome. Neither is a caller declining a
  // feature — both are every origin refused, for the whole run, silently.
  test('a zero deadline and a zero cap are both refused, because both refuse every origin', () => {
    expect(refusal(() => robotsFetcher({ timeoutMs: 0 })).cause).toContain('timeoutMs');
    expect(refusal(() => robotsFetcher({ maxBytes: 0 })).cause).toContain('maxBytes');
  });

  test('1ms and 1 byte are accepted — the floor refuses zero and nothing above it', () => {
    expect(typeof robotsFetcher({ timeoutMs: 1, maxBytes: 1, fetch: refusingFetch })).toBe(
      'function',
    );
  });

  // The gate is where the silence happened: it builds the default fetcher itself, so an app that
  // never names `robotsFetcher` still gets the refusal at the moment the gate is constructed —
  // which is `runScrape`, before `driver.open()` and before a single byte leaves.
  test('the gate refuses at construction rather than allowing every path at read time', () => {
    const error = refusal(() => robotsGate({ policy: 'obey', timeoutMs: Number.NaN }));
    expect(error.code).toBe('X_INVARIANT');
    expect(error.cause).toContain('timeoutMs');
  });

  test('an ignored policy builds no fetcher, so its bounds are nobody’s business', () => {
    const gate = robotsGate({ policy: { ignore: 'our own account' }, timeoutMs: Number.NaN });
    expect(gate.ignoredBecause).toBe('our own account');
  });
});
