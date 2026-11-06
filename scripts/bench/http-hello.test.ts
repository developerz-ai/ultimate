// The load core, against an in-process server and a counter clock: every answer is counted, a
// non-2xx and a server that dies mid-run fail the verdict, and a short run is refused before it.

import { describe, expect, test } from 'bun:test';
import { failedRun, MIN_SECONDS, readCount, tooShort } from './http-hello';
import { type LoadFetch, percentile, runLoad } from './http-hello-load';

/** One tick per call: the run ends after a fixed number of clock reads, never on the wall clock. */
const counterClock = () => {
  let at = 0;
  return () => {
    at += 1;
    return at;
  };
};

/** The app as a handler, no socket: `status` decides each answer by request number. */
const server = (status: (n: number) => number): LoadFetch => {
  let n = 0;
  return async () => {
    n += 1;
    return { status: status(n), bytes: 5 };
  };
};

describe('unit · http-hello', () => {
  test('every request is answered and counted, and an all-2xx run passes', async () => {
    const result = await runLoad({
      url: 'http://app.test/',
      concurrency: 4,
      durationMs: 200,
      fetch: server(() => 200),
      now: counterClock(),
    });
    expect(result.requests).toBeGreaterThan(0);
    expect(result.ok).toBe(result.requests);
    expect(result.bytes).toBe(result.requests * 5);
    expect(result.statuses).toEqual({ '200': result.requests });
    expect(failedRun(result, 'http://app.test/')).toBeUndefined();
  });

  test('a non-2xx answer is counted and fails the run', async () => {
    const result = await runLoad({
      url: 'http://app.test/',
      concurrency: 2,
      durationMs: 100,
      fetch: server((n) => (n % 10 === 0 ? 503 : 200)),
      now: counterClock(),
    });
    expect(result.non2xx).toBeGreaterThan(0);
    expect(result.statuses['503']).toBe(result.non2xx);
    expect(failedRun(result, 'http://app.test/')?.code).toBe('X_BENCH_RUN_FAILED');
  });

  test('a server that dies mid-run is not a pass', async () => {
    let n = 0;
    const dying: LoadFetch = async () => {
      n += 1;
      if (n > 5) return Promise.reject(new Error('ECONNREFUSED'));
      return { status: 200, bytes: 1 };
    };
    const result = await runLoad({
      url: 'http://app.test/',
      concurrency: 1,
      durationMs: 100,
      fetch: dying,
      now: counterClock(),
    });
    expect(result.ok).toBe(5);
    expect(result.errors).toBe(result.requests - 5);
    expect(failedRun(result, 'http://app.test/')?.cause).toContain('got no answer');
  });

  test('no request at all is not a figure either', async () => {
    const result = await runLoad({
      url: 'http://app.test/',
      concurrency: 1,
      durationMs: 0,
      fetch: server(() => 200),
      now: counterClock(),
    });
    expect(result.requests).toBe(0);
    expect(failedRun(result, 'http://app.test/')?.cause).toContain('no request completed');
  });

  test(`a run under ${MIN_SECONDS} s is X_BENCH_RUN_TOO_SHORT, and its fix asks for 30`, () => {
    expect(tooShort(9, 'http://app.test/')?.code).toBe('X_BENCH_RUN_TOO_SHORT');
    expect(tooShort(9, 'http://app.test/')?.fix).toContain('--seconds 30');
    expect(tooShort(MIN_SECONDS, 'http://app.test/')).toBeUndefined();
  });

  test('a count flag is a whole number in range, or X_CLI_BAD_FLAG', () => {
    const bounds = { flag: 'concurrency', min: 1, max: 8 };
    expect(readCount(undefined, 4, bounds)).toBe(4);
    expect(readCount('8', 4, bounds)).toBe(8);
    for (const bad of ['0', '9', '1.5', 'NaN', true]) {
      expect(readCount(bad, 4, bounds)).toEqual(
        expect.objectContaining({ code: 'X_CLI_BAD_FLAG' }),
      );
    }
  });

  test('percentiles are nearest-rank over the sorted latencies', () => {
    const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.99)).toBe(99);
    expect(percentile([], 0.5)).toBe(0);
  });
});
