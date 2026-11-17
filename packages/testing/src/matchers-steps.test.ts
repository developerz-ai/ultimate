// `recordSteps` drives a REAL `job()` through the documented step surface: the signal a step body
// is handed, `waitForEvent`, and a run's `ctx` / `attempt` / `progress` / `runId`.

import { describe, expect, test } from 'bun:test';
import { tryUseContext } from '@ultimat3/core';
import { job, t } from '@ultimat3/jobs';
import './matchers';
import { recordSteps } from './matchers';

const declared = { input: t.object({}), idempotencyKey: () => 'k' } as const;
const retry = { attempts: 1, backoff: 'exponential' } as const;

const fetcher = job({
  ...declared,
  tenant: 'none',
  name: 'matchers-steps-fetcher',
  retry,
  async run({ step }) {
    await step.run('fetch', async (signal) => (signal.aborted ? 0 : 1));
    await step.run('after', () => 2);
  },
});

const waiter = job({
  ...declared,
  tenant: 'none',
  name: 'matchers-steps-waiter',
  retry,
  async run({ step }) {
    await step.run('a', () => 1);
    const paid = await step.waitForEvent('paid', 'invoice.paid', {
      timeout: '1h',
      match: 'inv_1',
      schema: t.object({}),
    });
    // The timeout branch: the recorder never delivers an event.
    await step.run(paid === undefined ? 'timed-out' : 'paid-path', () => 2);
  },
});

const insistent = job({
  ...declared,
  tenant: 'none',
  name: 'matchers-steps-insistent',
  retry,
  async run({ step }) {
    await step.waitForEvent('paid', 'invoice.paid', {
      timeout: '2h',
      schema: t.object({}),
      required: true,
    });
    await step.run('never', () => 1);
  },
});

const seen: Record<string, unknown> = {};
const reader = job({
  ...declared,
  tenant: 'none',
  name: 'matchers-steps-reader',
  retry,
  async run({ step, ctx, attempt, finalAttempt, progress, runId, jobId }) {
    progress(0, 1);
    seen['attempt'] = attempt;
    seen['finalAttempt'] = finalAttempt;
    seen['runId'] = runId;
    seen['jobId'] = jobId;
    seen['role'] = ctx.role;
    seen['ambient'] = tryUseContext() === ctx;
    seen['signal'] = ctx.signal.aborted;
    await step.run('only', () => 1);
  },
});

describe('unit · recordSteps over a real job()', () => {
  test('a step body that reads its signal runs, and the sequence is recorded', async () => {
    expect(await recordSteps(fetcher)).toEqual(['fetch', 'after']);
    await expect(fetcher).toEmitSteps(['fetch', 'after']);
  });

  test('waitForEvent is a recorded step that answers the timeout branch', async () => {
    expect(await recordSteps(waiter)).toEqual(['a', 'paid', 'timed-out']);
    await expect(waiter).toEmitSteps(['a', 'paid', 'timed-out']);
  });

  test('a REQUIRED wait ends the run as the worker would: X_JOB_TIMEOUT, naming the step', async () => {
    const caught = await recordSteps(insistent).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeUltimateError('X_JOB_TIMEOUT');
    expect(String((caught as { cause?: unknown }).cause)).toContain(
      '"paid" exceeded its 7200000ms',
    );
    expect(String((caught as { fix?: unknown }).fix)).toContain('drop required: true');
  });

  test("the body gets a worker's ctx, installed as the ambient one, and attempt 1 of its run", async () => {
    expect(await recordSteps(reader)).toEqual(['only']);
    expect(seen['attempt']).toBe(1);
    // `retry.attempts: 1` — the runner's own `isFinalAttempt` answer.
    expect(seen['finalAttempt']).toBe(true);
    expect(typeof seen['runId']).toBe('string');
    expect(typeof seen['jobId']).toBe('string');
    expect(seen['role']).toBe('worker');
    expect(seen['ambient']).toBe(true);
    expect(seen['signal']).toBe(false);
  });
});
