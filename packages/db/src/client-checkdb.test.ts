// Single responsibility: `checkDb`, the readiness report behind /readyz — it answers, whatever
// the driver's refusal turns out to be. Split from `client.test.ts` for the file-size ceiling,
// along the seam that it needs none of that file's fake pool: a client that only rejects is the
// whole fixture.

import { describe, expect, test } from 'bun:test';
import { checkDb, type DbClient } from './client';

/**
 * Stands in for what `Bun.SQL` itself throws — an error carrying no Ultimate code, which is
 * precisely the shape that must never escape this module.
 */
class DriverFailure extends Error {
  override readonly name = 'DriverFailure';
}

/**
 * `/readyz` is what decides whether the kubelet keeps this pod, so "never throws" is not a
 * nicety: an exception out of the probe is an unhandled rejection where a `{ ok: false }` report
 * belongs. Rendering the driver's refusal used to be the throw — `instanceof` runs a `Proxy`'s
 * `getPrototypeOf` trap and `String()` runs `Symbol.toPrimitive`, both on a value this package
 * did not build.
 */
describe('checkDb reports, and never throws', () => {
  const refusing = (thrown: unknown): DbClient => ({
    query: () => Promise.reject(thrown),
    one: () => Promise.reject(thrown),
    execute: () => Promise.reject(thrown),
  });

  test('an ordinary driver failure is a report', async () => {
    const report = await checkDb(refusing(new DriverFailure('connection refused')));

    expect(report.ok).toBe(false);
    expect(report.error).toContain('connection refused');
    expect(typeof report.latencyMs).toBe('number');
  });

  test('a Proxy whose getPrototypeOf throws is a report too', async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new TypeError('proxy trap');
        },
      },
    );

    const report = await checkDb(refusing(hostile));

    expect(report.ok).toBe(false);
    expect(typeof report.error).toBe('string');
  });

  test('a thrown symbol, which template interpolation cannot render, is a report too', async () => {
    const report = await checkDb(refusing(Symbol('nope')));

    expect(report.ok).toBe(false);
    expect(report.error).toContain('nope');
  });
});
