// `step.run(name, fn, { once: true })`: a `started` record is written BEFORE `fn`, and a replay
// that finds it — or a `failed` one — without `completed` stops with `X_STEP_OUTCOME_UNKNOWN`
// and never calls `fn`. Only a person's resolution (`completed`, or `cleared`) moves it on.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { DEFAULT_RETRY } from './retry';
import { nextRetryForError } from './retry-classification';
import type { StepRecord, StepStore } from './steps';
import { stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';

// A foreign failure handed to the subject: test input, never its verdict.
const VENDOR_TIMED_OUT = new TypeError('the vendor timed out');

const runnerOn = (store: StepStore) => stepRunner({ runId: 'run-1', jobName: 'payout', store });

const outcomeOf = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => expect.unreachable('the step ran again'),
    (error: unknown) => error,
  );

describe('a once step', () => {
  test('writes started before fn runs, then completed', async () => {
    const base = memoryStepStore();
    const order: string[] = [];
    const store: StepStore = {
      ...base,
      put: async (record: StepRecord, by) => {
        order.push(`put:${record.status}`);
        await base.put(record, by);
      },
    };
    const answer = await runnerOn(store).step.run(
      'send',
      () => {
        order.push('fn');
        return 'sent';
      },
      { once: true },
    );
    expect(answer).toBe('sent');
    expect(order).toEqual(['put:started', 'fn', 'put:completed']);
  });

  test('a crash after started is an unknown outcome on replay, and fn is not called', async () => {
    const store = memoryStepStore();
    await store.put({ runId: 'run-1', name: 'send', status: 'started', startedAt: 1, attempts: 0 });
    let calls = 0;
    const error = await outcomeOf(
      runnerOn(store).step.run('send', () => (calls += 1), { once: true }),
    );
    expect(isUltimateError(error) && error.code).toBe('X_STEP_OUTCOME_UNKNOWN');
    expect(calls).toBe(0);
    // Terminal: the retry policy is not spent proving it again.
    expect(nextRetryForError(DEFAULT_RETRY, 1, error).retry).toBe(false);
  });

  test('a throw is an unknown outcome too: the vendor may have acted before it failed', async () => {
    const store = memoryStepStore();
    let calls = 0;
    const send = () =>
      runnerOn(store).step.run(
        'send',
        () => {
          calls += 1;
          throw VENDOR_TIMED_OUT;
        },
        { once: true },
      );
    expect(await outcomeOf(send())).toBe(VENDOR_TIMED_OUT);
    const replay = await outcomeOf(send());
    expect(isUltimateError(replay) && replay.code).toBe('X_STEP_OUTCOME_UNKNOWN');
    expect(calls).toBe(1);
  });

  test('resolved as ran, a replay answers the recorded output and never calls fn', async () => {
    const store = memoryStepStore();
    await store.put({
      runId: 'run-1',
      name: 'send',
      status: 'completed',
      output: { receipt: 'r-1' },
      startedAt: 1,
      attempts: 1,
    });
    let calls = 0;
    const answer = await runnerOn(store).step.run(
      'send',
      (): unknown => {
        calls += 1;
        return calls;
      },
      { once: true },
    );
    expect(answer).toEqual({ receipt: 'r-1' });
    expect(calls).toBe(0);
  });

  test('resolved as not ran (cleared), the next run calls fn once more', async () => {
    const store = memoryStepStore();
    await store.put({ runId: 'run-1', name: 'send', status: 'cleared', startedAt: 1, attempts: 1 });
    let calls = 0;
    const answer = await runnerOn(store).step.run('send', () => ++calls, { once: true });
    expect(answer).toBe(1);
    expect((await store.get('run-1', 'send'))?.status).toBe('completed');
  });

  test('a plain step that failed re-runs, as it always has — once is opt-in', async () => {
    const store = memoryStepStore();
    await store.put({ runId: 'run-1', name: 'send', status: 'failed', startedAt: 1, attempts: 1 });
    expect(await runnerOn(store).step.run('send', () => 'again')).toBe('again');
  });
});
