// The default width of a parallel test run: a memory BUDGET divided by what a worker costs, never
// more workers than cores. Refusals first — a budget that does not parse must never mean "default".

import { describe, expect, test } from 'bun:test';
import {
  availableCpus,
  BUDGET_RULE,
  defaultWorkers,
  GATE_BUDGET_SHARE,
  MAX_WORKERS_ENV,
  MEMORY_BUDGET_ENV,
  memoryBudget,
  parseBytes,
  sharedWorkers,
  TestBudgetInvalidError,
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

  // Declared beside its one thrower — never in a file split off `errors.ts` for its size.
  test('the refusal is the class this module declares', () => {
    expect(() => memoryBudget(16 * GiB, { [MEMORY_BUDGET_ENV]: 'lots' })).toThrow(
      TestBudgetInvalidError,
    );
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
  // A free GitHub runner (4 vCPU, 16 GB; `totalmem()` reads a little under) plans EXACTLY what it
  // planned under the old 4 GiB cap — CI's width, and every timing measured on it, are unchanged.
  test('a 4-vCPU 16 GB CI runner plans 3 workers, as it always did', () => {
    for (const total of [16 * GiB, 15.6 * GiB]) {
      const plan = workerPlan(4, total, NO_ENV);
      expect(plan.workers).toBe(3);
      expect(plan.boundBy).toBe('budget');
    }
    expect(memoryBudget(16 * GiB, NO_ENV)).toBe(4 * GiB);
  });

  // The budget scales with the machine: a fixed 4 GiB cap held a 16-core 62 GB box to 3 workers,
  // and the framework's unit step there took 374 s at 3 against 149 s at 12 (measured 2026-11-07).
  test('a 16-core 62 GB box plans 12 workers, not 3', () => {
    const plan = workerPlan(16, 62 * GiB, NO_ENV);
    expect(plan.budgetBytes).toBe(Math.floor(62 * GiB * GATE_BUDGET_SHARE));
    expect(plan.workers).toBe(12);
    expect(plan.workers * WORKER_BYTES).toBeLessThanOrEqual(plan.budgetBytes);
  });

  // The OOM of 2026-09-27: 12 cores, 45 GB, no swap, two gates planning 14-18 workers each off
  // MemAvailable. The budget is a quarter of TOTAL memory, and a second gate leases from the same
  // machine pool (`test-slots.ts`) — so the box holds the budget's workers, not twice that.
  test('a 12-core 45 GB box plans within a quarter of its RAM, never off the page cache', () => {
    const plan = workerPlan(12, 45 * GiB, NO_ENV);
    expect(plan.workers).toBe(9);
    expect(plan.reason).toBe('9 workers (budget 11.3 GB)');
    expect(plan.workers * WORKER_BYTES).toBeLessThanOrEqual(45 * GiB * GATE_BUDGET_SHARE);
  });

  test('the machines Ultimate is for: 8 GB → 2 workers, 16 GB → 3', () => {
    expect(defaultWorkers(4, 8 * GiB, NO_ENV)).toBe(2);
    expect(defaultWorkers(8, 16 * GiB, NO_ENV)).toBe(3);
    // A quarter of 8 GB is 2 GiB, which would plan one worker: the floor holds it at two.
    expect(memoryBudget(8 * GiB, NO_ENV)).toBe(2.75 * GiB);
    expect(memoryBudget(16 * GiB, NO_ENV)).toBe(4 * GiB);
  });

  test('the rule every help line prints is the rule this module computes', () => {
    expect(BUDGET_RULE).toBe('max(2.75 GiB, 25% of RAM)');
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
    // No RAM reading at all still plans on the floor's two workers, never zero.
    expect(defaultWorkers(12, 0, NO_ENV)).toBe(2);
    expect(defaultWorkers(12, 0, { [MEMORY_BUDGET_ENV]: '1g' })).toBe(WORKER_FLOOR);
  });

  test('the budget env replaces the default, and the cap env narrows it', () => {
    expect(defaultWorkers(16, 64 * GiB, { [MEMORY_BUDGET_ENV]: '10g' })).toBe(8);
    const capped = workerPlan(16, 64 * GiB, { [MEMORY_BUDGET_ENV]: '10g', [MAX_WORKERS_ENV]: '3' });
    expect(capped.workers).toBe(3);
    expect(capped.reason).toBe(`3 workers (${MAX_WORKERS_ENV}=3)`);
    // A cap above the plan is not a raise.
    expect(defaultWorkers(16, 16 * GiB, { [MAX_WORKERS_ENV]: '12' })).toBe(3);
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
