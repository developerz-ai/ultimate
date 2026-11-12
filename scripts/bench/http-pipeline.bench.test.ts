// The request floor, held as WORK COUNTS — signals combined, query strings parsed, sets and
// entry arrays allocated, header writes, stack renders — never as wall-clock µs: a count cannot
// flake on a shared runner, and each one is a cost `http-pipeline.bench.ts` once measured on every
// request. The timed figure is the result line in `results/http-pipeline.json`.

import { afterEach, describe, expect, test } from 'bun:test';
import { installLogSink } from '../../packages/core/src/index';
import { routeNotFound } from '../../packages/http/src/errors';
import {
  answer,
  BENCH_CASES,
  type BenchCase,
  benchPipeline,
  benchPipelineCases,
} from './http-pipeline.bench';

const COUNTED = ['any', 'searchParams', 'set', 'entries', 'headers.set'] as const;
type Counts = Record<(typeof COUNTED)[number], number>;

/**
 * Runs `requests` of one case with the globals the floor used to pay for wrapped in counters, and
 * hands back the per-request mean. Every wrapper is restored in `finally`, whatever the run did.
 */
async function countsPer(which: BenchCase, requests = 10): Promise<Counts> {
  const pipeline = benchPipeline();
  await answer(pipeline, which, 0); // warm: a first request builds memos a steady state has
  const counts: Counts = { any: 0, searchParams: 0, set: 0, entries: 0, 'headers.set': 0 };
  const bump = (key: keyof Counts): void => {
    counts[key] += 1;
  };
  const RealSet = globalThis.Set;
  const realAny = AbortSignal.any;
  const realHeaderSet = Headers.prototype.set;
  const realEntries = Object.entries;
  const searchParams = Object.getOwnPropertyDescriptor(URL.prototype, 'searchParams');
  const readParams = searchParams?.get;
  globalThis.Set = new Proxy(RealSet, {
    construct(target, args, newTarget) {
      bump('set');
      return Reflect.construct(target, args, newTarget);
    },
  });
  AbortSignal.any = (signals) => {
    bump('any');
    return realAny(signals);
  };
  Headers.prototype.set = function counted(name: string, value: string): void {
    bump('headers.set');
    realHeaderSet.call(this, name, value);
  };
  Object.entries = ((value: object) => {
    bump('entries');
    return realEntries(value);
  }) as typeof Object.entries;
  if (searchParams !== undefined && readParams !== undefined) {
    Object.defineProperty(URL.prototype, 'searchParams', {
      ...searchParams,
      get(this: URL) {
        bump('searchParams');
        return readParams.call(this);
      },
    });
  }
  try {
    for (let index = 0; index < requests; index += 1) await answer(pipeline, which, index);
  } finally {
    globalThis.Set = RealSet;
    AbortSignal.any = realAny;
    Headers.prototype.set = realHeaderSet;
    Object.entries = realEntries;
    if (searchParams !== undefined)
      Object.defineProperty(URL.prototype, 'searchParams', searchParams);
  }
  const per = { ...counts };
  for (const key of COUNTED) per[key] = counts[key] / requests;
  return per;
}

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});
const quiet = (): void => {
  release = installLogSink(() => undefined);
};

describe('the request floor, counted', () => {
  test('ctx.signal joins the caller and the deadline with no AbortSignal.any per request', async () => {
    quiet();
    for (const which of BENCH_CASES) expect((await countsPer(which)).any).toBe(0);
  });

  test('a request with no query string never builds URLSearchParams', async () => {
    quiet();
    expect((await countsPer('hello')).searchParams).toBe(0);
  });

  test('Vary is merged with no Set allocated', async () => {
    quiet();
    for (const which of BENCH_CASES) expect((await countsPer(which)).set).toBe(0);
  });

  // Measured 2026-11-11 after H1 (sweep 2): the security headers are one prebuilt list
  // (`applySecurityHeaders`); every pair still built is the CORS record's or core's (span
  // attributes, metric key, log line).
  // A ceiling, not an exact figure, so a stage that drops one more does not fail this test.
  test('entry arrays and header writes stay at the measured floor', async () => {
    quiet();
    const hello = await countsPer('hello');
    expect(hello.entries).toBeLessThanOrEqual(2);
    expect(hello['headers.set']).toBeLessThanOrEqual(24);
    const miss = await countsPer('404');
    expect(miss.entries).toBeLessThanOrEqual(4);
    expect(miss['headers.set']).toBeLessThanOrEqual(14);
  });

  test('a 404 never renders a stack', async () => {
    quiet();
    let reads = 0;
    const miss = routeNotFound('GET', '/nope');
    Object.defineProperty(miss, 'stack', {
      get() {
        reads += 1;
        return 'Error\n    at nowhere (bench.ts:1:1)';
      },
    });
    const pipeline = benchPipeline({ explainMiss: () => miss });
    const status = await answer(pipeline, '404', 0);
    expect(status).toBe(404);
    expect(reads).toBe(0);
  });

  test('the bench times every case it reports, at the status it claims', async () => {
    quiet();
    const results = await benchPipelineCases(200, 1);
    expect(results.map((result) => [result.case, result.status])).toEqual([
      ['hello', 200],
      ['404', 404],
    ]);
    for (const result of results) expect(result.usPerRequest).toBeGreaterThan(0);
  });
});
