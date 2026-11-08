// A `backfill()` run under a frozen clock spends its throttle on THAT clock: the pacer measures
// the batches by the run's `ctx.clock`, so it must also wait by it. Waiting a real timer under a
// clock that never moves meant every batch paid the whole interval in wall time — a 1,000-batch
// sweep in a test took 1,000 / rate real seconds.

import { describe, expect, test } from 'bun:test';
import { ctxOf, frozenClock } from '@ultimat3/core';
import { entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import { backfill } from './backfill';
import { DEFAULT_BACKFILL_RATE } from './backfill-rate';
import { stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';

const rows = entity('backfill_clock_rows', {
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }) },
});

type Row = typeof rows.$row;

/**
 * Enough that the old pacer needed 99 real intervals — 19.8 s at the default rate — and few enough
 * that the pass's own CPU (an in-memory repo scanned per page) stays far inside the wall budget.
 */
const BATCHES = 100;

const SEED: readonly Row[] = Array.from({ length: BATCHES }, (_, index) => ({
  id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
  title: `row-${String(index)}`,
}));

/**
 * The real-time budget the whole pass gets. Under the old pacer one interval alone (200ms at the
 * default rate) times 999 is minutes; the abort turns that into an `X_ABORTED` here, instead of a
 * test that hangs until the runner's own timeout says nothing about why.
 */
const WALL_BUDGET_MS = 2_000;

describe('a backfill under a frozen clock', () => {
  test('finishes every batch without wall time passing, and the clock carries the throttle', async () => {
    const clock = frozenClock('2026-08-14T00:00:00.000Z');
    const table = tableFor(rows, memoryRepo(rows, SEED));
    let swept = 0;
    const sweep = backfill<Row>({
      tenant: 'none',
      name: 'frozen-clock-sweep',
      batch: 1,
      source: () => table.where({}),
      handle: ({ rows: page }) => {
        swept += page.length;
      },
    });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), WALL_BUDGET_MS);
    const runner = stepRunner({
      runId: 'run-frozen',
      jobName: 'frozen-clock-sweep',
      store: memoryStepStore(),
      signal: controller.signal,
      clock,
    });

    const startedAt = performance.now();
    try {
      await sweep.run({
        input: {},
        step: runner.step,
        ctx: ctxOf({ clock }),
        attempt: 1,
        finalAttempt: false,
        progress: () => undefined,
        jobId: 'job-frozen',
        runId: 'run-frozen',
      });
    } finally {
      clearTimeout(deadline);
    }

    expect(swept).toBe(BATCHES);
    expect(performance.now() - startedAt).toBeLessThan(WALL_BUDGET_MS);
    // The rate still reached the loop — on the clock the run measures by. 100 batches are 99
    // intervals: the first batch has no previous one to be spaced from.
    expect(clock.now().toISOString()).toBe(
      new Date(
        Date.parse('2026-08-14T00:00:00.000Z') + (BATCHES - 1) * (1000 / DEFAULT_BACKFILL_RATE),
      ).toISOString(),
    );
  });
});
