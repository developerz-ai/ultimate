// The default width of a parallel test run: a memory BUDGET divided by what a worker costs, never
// more workers than cores. Refusals first — a budget that does not parse must never mean "default".

import { describe, expect, test } from 'bun:test';
import {
  availableCpus,
  defaultWorkers,
  GATE_BUDGET_CAP,
  MAX_WORKERS_ENV,
  MEMORY_BUDGET_ENV,
  memoryBudget,
  parseBytes,
  sharedWorkers,
  totalMemory,
  WORKER_BYTES,
  WORKER_CEILING,
  WORKER_FLOOR,
  workerPlan,
} from './test-workers';

const GiB = 1024 ** 3;
const NO_ENV = {};

describe('unit · the budget refuses what it cannot read', () => {
  test('a memory budget that does not parse is X_TEST_BUDGET_INVALID, naming the value', () => {
    for (const raw of ['lots', '3x', '-1g', '0', 'g']) {
      expect(() => memoryBudget(16 * GiB, { [MEMORY_BUDGET_ENV]: raw })).toThrow(
        expect.objectContaining({ code: 'X_TEST_BUDGET_INVALID' }),
      );
    }
  });

  test('a worker cap that is not a positive integer is refused, not ignored', () => {
    for (const raw of ['0', '2.5', 'four', '-3']) {
      expect(() => workerPlan(8, 16 * GiB, { [MAX_WORKERS_ENV]: raw })).toThrow(
        expect.objectContaining({ code: 'X_TEST_BUDGET_INVALID' }),
      );
    }
  });

  test('sizes read as binary units whatever the spelling', () => {
    expect(parseBytes('3g')).toBe(3 * GiB);
    expect(parseBytes('3GiB')).toBe(3 * GiB);
    expect(parseBytes('512m')).toBe(512 * 1024 ** 2);
    expect(parseBytes('1.5G')).toBe(1.5 * GiB);
    expect(parseBytes('1073741824')).toBe(GiB);
    expect(parseBytes('3 tb')).toBeUndefined();
  });
});

describe('unit · the default width', () => {
  // The OOM of 2026-09-27: 12 cores, 45 GB, no swap. 22.6.2 planned 14 workers off MemAvailable;
  // the budget is a quarter of TOTAL memory capped at 4 GiB, whatever the page cache says.
  test('a 12-core 45 GB box plans 4 workers, not 14', () => {
    const plan = workerPlan(12, 45 * GiB, NO_ENV);
    expect(plan.budgetBytes).toBe(GATE_BUDGET_CAP);
    expect(plan.workers).toBe(4);
    expect(plan.reason).toBe('4 workers (budget 4.0 GB)');
  });

  test('the machines Ultimate is for: 8 GB → 2 workers, 16 GB → 4', () => {
    expect(defaultWorkers(8, 8 * GiB, NO_ENV)).toBe(2);
    expect(defaultWorkers(8, 16 * GiB, NO_ENV)).toBe(4);
    expect(memoryBudget(8 * GiB, NO_ENV)).toBe(2 * GiB);
  });

  test('never more workers than cores — no oversubscription', () => {
    const plan = workerPlan(2, 64 * GiB, { [MEMORY_BUDGET_ENV]: '32g' });
    expect(plan.workers).toBe(2);
    expect(plan.boundBy).toBe('cpus');
    expect(plan.reason).toContain('2 cores');
  });

  test('never fewer than one, on a starved or zero-core box', () => {
    expect(defaultWorkers(1, 64 * GiB, NO_ENV)).toBe(1);
    expect(defaultWorkers(0, 64 * GiB, NO_ENV)).toBe(1);
    expect(defaultWorkers(12, 0, NO_ENV)).toBe(WORKER_FLOOR);
  });

  test('the budget env replaces the default, and the cap env narrows it', () => {
    expect(defaultWorkers(16, 64 * GiB, { [MEMORY_BUDGET_ENV]: '8g' })).toBe(8);
    const capped = workerPlan(16, 64 * GiB, { [MEMORY_BUDGET_ENV]: '8g', [MAX_WORKERS_ENV]: '3' });
    expect(capped.workers).toBe(3);
    expect(capped.reason).toBe(`3 workers (${MAX_WORKERS_ENV}=3)`);
    // A cap above the plan is not a raise.
    expect(defaultWorkers(16, 16 * GiB, { [MAX_WORKERS_ENV]: '12' })).toBe(4);
  });

  test('the sanity ceiling holds even on a budget that would allow more', () => {
    expect(defaultWorkers(256, 1024 * GiB, { [MEMORY_BUDGET_ENV]: '512g' })).toBe(WORKER_CEILING);
  });

  test('a shared suite plans the same width — the default is already one per core at most', () => {
    expect(sharedWorkers(8, 16 * GiB, NO_ENV)).toBe(defaultWorkers(8, 16 * GiB, NO_ENV));
  });

  test('the real machine answers with something runnable', () => {
    expect(availableCpus()).toBeGreaterThanOrEqual(1);
    expect(totalMemory()).toBeGreaterThan(0);
    expect(WORKER_BYTES).toBeGreaterThan(0);
    const workers = defaultWorkers(availableCpus(), totalMemory(), NO_ENV);
    expect(workers).toBeGreaterThanOrEqual(1);
    expect(workers).toBeLessThanOrEqual(availableCpus());
  });
});
