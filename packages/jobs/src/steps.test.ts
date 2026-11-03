import { beforeEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { StepDuplicateError } from './errors';
import { memoryEventBus } from './events';
import { DEFAULT_RETRY } from './retry';
import { nextRetryForError } from './retry-classification';
import type { StepStore } from './steps';
import { isStepSuspension, stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';

// A foreign failure handed to the subject: test input, never its verdict.
const POOL_BLIPPED = new TypeError('the pool blipped');

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

describe('step.run replay', () => {
  test('a completed step is served from storage on the next attempt, not re-executed', async () => {
    let provisionCalls = 0;
    let emailCalls = 0;

    const attempt = async (failEmail: boolean): Promise<void> => {
      const runner = stepRunner({ runId: 'run-1', jobName: 'onboardOrg', store });
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
    const first = stepRunner({ runId: 'run-2', jobName: 'j', store });
    const value = await first.step.run('compute', () => ({ total: 42, currency: 'EUR' }));
    expect(value).toEqual({ total: 42, currency: 'EUR' });

    const second = stepRunner({ runId: 'run-2', jobName: 'j', store });
    const replayed = await second.step.run<{ total: number; currency: string }>('compute', () => {
      throw new Error('must not run');
    });
    expect(replayed).toEqual({ total: 42, currency: 'EUR' });
    expect(second.replayedNames()).toEqual(['compute']);
  });

  test('a duplicate step name in one run fails with X_STEP_DUPLICATE', async () => {
    const runner = stepRunner({ runId: 'run-3', jobName: 'j', store });
    await runner.step.run('same', () => 1);
    await expect(runner.step.run('same', () => 2)).rejects.toThrow(StepDuplicateError);
  });

  test('a failed step records the error and re-executes on the next attempt', async () => {
    const runner = stepRunner({ runId: 'run-4', jobName: 'j', store });
    await expect(
      runner.step.run('flaky', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const record = await store.get('run-4', 'flaky');
    expect(record?.status).toBe('failed');
    // `renderThrowable`'s form. A persisted step failure carries the throwable's NAME beside its
    // message, and it is rendered totally rather than through `String(error)`.
    expect(record?.error).toBe('Error: boom');

    const retry = stepRunner({ runId: 'run-4', jobName: 'j', store });
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
      const runner = stepRunner({ runId: 'run-5', jobName: 'onboardOrg', store, clock });
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
    const runner = stepRunner({ runId: 'run-6', jobName: 'j', store, clock });
    await runner.step.sleep('30s').catch(() => undefined);
    expect((await store.get('run-6', 'sleep:30s'))?.wakeAt).toBe(T0 + 30_000);
  });

  // `for (…) { await step.sleep('1h') }` — a poll loop, and the documented one-argument form —
  // used to mint `sleep:1h` twice and die with X_STEP_DUPLICATE on iteration 2. The first
  // occurrence keeps the bare name so a run already suspended on it resumes across this change.
  test('repeating the single-argument form in a loop mints one name per occurrence', async () => {
    const clock = fakeClock(T0);
    // The body a poll loop is: three identical sleeps. Each attempt replays it from the top,
    // which is what makes the ordinal deterministic — and what made the old derived name collide.
    const body = async (): Promise<void> => {
      const runner = stepRunner({ runId: 'run-7', jobName: 'j', store, clock });
      for (let i = 0; i < 3; i += 1) await runner.step.sleep('1h');
    };

    // Attempt 1 suspends on the first sleep; two more wake-ups carry it through the rest.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await body().catch((error: unknown) => error);
      expect(isStepSuspension(outcome)).toBe(true);
      clock.advance(3_600_000);
    }
    await body();

    expect((await store.get('run-7', 'sleep:1h'))?.status).toBe('completed');
    expect((await store.get('run-7', 'sleep:1h#2'))?.status).toBe('completed');
    expect((await store.get('run-7', 'sleep:1h#3'))?.status).toBe('completed');
  });

  test('the ordinal is per duration, so two different sleeps do not share a counter', async () => {
    const clock = fakeClock(T0);
    const runner = stepRunner({ runId: 'run-8', jobName: 'j', store, clock });

    await runner.step.sleep('1h').catch(() => undefined);
    await runner.step.sleep('2h').catch(() => undefined);

    expect(await store.get('run-8', 'sleep:1h')).toBeDefined();
    expect(await store.get('run-8', 'sleep:2h')).toBeDefined();
  });
});

describe('step.waitForEvent', () => {
  test('suspends until a correlated event is published, then returns its payload', async () => {
    const clock = fakeClock(T0);
    const events = memoryEventBus({ clock });

    const attempt = (): Promise<unknown> => {
      const runner = stepRunner({
        runId: 'run-7',
        jobName: 'awaitApproval',
        store,
        clock,
        events,
      });
      return runner.step.waitForEvent('approval', 'invoice.approved', {
        schema: t.object({ by: t.string }),
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
    const events = memoryEventBus({ clock });
    const attempt = (): Promise<unknown> => {
      const runner = stepRunner({ runId: 'run-8', jobName: 'j', store, clock, events });
      return runner.step.waitForEvent('maybe', 'never.happens', {
        schema: NOTHING,
        timeout: '1m',
      });
    };

    expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);
    clock.advance(61_000);
    expect(await attempt()).toBeUndefined();
  });

  describe('the payload is parsed by the schema the wait declares', () => {
    const Approval = t.object({ amount: t.number, by: t.string.default('nobody') });
    const SECRET = 'iban-es91-secret';

    /** Waits on `pay`, publishes `payload` past the wait's stamp, answers the next attempt's result. */
    const hit = async (payload: unknown, runId = 'run-pay') => {
      const clock = fakeClock(T0);
      const events = memoryEventBus({ clock });
      const attempt = () =>
        stepRunner({ runId, jobName: 'pay', store, clock, events }).step.waitForEvent(
          'approval',
          'invoice.approved',
          { schema: Approval, timeout: '1h' },
        );
      expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);
      await events.publish('invoice.approved', payload);
      clock.advance(30_000);
      return attempt;
    };

    test('a hit and its replay answer the one parsed value, the store keeps the raw one', async () => {
      const attempt = await hit({ amount: 12 });
      const first = await attempt();
      expect(first).toEqual({ amount: 12, by: 'nobody' });
      expect((await store.get('run-pay', 'approval'))?.output).toEqual({ amount: 12 });
      expect(await attempt()).toEqual(first);
    });

    test('a wrong payload raises the code, terminally, with no payload value in the text', async () => {
      const attempt = await hit({ amount: 'twelve', by: SECRET, card: SECRET });
      const thrown: unknown = await attempt().catch((error: unknown) => error);

      if (!isUltimateError(thrown)) return expect.unreachable('expected X_JOB_EVENT_INVALID');
      expect(thrown.code).toBe('X_JOB_EVENT_INVALID');
      expect(thrown.cause).toContain('invoice.approved');
      expect(thrown.cause).toContain('amount');
      expect(thrown.fix).toContain('x jobs retry');
      expect(JSON.stringify(thrown.toJSON())).not.toContain('twelve');
      expect(JSON.stringify(thrown.toJSON())).not.toContain(SECRET);
      expect(nextRetryForError(DEFAULT_RETRY, 1, thrown).stoppedBy).toBe('terminal');
      // Not this step's answer: nothing completed, so a repaired publisher can still answer it.
      expect((await store.get('run-pay', 'approval'))?.status).toBe('waiting');
    });

    // `x jobs retry` keeps the run's steps and `find` answers the EARLIEST event, so without a floor
    // the repair the error names could not work: the same refused event, until its 7 d TTL.
    test('a refused event is not asked about again, so a repaired publisher can answer', async () => {
      const clock = fakeClock(T0);
      const events = memoryEventBus({ clock });
      const attempt = () =>
        stepRunner({ runId: 'run-fix', jobName: 'pay', store, clock, events }).step.waitForEvent(
          'approval',
          'invoice.approved',
          { schema: Approval, timeout: '1h' },
        );
      expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);
      await events.publish('invoice.approved', { amount: 'twelve' });
      clock.advance(30_000);
      await expect(attempt()).rejects.toBeUltimateError('X_JOB_EVENT_INVALID');

      // The retry, before the publisher is repaired: parked, not refused a second time.
      clock.advance(30_000);
      expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);
      clock.advance(30_000);
      expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);

      await events.publish('invoice.approved', { amount: 12, by: 'ada' });
      clock.advance(30_000);
      expect(await attempt()).toEqual({ amount: 12, by: 'ada' });
      // Replays what it stored, and the floor is gone with the wait.
      expect(await attempt()).toEqual({ amount: 12, by: 'ada' });
    });

    test('the floor moves the search and never the timeout', async () => {
      const clock = fakeClock(T0);
      const events = memoryEventBus({ clock });
      const attempt = () =>
        stepRunner({ runId: 'run-end', jobName: 'pay', store, clock, events }).step.waitForEvent(
          'approval',
          'invoice.approved',
          { schema: Approval, timeout: '1h' },
        );
      expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);
      clock.advance(1_800_000);
      await events.publish('invoice.approved', { amount: 'twelve' });
      await expect(attempt()).rejects.toBeUltimateError('X_JOB_EVENT_INVALID');
      expect((await store.get('run-end', 'approval'))?.startedAt).toBe(T0);
      clock.advance(1_800_001);
      expect(await attempt()).toBeUndefined();
    });

    // The live value on a hit and its JSON on a replay were two answers to one event.
    test('a hit parses the stored form: an undefined payload is the null every store holds', async () => {
      const clock = fakeClock(T0);
      const events = memoryEventBus({ clock });
      const attempt = () =>
        stepRunner({ runId: 'run-undef', jobName: 'pay', store, clock, events }).step.waitForEvent(
          'approval',
          'invoice.approved',
          { schema: t.optional(t.string) },
        );
      expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);
      await events.publish('invoice.approved', undefined);
      clock.advance(30_000);
      await expect(attempt()).rejects.toBeUltimateError('X_JOB_EVENT_INVALID');
    });

    test('a stored payload the schema now refuses fails on the replay too', async () => {
      await store.put({
        runId: 'run-old',
        name: 'approval',
        status: 'completed',
        output: { amount: 'twelve' },
        startedAt: T0,
        attempts: 1,
      });
      const runner = stepRunner({ runId: 'run-old', jobName: 'pay', store });
      const replay = runner.step.waitForEvent('approval', 'invoice.approved', { schema: Approval });
      await expect(replay).rejects.toBeUltimateError('X_JOB_EVENT_INVALID');
    });
  });
});

/**
 * K6. `hydrated` was assigned before `await store.list`, so a second caller read the empty map.
 * `Promise.all([run('a'), run('b')])` replayed: `[1, 20]`, stored `[1, 2]`, `bRuns: 2` — the
 * at-least-once contract quietly becoming "run again".
 */
describe('steps in parallel share one hydration', () => {
  test('two completed steps in Promise.all replay once each, with the stored values', async () => {
    let aRuns = 0;
    let bRuns = 0;
    const attempt = (a: number, b: number) => {
      const { step } = stepRunner({ runId: 'run-par', jobName: 'j', store });
      return Promise.all([
        step.run('a', () => {
          aRuns += 1;
          return a;
        }),
        step.run('b', () => {
          bRuns += 1;
          return b;
        }),
      ]);
    };

    expect(await attempt(1, 2)).toEqual([1, 2]);
    expect(await attempt(10, 20)).toEqual([1, 2]);
    expect({ aRuns, bRuns }).toEqual({ aRuns: 1, bRuns: 1 });
  });

  test('the list is asked once for the whole Promise.all', async () => {
    let lists = 0;
    const counted: StepStore = {
      ...store,
      list(runId) {
        lists += 1;
        return store.list(runId);
      },
    };
    const { step } = stepRunner({ runId: 'run-one', jobName: 'j', store: counted });
    await Promise.all([step.run('a', () => 1), step.run('b', () => 2), step.run('c', () => 3)]);
    expect(lists).toBe(1);
  });

  test('a list that rejects once fails its callers, and the next call asks again', async () => {
    await store.put({
      runId: 'run-blip',
      name: 'done',
      status: 'completed',
      output: 7,
      startedAt: T0,
      attempts: 1,
    });
    let lists = 0;
    const flaky: StepStore = {
      ...store,
      list(runId) {
        lists += 1;
        if (lists === 1) throw POOL_BLIPPED;
        return store.list(runId);
      },
    };
    const { step } = stepRunner({ runId: 'run-blip', jobName: 'j', store: flaky });
    const outcome = await Promise.allSettled([step.run('x', () => 1), step.run('y', () => 2)]);
    expect(outcome.map((settled) => settled.status)).toEqual(['rejected', 'rejected']);

    let reran = false;
    const value = await step.run('done', () => {
      reran = true;
      return 0;
    });
    expect(value).toBe(7);
    expect(reran).toBe(false);
    expect(lists).toBe(2);
  });
});
