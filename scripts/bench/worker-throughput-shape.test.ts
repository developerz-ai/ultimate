// The worker bench's pure half: the worker counts a run accepts, claims per second, and the input
// schema both processes agree on.

import { describe, expect, test } from 'bun:test';
import {
  benchJobInput,
  DEFAULT_WORKER_COUNTS,
  parseWorkerCounts,
  throughputOf,
  WORKER_PROFILES,
} from './worker-throughput-shape';

describe('worker throughput shape', () => {
  test('the plan’s counts by default; whole numbers 1..64 only', () => {
    expect(parseWorkerCounts(undefined)).toEqual(DEFAULT_WORKER_COUNTS);
    expect(parseWorkerCounts('1, 8')).toEqual([1, 8]);
    expect(parseWorkerCounts('0')).toBeUndefined();
    expect(parseWorkerCounts('2.5')).toBeUndefined();
    expect(parseWorkerCounts(true)).toBeUndefined();
  });

  test('claims per second from jobs and server-side elapsed ms', () => {
    expect(throughputOf(4, 2_000, 1_000)).toEqual({
      workers: 4,
      jobs: 2_000,
      elapsedMs: 1_000,
      claimsPerSecond: 2_000,
      perWorker: 500,
    });
    expect(throughputOf(1, 10, 0).claimsPerSecond).toBe(0);
  });

  test('the shipped profile is jobWorker’s defaults: 8 slots, 250 ms', () => {
    expect(WORKER_PROFILES[0]).toMatchObject({
      name: 'shipped',
      concurrency: 8,
      pollIntervalMs: 250,
    });
  });

  test('the job input is checked, never cast', async () => {
    const validate = benchJobInput['~standard'].validate;
    expect(await validate({ n: 3 })).toEqual({ value: { n: 3 } });
    expect('issues' in (await validate({ n: '3' }))).toBe(true);
  });
});
