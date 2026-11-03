// A step's end: a cancelled run writes nothing, a timeout cancels the body it times and names its
// option, the trace is bounded, a replay is one value on every store. Split out of `steps.test.ts`.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { StepDuplicateError } from './errors';
import { memoryEventBus } from './events';
import type { StepStore } from './steps';
import { isStepSuspension, MAX_TRACE_NAMES, stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';

function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  } as Clock & { advance(ms: number): void };
}

const T0 = 1_760_000_000_000;

/** The wait in tests that never reach a payload: nothing is published, so nothing is parsed. */
const NOTHING = t.object({});

let store: StepStore;

beforeEach(() => {
  store = memoryStepStore();
});

/**
 * A cancelled attempt has lost its lease: the deadline nacked the job and another worker owns
 * this `runId` now. So the runner writes nothing more — a late `completed` would hand the new
 * attempt a step it never ran, and a late `failed` would erase one it did.
 */
describe('a cancelled run writes nothing', () => {
  const cancelled = (): AbortSignal => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  };

  test('a step that finishes after the cancel is refused instead of recorded', async () => {
    const runner = stepRunner({
      runId: 'run-9',
      jobName: 'j',
      store,
      signal: cancelled(),
    });

    await expect(runner.step.run('late', () => 'done')).rejects.toThrow(/X_ABORTED/);
    expect(await store.get('run-9', 'late')).toBeUndefined();
  });

  test('a step that fails after the cancel leaves the live record alone', async () => {
    // What the attempt that replaced this one has already put there.
    await store.put({
      runId: 'run-10',
      name: 'shared',
      status: 'completed',
      output: 'from the live attempt',
      startedAt: T0,
      attempts: 1,
    });
    const runner = stepRunner({
      runId: 'run-10',
      jobName: 'j',
      store,
      signal: cancelled(),
    });

    // `run` replays a completed step, so reach the failure path through a fresh name.
    await expect(
      runner.step.run('shared-2', () => {
        throw new TypeError('the dependency is down');
      }),
    ).rejects.toThrow('the dependency is down');
    expect(await store.get('run-10', 'shared-2')).toBeUndefined();
    expect((await store.get('run-10', 'shared'))?.output).toBe('from the live attempt');
  });

  test('sleep and waitForEvent are fenced by the same signal', async () => {
    const clock = fakeClock(T0);
    const runner = stepRunner({
      runId: 'run-11',
      jobName: 'j',
      store,
      clock,
      signal: cancelled(),
    });

    await expect(runner.step.sleep('30s')).rejects.toThrow(/X_ABORTED/);
    await expect(
      runner.step.waitForEvent('maybe', 'never.happens', { schema: NOTHING }),
    ).rejects.toThrow(/X_ABORTED/);
    expect(await store.list('run-11')).toEqual([]);
  });
});

describe('a step timeout cancels the body it is timing', () => {
  test('the signal handed to the step aborts before the step is failed', async () => {
    let observed: AbortSignal | undefined;
    const runner = stepRunner({
      runId: 'run-12',
      jobName: 'j',
      store,
      stepTimeoutMs: 5,
    });

    await expect(
      runner.step.run('slow', async (signal) => {
        observed = signal;
        await Bun.sleep(40);
        return 'done';
      }),
    ).rejects.toThrow(/X_JOB_TIMEOUT/);
    // The failure is recorded — this run is still ours, only the step's ceiling passed — but the
    // body was told to stop first, so it is not still working beside the retry.
    expect(observed?.aborted).toBe(true);
    expect((await store.get('run-12', 'slow'))?.status).toBe('failed');
  });

  test('the run signal reaches the body too, so one check covers both deadlines', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const runner = stepRunner({
      runId: 'run-13',
      jobName: 'j',
      store,
      stepTimeoutMs: 10_000,
      signal: controller.signal,
    });

    const running = runner.step.run('watching', async (signal) => {
      observed = signal;
      await Bun.sleep(5);
      return 'done';
    });
    controller.abort();
    await expect(running).rejects.toThrow(/X_ABORTED/);

    expect(observed?.aborted).toBe(true);
  });
});

describe('the attempt trace is bounded, and duplicate detection is not', () => {
  // `Array.includes` per claim made a long run quadratic: 20,000 steps is ~200M string compares
  // plus a 20,000-entry array carried to the end of the run and read by `x jobs show`.
  test('keeps the most recent MAX_TRACE_NAMES names, not one per step', async () => {
    const runner = stepRunner({ runId: 'run-long', jobName: 'sweep', store });

    for (let i = 0; i < MAX_TRACE_NAMES * 3; i += 1) {
      await runner.step.run(`batch:${i}`, () => i);
    }

    const used = runner.usedNames();
    expect(used).toHaveLength(MAX_TRACE_NAMES);
    expect(used[used.length - 1]).toBe(`batch:${MAX_TRACE_NAMES * 3 - 1}`);
  });

  // The trace forgetting a name must never make it re-claimable: the store is keyed by it.
  test('still refuses a duplicate whose name scrolled out of the trace', async () => {
    const runner = stepRunner({ runId: 'run-dup', jobName: 'sweep', store });

    await runner.step.run('batch:0', () => 0);
    for (let i = 1; i <= MAX_TRACE_NAMES * 2; i += 1) {
      await runner.step.run(`batch:${i}`, () => i);
    }

    expect(runner.usedNames()).not.toContain('batch:0');
    await expect(runner.step.run('batch:0', () => 0)).rejects.toThrow(StepDuplicateError);
  });

  test('bounds the replay trace the same way', async () => {
    const first = stepRunner({ runId: 'run-replay', jobName: 'sweep', store });
    for (let i = 0; i < MAX_TRACE_NAMES + 10; i += 1) {
      await first.step.run(`batch:${i}`, () => i);
    }

    const second = stepRunner({ runId: 'run-replay', jobName: 'sweep', store });
    for (let i = 0; i < MAX_TRACE_NAMES + 10; i += 1) {
      await second.step.run(`batch:${i}`, () => i);
    }

    expect(second.replayedNames()).toHaveLength(MAX_TRACE_NAMES);
  });
});

/**
 * A replay answers the same value on every driver. The memory store kept the live REFERENCE and
 * the pg store `JSON.stringify(output ?? null)`, so a `Date` step output replayed as a `Date` in
 * tests and as a string in production — and a `waitForEvent` timeout replayed as `null` on pg,
 * where `evt === undefined` then read as "an event arrived". `wire` is the pg store's own reading:
 * JSON on the way in, `row.output` on the way out.
 */
describe('a replay is the same value on every store', () => {
  const wire = (): StepStore => {
    const inner = memoryStepStore();
    return {
      ...inner,
      put: (record) =>
        inner.put({ ...record, output: JSON.parse(JSON.stringify(record.output ?? null)) }),
    };
  };

  for (const [label, make] of [
    ['memory', memoryStepStore],
    ['wire (postgres)', wire],
  ] as const) {
    test(`${label}: a Date output replays as what the store persisted, identically`, async () => {
      const on = make();
      const at = new Date(T0);
      const first = stepRunner({ runId: 'run-p', jobName: 'j', store: on });
      await first.step.run('stamp', () => ({ at }));
      const second = stepRunner({ runId: 'run-p', jobName: 'j', store: on });
      const replayed = await second.step.run('stamp', () => ({ at: new Date(0) }));
      expect(replayed).toEqual({ at: at.toISOString() });
    });

    test(`${label}: a timed-out wait replays as undefined, never null`, async () => {
      const on = make();
      const clock = fakeClock(T0);
      const events = memoryEventBus({ clock });
      const attempt = (): Promise<unknown> =>
        stepRunner({
          runId: 'run-t',
          jobName: 'j',
          store: on,
          clock,
          events,
        }).step.waitForEvent('maybe', 'never.happens', { schema: NOTHING, timeout: '1m' });
      expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);
      clock.advance(61_000);
      expect(await attempt()).toBeUndefined();
      // The replay — the record is `completed` now, and this is what a retry reads.
      expect(await attempt()).toBeUndefined();
    });
  }
});

/** `X_JOB_TIMEOUT`'s `fix:` names the knob that set the ceiling; the job's `timeout` set neither. */
describe('a timeout names the option that set it', () => {
  test('a step ceiling names stepTimeout', async () => {
    const thrown = await stepRunner({ runId: 'run-k1', jobName: 'j', store, stepTimeoutMs: 1 })
      .step.run('slow', () => new Promise<void>(() => undefined))
      .catch((error: unknown) => error);
    if (!isUltimateError(thrown)) return expect.unreachable('expected X_JOB_TIMEOUT');
    expect(thrown.code).toBe('X_JOB_TIMEOUT');
    expect(thrown.fix).toContain('stepTimeout');
  });

  test("a required wait names the wait's own timeout", async () => {
    const clock = fakeClock(T0);
    const events = memoryEventBus({ clock });
    const attempt = () =>
      stepRunner({ runId: 'run-k2', jobName: 'j', store, clock, events })
        .step.waitForEvent('otp', 'otp.entered', { schema: NOTHING, timeout: '1m', required: true })
        .catch((error: unknown) => error);
    expect(isStepSuspension(await attempt())).toBe(true);
    clock.advance(61_000);
    const thrown = await attempt();
    if (!isUltimateError(thrown)) return expect.unreachable('expected X_JOB_TIMEOUT');
    expect(thrown.code).toBe('X_JOB_TIMEOUT');
    expect(thrown.fix).toContain("step.waitForEvent('otp'");
    expect(thrown.fix).not.toContain('job definition');
  });
});
