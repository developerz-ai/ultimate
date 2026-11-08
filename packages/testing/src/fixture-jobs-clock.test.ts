// `runJobs` runs a body on the preload's frozen clock, not the system clock: a `backfill()` drained
// through it spends its `rate` throttle by moving that clock, so a 100-batch sweep finishes in
// milliseconds of wall time. On the system clock the pacer saw every batch as instant and slept a
// real 200ms for each. The preload resets the instant at the file boundary (`clock-file-boundary.test.ts`).

import { afterEach, describe, expect, test } from 'bun:test';
import { type Actor, serviceActor } from '@ultimat3/core';
import { entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import { backfill, DEFAULT_BACKFILL_RATE, resetJobDriver } from '@ultimat3/jobs';
import { frozenNow } from './determinism';
import { type RunJobs, testJobs } from './fixture-jobs';

const rows = entity('fixture_jobs_clock_rows', {
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }) },
});

type Row = typeof rows.$row;

/** The old pacer needed 99 real intervals here: 19.8 s at the default rate. */
const BATCHES = 100;
/** Far above the pass's own CPU, a tenth of what the old pacer slept. */
const WALL_BUDGET_MS = 2_000;

const SEED: readonly Row[] = Array.from({ length: BATCHES }, (_, index) => ({
  id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
  title: `row-${String(index)}`,
}));

let swept = 0;
const table = tableFor(rows, memoryRepo(rows, SEED));
/**
 * One declaration per test: the pacer belongs to the declaration and is shared by every run of it,
 * so a second pass of the same one is spaced from the first pass's last batch — one interval more.
 */
const declare = (name: string) =>
  backfill<Row>({
    tenant: 'none',
    name,
    batch: 1,
    source: () => table.where({}),
    handle: ({ rows: page }) => {
      swept += page.length;
    },
  });
const asWorker = declare('fixture-jobs-clock-sweep');
const asActor = declare('fixture-jobs-clock-sweep-as');

let runJobs: RunJobs | undefined;

afterEach(async () => {
  await runJobs?.[Symbol.asyncDispose]();
  runJobs = undefined;
  resetJobDriver();
});

/** One pass, timed on both clocks. `actor` takes the fixture's other worker-context branch. */
const sweepOnce = async (
  sweep: typeof asWorker,
  actor?: Actor,
): Promise<{ wallMs: number; frozenMs: number }> => {
  runJobs = await testJobs();
  swept = 0;
  const startedAt = frozenNow().getTime();
  const wallAt = performance.now();
  // No signal reaches a drained body, so the old fixture fails on bun's own 5 s test timeout:
  // 99 real intervals of 200ms are 19.8 s.
  const trace = await runJobs(sweep, {}, actor === undefined ? {} : { actor });
  expect(trace.executions.at(-1)?.outcome).toBe('completed');
  expect(swept).toBe(BATCHES);
  return { wallMs: performance.now() - wallAt, frozenMs: frozenNow().getTime() - startedAt };
};

describe('runJobs on the frozen clock', () => {
  test('a backfill drains without wall time, the throttle spent on the frozen clock', async () => {
    const { wallMs, frozenMs } = await sweepOnce(asWorker);

    expect(wallMs).toBeLessThan(WALL_BUDGET_MS);
    expect(frozenMs).toBe((BATCHES - 1) * (1000 / DEFAULT_BACKFILL_RATE));
  });

  test('a drain as a named actor runs on the same frozen clock', async () => {
    const { wallMs, frozenMs } = await sweepOnce(
      asActor,
      serviceActor({ id: 'sweeper', scopes: ['backfill:run'] }),
    );

    expect(wallMs).toBeLessThan(WALL_BUDGET_MS);
    expect(frozenMs).toBe((BATCHES - 1) * (1000 / DEFAULT_BACKFILL_RATE));
  });
});
