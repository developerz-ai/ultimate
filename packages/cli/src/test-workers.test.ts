// The default width of a parallel test run. One number, and both of its bounds matter: too few and
// the gate is the serial gate again, too many and a worker per core swaps a CI runner.

import { describe, expect, test } from 'bun:test';
import { availableCpus, defaultWorkers, WORKER_CEILING } from './test-workers';

describe('unit · default worker count', () => {
  test('it OVERSUBSCRIBES the cores, because cpus - 1 lost to serial on the target runner', () => {
    // The number that matters: a free 4-core `ubuntu-latest`. Measured there, `unit` took 43.2s
    // serial, 44.8s at 3 workers (the old `cpus - 1`) and 34.8s at 6. Three workers on four cores
    // could not cover sharding's own cost, so the gate paid for parallelism and got nothing.
    expect(defaultWorkers(4)).toBe(6);
    expect(defaultWorkers(2)).toBe(3);
  });

  test('a big developer machine is capped, because a worker costs memory and not just a core', () => {
    expect(defaultWorkers(32)).toBe(WORKER_CEILING);
    expect(defaultWorkers(12)).toBe(WORKER_CEILING);
    expect(defaultWorkers(6)).toBe(WORKER_CEILING);
  });

  test('a one-core box still shards, and no input yields zero workers', () => {
    // Two, not one: a single worker is serial with the sharding overhead still paid for.
    expect(defaultWorkers(1)).toBe(2);
    expect(defaultWorkers(0)).toBe(2);
  });

  test('the real machine answers with something runnable', () => {
    expect(availableCpus()).toBeGreaterThanOrEqual(1);
    expect(defaultWorkers()).toBeLessThanOrEqual(WORKER_CEILING);
  });
});
