// A step whose side effect completed while the worker's drain was cutting the run short is a step
// that RAN: refusing its record hands the next worker a step to run a second time. The drain's
// reason writes through — the store write is fenced on the claim, so a row already handed back
// refuses it there. Every other cancellation still writes nothing.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { JobAbortedError, JobDrainedError } from './errors';
import type { StepFence, StepRecord, StepStore } from './steps';
import { createStepRunner } from './steps';
import { memoryStepStore } from './steps-memory';

const FENCE: StepFence = { job: 'charge', jobId: 'job-1', workerId: 'w-1', claim: 1 };

/** The memory store, recording the fence every write came with. */
function fencedStore(): StepStore & { readonly fences: (StepFence | undefined)[] } {
  const inner = memoryStepStore();
  const fences: (StepFence | undefined)[] = [];
  return {
    ...inner,
    fences,
    put(record: StepRecord, by?: StepFence) {
      fences.push(by);
      return inner.put(record, by);
    },
  };
}

const drained = (): JobDrainedError => new JobDrainedError({ workerId: 'w-1', signal: 'SIGTERM' });

/** Runs one step that aborts the run with `reason` as its side effect completes. */
async function stepAbortedMidway(
  reason: unknown,
  options: { readonly fence?: StepFence; readonly ended?: AbortSignal } = {},
): Promise<{ readonly store: ReturnType<typeof fencedStore>; readonly outcome: unknown }> {
  const store = fencedStore();
  const run = new AbortController();
  const runner = createStepRunner({
    runId: 'run-1',
    jobName: 'charge',
    store,
    signal: run.signal,
    ...(options.fence === undefined ? {} : { fence: options.fence }),
    ...(options.ended === undefined ? {} : { ended: options.ended }),
  });
  const outcome = await runner.step
    .run('charge', () => {
      run.abort(reason);
      return 'charged';
    })
    .catch((error: unknown) => error);
  return { store, outcome };
}

describe('the drain does not lose a step that completed', () => {
  test('a step finishing after the drain cut the run short is recorded, fenced on the claim', async () => {
    const { store, outcome } = await stepAbortedMidway(drained(), { fence: FENCE });

    expect(outcome).toBe('charged');
    expect((await store.get('run-1', 'charge'))?.status).toBe('completed');
    expect(store.fences).toEqual([FENCE]);
  });

  test('a lease lost or a run cancelled still writes nothing', async () => {
    for (const reason of [
      new JobAbortedError({ job: 'charge' }),
      new UltimateError({ code: 'X_JOB_LEASE_LOST', cause: 'lapsed', fix: 'none' }),
    ]) {
      const { store, outcome } = await stepAbortedMidway(reason, { fence: FENCE });
      expect(outcome).toBeInstanceOf(JobAbortedError);
      expect(await store.get('run-1', 'charge')).toBeUndefined();
    }
  });

  test('without a fence the drain reason writes nothing — no claim would guard it', async () => {
    const { store, outcome } = await stepAbortedMidway(drained());

    expect(outcome).toBeInstanceOf(JobAbortedError);
    expect(await store.get('run-1', 'charge')).toBeUndefined();
  });

  test('once the attempt has ended, the drain reason writes nothing either', async () => {
    const ended = new AbortController();
    ended.abort(new JobAbortedError({ job: 'charge' }));
    const { store, outcome } = await stepAbortedMidway(drained(), {
      fence: FENCE,
      ended: ended.signal,
    });

    expect(outcome).toBeInstanceOf(JobAbortedError);
    expect(await store.get('run-1', 'charge')).toBeUndefined();
  });
});
