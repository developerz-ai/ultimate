// Nothing this package composes onto a signal it does not own may outlive the work it was composed
// for. `AbortSignal.any` cannot be undone, so both remaining sites held one dependent signal per
// step and per `executeJob` call, on a signal that may live as long as the process:
// `run-signal.ts`'s `dispose()` is the whole reason that file exists.
//
// The measurement is the mechanism itself. `AbortSignal.any` registers NO listener on its sources —
// the composite hangs off them internally, where nothing can count it — while `createRunSignal`
// adds one and removes it on `dispose`. So "one add per step, and zero live at the end" is exactly
// the pair that distinguishes the two, and a step count of zero adds IS the composite.

import { describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { createContext } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob, JobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { job, resetJobs } from './job';
import { createMemoryStepStore, createStepRunner } from './steps';

interface Watched {
  readonly signal: AbortSignal;
  /** Listeners added over this signal's life — zero means nothing was composed through the seam. */
  added(): number;
  /** Listeners still attached. Anything above zero at the end is what the run kept of the caller's. */
  live(): number;
}

/**
 * Counts `addEventListener`/`removeEventListener` on one controller's signal.
 *
 * Both replacements are ANNOTATED rather than inferred: `addEventListener` is overloaded on
 * `AbortSignal`, and TypeScript gives an assignment target with overloads no contextual parameter
 * types — so an unannotated parameter here is an implicit `any` nothing checks. Same reason
 * `run-signal.test.ts` spells them out.
 */
function watch(controller: AbortController): Watched {
  let added = 0;
  let live = 0;
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void => {
    added += 1;
    live += 1;
    add(type, listener, options);
  };
  signal.removeEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: EventListenerOptions | boolean,
  ): void => {
    live -= 1;
    remove(type, listener, options);
  };
  return { signal, added: () => added, live: () => live };
}

describe('unit · the step runner never composes onto the run signal permanently', () => {
  test('a declared stepTimeoutMs composes through the seam and hands every one back', async () => {
    const run = new AbortController();
    const watched = watch(run);
    const runner = createStepRunner({
      runId: 'run-1',
      jobName: 'backfillPrices',
      store: createMemoryStepStore(),
      signal: watched.signal,
      stepTimeoutMs: 60_000,
    });

    // A `backfill()` at `batch: 1000` over 5M rows is 5,000 of these on one run's signal.
    for (let page = 0; page < 25; page += 1) {
      await runner.step.run(`page:${page}`, () => page);
    }

    // `AbortSignal.any` would have added nothing here — the composite is invisible to a listener
    // count, which is exactly why it is untrackable and unreleasable.
    expect(watched.added()).toBe(25);
    // And nothing is still attached: `dispose()` runs in the step's own `finally`.
    expect(watched.live()).toBe(0);
  });

  test('a step that THREW still hands its composition back', async () => {
    const run = new AbortController();
    const watched = watch(run);
    const runner = createStepRunner({
      runId: 'run-2',
      jobName: 'backfillPrices',
      store: createMemoryStepStore(),
      signal: watched.signal,
      stepTimeoutMs: 60_000,
    });

    await expect(
      runner.step.run('boom', () => {
        throw new TypeError('page 3 is unreadable');
      }),
    ).rejects.toThrow('page 3 is unreadable');

    expect(watched.added()).toBe(1);
    expect(watched.live()).toBe(0);
  });

  test('no declared ceiling composes nothing at all', async () => {
    const run = new AbortController();
    const watched = watch(run);
    const runner = createStepRunner({
      runId: 'run-3',
      jobName: 'backfillPrices',
      store: createMemoryStepStore(),
      signal: watched.signal,
    });

    await runner.step.run('one', () => 1);
    // The run's own signal IS the step's signal when there is no second one to compose.
    expect(watched.added()).toBe(0);
  });
});

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

describe('unit · executeJob never composes onto the caller ctx permanently', () => {
  test("a run that ended holds nothing of the caller's signal", async () => {
    resetJobs();
    const handle = job<{ n: number }>({
      tenant: 'none',
      name: 'composed',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `composed:${n}`,
      retry: { attempts: 1, jitter: false },
      run: () => Promise.resolve(undefined),
    });
    const driver: JobDriver = createMemoryDriver();
    await driver.enqueue({
      name: 'composed',
      queue: 'default',
      input: { n: 1 },
      idempotencyKey: 'composed:1',
      maxAttempts: 1,
    });
    const claimed = (
      await driver.claim({
        queues: ['default'],
        limit: 1,
        visibilityTimeoutMs: 30_000,
        workerId: 'worker-test',
      })
    )[0] as ClaimedJob;

    // A process-lifetime controller is exactly what `WorkerOptions.context()` may hand over, and
    // the `@ultimat3/testing` job fixture calls `executeJob` with it directly.
    const process = new AbortController();
    const watched = watch(process);
    const ctx: Ctx = Object.freeze({
      ...createContext({ role: 'worker', buildId: 'test' }),
      signal: watched.signal,
    });

    await executeJob({ driver, claimed, handle: handle as AnyJobHandle, ctx });

    expect(watched.added()).toBe(1);
    expect(watched.live()).toBe(0);
  });
});
