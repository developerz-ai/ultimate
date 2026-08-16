// J10: a `backfill()` resume was O(completed batches) in ROUND TRIPS. Every `step.run` did one
// `store.get`, so 5M rows at `batch: 1000` killed at batch 4,800 issued 4,800 sequential
// `SQL_STEP_GET`s before reading a single new row — re-paid on every retry, and on a slow pool
// outrunning its own visibility timeout while the heartbeat was still renewing.

import { describe, expect, test } from 'bun:test';
import type { StepStore } from './steps';
import { createMemoryStepStore, createStepRunner, MAX_TRACE_NAMES } from './steps';

function counting(inner: StepStore): StepStore & { gets: number; lists: number } {
  const counters = { gets: 0, lists: 0 };
  return {
    get gets() {
      return counters.gets;
    },
    get lists() {
      return counters.lists;
    },
    get(runId, name) {
      counters.gets += 1;
      return inner.get(runId, name);
    },
    put: (record) => inner.put(record),
    list(runId) {
      counters.lists += 1;
      return inner.list(runId);
    },
    del: (runId, name) => inner.del(runId, name),
    clear: (runId) => inner.clear(runId),
  } as StepStore & { gets: number; lists: number };
}

describe('step replay', () => {
  test('a resume costs ONE list, never one get per completed step', async () => {
    const inner = createMemoryStepStore();
    // A first attempt that got through 500 batches.
    for (let i = 0; i < 500; i += 1) {
      await inner.put({
        runId: 'run-1',
        name: `batch:${i}`,
        status: 'completed',
        output: i,
        startedAt: i,
        completedAt: i,
        attempts: 1,
      });
    }

    const store = counting(inner);
    const runner = createStepRunner({ runId: 'run-1', jobName: 'backfillOrgs', store });

    let executed = 0;
    for (let i = 0; i < 501; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- the sequence IS the thing under test
      await runner.step.run(`batch:${i}`, () => {
        executed += 1;
        return Promise.resolve(i);
      });
    }

    expect(store.lists).toBe(1);
    expect(store.gets).toBe(0);
    // Only the one new batch ran; the 500 before it replayed from the hydrated view.
    expect(executed).toBe(1);
  });

  test('replay still returns the PERSISTED output, not a re-execution', async () => {
    const inner = createMemoryStepStore();
    await inner.put({
      runId: 'run-1',
      name: 'charge',
      status: 'completed',
      output: { chargeId: 'ch_1' },
      startedAt: 1,
      completedAt: 2,
      attempts: 1,
    });
    const runner = createStepRunner({ runId: 'run-1', jobName: 'checkout', store: inner });
    const result = await runner.step.run('charge', () =>
      Promise.resolve({ chargeId: 'ch_SHOULD_NOT_HAPPEN' }),
    );
    expect(result).toEqual({ chargeId: 'ch_1' });
  });

  test('a step written in THIS attempt is visible to the view it wrote through', async () => {
    // The hydrated map is only sound if every write goes into it. A `put` that missed would let a
    // later read of the same run see a stale absence.
    const inner = createMemoryStepStore();
    const store = counting(inner);
    const runner = createStepRunner({ runId: 'run-1', jobName: 'x', store });
    await runner.step.run('a', () => Promise.resolve(1));
    expect(await store.list('run-1')).toHaveLength(1);
  });

  test('sleeps and waits go through the BOUNDED trace, not an unbounded push', async () => {
    // `trace()` is what enforces `MAX_TRACE_NAMES`; `replayed.push` bypassed it, so a long run's
    // replayed-name array grew without limit — the exact leak the trace bound exists to prevent.
    const inner = createMemoryStepStore();
    const total = MAX_TRACE_NAMES + 50;
    for (let i = 0; i < total; i += 1) {
      await inner.put({
        runId: 'run-1',
        name: `sleep:${i}`,
        status: 'completed',
        startedAt: i,
        completedAt: i,
        attempts: 1,
      });
    }
    const runner = createStepRunner({ runId: 'run-1', jobName: 'drip', store: inner });
    for (let i = 0; i < total; i += 1) await runner.step.sleep(`sleep:${i}`, '1s');

    expect(runner.replayedNames()).toHaveLength(MAX_TRACE_NAMES);
    // Most recent kept: the tail of a long run is the half an operator is reading.
    expect(runner.replayedNames().at(-1)).toBe(`sleep:${total - 1}`);
  });
});
