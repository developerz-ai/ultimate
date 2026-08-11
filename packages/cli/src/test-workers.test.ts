// The default width of a parallel test run. One number, and both of its bounds matter: too few and
// the gate is the serial gate again, too many and a worker per core swaps a CI runner.

import { describe, expect, test } from 'bun:test';
import { availableCpus, defaultWorkers, WORKER_CEILING } from './test-workers';

describe('unit · default worker count', () => {
  test('it leaves one core to the parent that is collecting every shard output', () => {
    expect(defaultWorkers(4)).toBe(3);
    expect(defaultWorkers(9)).toBe(8);
  });

  test('a big developer machine is capped, because a worker costs memory and not just a core', () => {
    expect(defaultWorkers(32)).toBe(WORKER_CEILING);
    expect(defaultWorkers(12)).toBe(WORKER_CEILING);
  });

  test('a one- or two-core runner still gets a run, never zero workers', () => {
    expect(defaultWorkers(1)).toBe(1);
    expect(defaultWorkers(2)).toBe(1);
    expect(defaultWorkers(0)).toBe(1);
  });

  test('the real machine answers with something runnable', () => {
    expect(availableCpus()).toBeGreaterThanOrEqual(1);
    expect(defaultWorkers()).toBeLessThanOrEqual(WORKER_CEILING);
  });
});
