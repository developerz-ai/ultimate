// The default width of a parallel test run. One number, and both of its bounds matter: too few and
// the gate is the serial gate again, too many and a worker per core swaps a CI runner.

import { describe, expect, test } from 'bun:test';
import {
  availableCpus,
  availableMemory,
  defaultWorkers,
  WORKER_BYTES,
  WORKER_CEILING,
  WORKER_FLOOR,
} from './test-workers';

/** Enough memory that only the CPU arm can bind. */
const PLENTY = WORKER_BYTES * 1000;

describe('unit · default worker count', () => {
  test('it OVERSUBSCRIBES the cores, because cpus - 1 lost to serial on the target runner', () => {
    // The number that matters: a free 4-core `ubuntu-latest`. Measured there, `unit` took 43.2s
    // serial, 44.8s at 3 workers (the old `cpus - 1`) and 34.8s at 6. Three workers on four cores
    // could not cover sharding's own cost, so the gate paid for parallelism and got nothing.
    expect(defaultWorkers(4, PLENTY)).toBe(6);
    expect(defaultWorkers(2, PLENTY)).toBe(3);
    // Rounded UP: 3 cores x 1.5 is 4.5, and the half worker is the one that fills a stall.
    expect(defaultWorkers(3, PLENTY)).toBe(5);
  });

  // The regression this replaced: a fixed ceiling of 8 held a 12-core box with 30 GB free to 8.
  test('a big machine with the memory for it is NOT capped at 8', () => {
    expect(defaultWorkers(12, PLENTY)).toBe(18);
    expect(defaultWorkers(16, PLENTY)).toBe(24);
  });

  test('free memory bounds the width, one WORKER_BYTES per worker', () => {
    expect(defaultWorkers(12, WORKER_BYTES * 10)).toBe(10);
    expect(defaultWorkers(12, WORKER_BYTES * 10.9)).toBe(10);
    expect(defaultWorkers(32, WORKER_BYTES * 20)).toBe(20);
  });

  test('the sanity ceiling still holds on a machine with everything', () => {
    expect(defaultWorkers(256, PLENTY)).toBe(WORKER_CEILING);
  });

  test('a one-core or starved box still shards, and no input yields zero workers', () => {
    // Two, not one: a single worker is serial with the sharding overhead still paid for.
    expect(defaultWorkers(1, PLENTY)).toBe(WORKER_FLOOR);
    expect(defaultWorkers(0, PLENTY)).toBe(WORKER_FLOOR);
    expect(defaultWorkers(12, 0)).toBe(WORKER_FLOOR);
  });

  test('the real machine answers with something runnable', () => {
    expect(availableCpus()).toBeGreaterThanOrEqual(1);
    expect(availableMemory()).toBeGreaterThan(0);
    expect(defaultWorkers()).toBeGreaterThanOrEqual(WORKER_FLOOR);
    expect(defaultWorkers()).toBeLessThanOrEqual(WORKER_CEILING);
  });
});
