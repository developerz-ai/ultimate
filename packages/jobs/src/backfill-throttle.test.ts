// The `rate` throttle, at both ends: the pacer's arithmetic against an injected clock, and a real
// `backfill()` pass proving the declared rate actually reaches the batch loop. Its own file, and
// its own entity, because `backfill-pass.test.ts` is about the iteration and every harness there
// declares a rate no timer can resolve so that nothing in it sleeps.
//
// What the ordering assertions exist for: the wait is spent INSIDE each batch's `step.run`, so a
// completed step replays from storage without re-paying its pause. Paced outside the step, a
// backfill resuming at batch 500 would spend the whole throttle of 500 batches it had already done.

import { describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { createContext, frozenClock } from '@ultimat3/core';
import { entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import type { BackfillDefinition } from './backfill';
import { backfill } from './backfill';
import { backfillPass } from './backfill-pass';
import { createPacer, DEFAULT_BACKFILL_RATE } from './backfill-rate';
import { createMemoryStepStore, createStepRunner } from './steps';

const rows = entity('backfill_rate_rows', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text({ max: 40 }) },
});

type Row = typeof rows.$row;

const ORG = '00000000-0000-7000-8000-0000000000b1';

const id = (index: number): string => `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

const SEED: readonly Row[] = Array.from({ length: 12 }, (_, index) => ({
  id: id(index),
  orgId: ORG,
  title: `row-${String(index)}`,
}));

const RUN_ID = 'run-paced-1';
const ctx: Ctx = createContext();

/** What a paced pass records: the waits it asked for, and where they fell among its statements. */
interface Throttled {
  /** Every wait the pass asked for, in ms. A wait the pacer skipped never appears. */
  readonly asked: readonly number[];
  /** Statements and waits in one list, so their ORDER is what the assertion reads. */
  readonly log: readonly string[];
  readonly seen: readonly (readonly string[])[];
  readonly failOn: Set<number>;
  run(): Promise<unknown>;
}

/**
 * A pass whose pacer is one the test can watch: the plan is built here rather than by `backfill()`
 * so the sleep is bookkeeping instead of time, and every statement lands in the same list as every
 * wait — which is how "the wait comes before the pull" is asserted rather than assumed.
 */
const throttled = (rate: number): Throttled => {
  const clock = frozenClock('2026-08-14T00:00:00.000Z');
  const asked: number[] = [];
  const log: string[] = [];
  const seen: string[][] = [];
  const failOn = new Set<number>();
  const store = createMemoryStepStore();
  const base = memoryRepo(rows, SEED);
  const table = tableFor(rows, {
    ...base,
    findMany: async (args) => {
      log.push('read');
      return base.findMany(args);
    },
  });
  const definition: BackfillDefinition<Row> = {
    name: 'paced-sweep',
    source: () => table.where({ orgId: ORG }),
    handle: ({ rows: page, index }) => {
      if (failOn.has(index)) throw new Error(`batch ${String(index)} failed`);
      seen.push(page.map((entry) => entry.title));
    },
  };
  const pace = createPacer({
    rate,
    job: definition.name,
    clock,
    sleep: (ms) => {
      log.push('wait');
      asked.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    },
  });
  return {
    asked,
    log,
    seen,
    failOn,
    run: (): Promise<unknown> =>
      backfillPass(
        { definition, size: 3, checksum: 'paced-checksum', pace },
        {
          input: {},
          step: createStepRunner({ runId: RUN_ID, jobName: 'paced', store }).step,
          ctx,
          attempt: 1,
          jobId: 'job-paced',
          runId: RUN_ID,
        },
      ),
  };
};

describe('the rate throttle', () => {
  test('spaces the batches at the declared rate, waiting BEFORE each statement', async () => {
    const pass = throttled(5);

    await pass.run();

    // Four batches, three intervals: the first has no previous batch to be spaced from.
    expect(pass.asked).toEqual([200, 200, 200]);
    expect(pass.log).toEqual(['read', 'wait', 'read', 'wait', 'read', 'wait', 'read']);
    expect(pass.seen).toHaveLength(4);
  });

  test('a resumed attempt pays for the batches it runs, never for the ones it replays', async () => {
    const pass = throttled(5);
    pass.failOn.add(2);
    await expect(pass.run()).rejects.toThrow('batch 2 failed');
    expect(pass.asked).toEqual([200, 200]);

    pass.failOn.clear();
    await pass.run();

    // Batches 0 and 1 came back from storage without their bodies running, so the resumed attempt
    // paced only batch 2 and batch 3. Paced outside the step, this pass would have waited six
    // times for four batches — and a backfill resuming at batch 500 would re-pay all 500 pauses.
    expect(pass.asked).toEqual([200, 200, 200, 200]);
    expect(pass.seen).toHaveLength(4);
  });

  test('the default is the one a definition that says nothing sweeps under', () => {
    // Pinned as arithmetic rather than as a number: the doc comment promises 5,000 rows/sec at
    // `DEFAULT_BACKFILL_BATCH`, and a default raised without that promise being revisited is the
    // change this assertion exists to stop.
    expect(1000 / DEFAULT_BACKFILL_RATE).toBe(200);
  });

  test('a declared rate throttles the real pass, and cancelling it leaves the wait at once', async () => {
    // Real timers, the shipped sleeper, and `backfill()` rather than a hand-built plan: this is the
    // end-to-end claim that `rate:` on a definition reaches the batch loop at all.
    const store = createMemoryStepStore();
    const seen: string[][] = [];
    const table = tableFor(rows, memoryRepo(rows, SEED));
    const slow = backfill<Row>({
      name: 'slow-sweep',
      batch: 3,
      rate: 0.5,
      source: () => table.where({ orgId: ORG }),
      handle: ({ rows: page }) => {
        seen.push(page.map((entry) => entry.title));
      },
    });
    const controller = new AbortController();
    const runner = createStepRunner({
      runId: 'run-slow',
      jobName: 'slow-sweep',
      store,
      signal: controller.signal,
    });
    const running = slow.run({
      input: {},
      step: runner.step,
      ctx,
      attempt: 1,
      jobId: 'job-slow',
      runId: 'run-slow',
    });

    await Bun.sleep(25);
    // Unthrottled this pass is over in microtasks — `memoryRepo` never touches a socket. One batch
    // in 25ms is the two-second interval actually being spent.
    expect(seen).toHaveLength(1);

    const abortedAt = performance.now();
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'X_ABORTED' });

    // The attempt no longer owns the run, so the wait ends with it and not with the slot.
    expect(performance.now() - abortedAt).toBeLessThan(1_000);
    expect(seen).toHaveLength(1);
  });
});
