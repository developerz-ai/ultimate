import { beforeEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { StepDuplicateError } from './errors';
import { createMemoryEventBus } from './events';
import type { StepStore } from './steps';
import { createMemoryStepStore, createStepRunner, isStepSuspension } from './steps';

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

let store: StepStore;

beforeEach(() => {
  store = createMemoryStepStore();
});

describe('step.run replay', () => {
  test('a completed step is served from storage on the next attempt, not re-executed', async () => {
    let provisionCalls = 0;
    let emailCalls = 0;

    const attempt = async (failEmail: boolean): Promise<void> => {
      const runner = createStepRunner({ runId: 'run-1', jobName: 'onboardOrg', store });
      const org = await runner.step.run('provision', () => {
        provisionCalls += 1;
        return { id: 'org-1', name: 'Acme' };
      });
      await runner.step.run('welcome-email', () => {
        emailCalls += 1;
        if (failEmail) throw new Error('smtp down');
        return `sent to ${org.name}`;
      });
    };

    await expect(attempt(true)).rejects.toThrow('smtp down');
    expect(provisionCalls).toBe(1);
    expect(emailCalls).toBe(1);

    // Retry: `provision` must NOT run again — that is the whole point of durable steps.
    await attempt(false);
    expect(provisionCalls).toBe(1);
    expect(emailCalls).toBe(2);

    const records = await store.list('run-1');
    expect(records.map((record) => [record.name, record.status])).toEqual([
      ['provision', 'completed'],
      ['welcome-email', 'completed'],
    ]);
  });

  test('the persisted output is returned verbatim on replay', async () => {
    const first = createStepRunner({ runId: 'run-2', jobName: 'j', store });
    const value = await first.step.run('compute', () => ({ total: 42, currency: 'EUR' }));
    expect(value).toEqual({ total: 42, currency: 'EUR' });

    const second = createStepRunner({ runId: 'run-2', jobName: 'j', store });
    const replayed = await second.step.run<{ total: number; currency: string }>('compute', () => {
      throw new Error('must not run');
    });
    expect(replayed).toEqual({ total: 42, currency: 'EUR' });
    expect(second.replayedNames()).toEqual(['compute']);
  });

  test('a duplicate step name in one run fails with X_STEP_DUPLICATE', async () => {
    const runner = createStepRunner({ runId: 'run-3', jobName: 'j', store });
    await runner.step.run('same', () => 1);
    await expect(runner.step.run('same', () => 2)).rejects.toThrow(StepDuplicateError);
  });

  test('a failed step records the error and re-executes on the next attempt', async () => {
    const runner = createStepRunner({ runId: 'run-4', jobName: 'j', store });
    await expect(
      runner.step.run('flaky', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const record = await store.get('run-4', 'flaky');
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('boom');

    const retry = createStepRunner({ runId: 'run-4', jobName: 'j', store });
    await expect(retry.step.run('flaky', () => 'ok')).resolves.toBe('ok');
    expect((await store.get('run-4', 'flaky'))?.status).toBe('completed');
  });
});

describe('step.sleep', () => {
  test('suspends the run, then resumes past the wake time without re-running earlier steps', async () => {
    const clock = fakeClock(T0);
    let nudges = 0;
    let provisions = 0;

    const attempt = async (): Promise<void> => {
      const runner = createStepRunner({ runId: 'run-5', jobName: 'onboardOrg', store, clock });
      await runner.step.run('provision', () => {
        provisions += 1;
        return 'org';
      });
      await runner.step.sleep('nudge-delay', '3d');
      await runner.step.run('nudge', () => {
        nudges += 1;
        return 'nudged';
      });
    };

    const suspension = await attempt().catch((error: unknown) => error);
    expect(isStepSuspension(suspension)).toBe(true);
    if (!isStepSuspension(suspension)) throw new Error('expected a suspension');
    expect(suspension.reason).toBe('sleep');
    expect(suspension.resumeAt).toBe(T0 + 3 * 86_400_000);
    expect(nudges).toBe(0);

    // Woken too early: still suspended, still no nudge.
    clock.advance(86_400_000);
    expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);
    expect(nudges).toBe(0);

    clock.advance(2 * 86_400_000);
    await attempt();
    expect(nudges).toBe(1);
    expect(provisions).toBe(1);
    expect((await store.get('run-5', 'nudge-delay'))?.status).toBe('completed');
  });

  test('the single-argument form derives a deterministic step name', async () => {
    const clock = fakeClock(T0);
    const runner = createStepRunner({ runId: 'run-6', jobName: 'j', store, clock });
    await runner.step.sleep('30s').catch(() => undefined);
    expect((await store.get('run-6', 'sleep:30s'))?.wakeAt).toBe(T0 + 30_000);
  });
});

describe('step.waitForEvent', () => {
  test('suspends until a correlated event is published, then returns its payload', async () => {
    const clock = fakeClock(T0);
    const events = createMemoryEventBus({ clock });

    const attempt = (): Promise<unknown> => {
      const runner = createStepRunner({
        runId: 'run-7',
        jobName: 'awaitApproval',
        store,
        clock,
        events,
      });
      return runner.step.waitForEvent('approval', 'invoice.approved', {
        match: 'inv-1',
        timeout: '1h',
      });
    };

    const suspension = await attempt().catch((error: unknown) => error);
    expect(isStepSuspension(suspension)).toBe(true);

    // Wrong correlation key must not wake the run.
    await events.publish('invoice.approved', { by: 'other' }, { correlationKey: 'inv-2' });
    clock.advance(30_000);
    expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);

    await events.publish('invoice.approved', { by: 'ada' }, { correlationKey: 'inv-1' });
    clock.advance(30_000);
    expect(await attempt()).toEqual({ by: 'ada' });
  });

  test('an optional wait resolves undefined once its timeout passes', async () => {
    const clock = fakeClock(T0);
    const events = createMemoryEventBus({ clock });
    const attempt = (): Promise<unknown> => {
      const runner = createStepRunner({ runId: 'run-8', jobName: 'j', store, clock, events });
      return runner.step.waitForEvent('maybe', 'never.happens', { timeout: '1m' });
    };

    expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);
    clock.advance(61_000);
    expect(await attempt()).toBeUndefined();
  });
});
