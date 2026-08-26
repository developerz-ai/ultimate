// The screen on this package's `finiteDurationMs`, and the floor it deliberately does NOT set.
// Every scheduling decision here — `step.sleep`'s wake time, the retry curve's base and cap, a
// job's timeouts, an event's TTL — is built from that one number, so a `NaN` reaching it is a
// comparison that is false forever rather than an error anybody sees. `bun run finite-bounds`
// cannot reach this shape: a `typeof duration === 'number'` arm has no `??` in it.

import { afterEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { finiteDurationMs } from './clock';
import { createMemoryEventBus } from './events';
import { job, resetJobs } from './job';
import { backoffDelayMs } from './retry';
import { createMemoryStepStore, createStepRunner } from './steps';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

// A `job()` that survived its own declaration would outlive this file's registry.
afterEach(() => {
  resetJobs();
});

const rendered = (thrown: unknown): string =>
  thrown instanceof UltimateError ? `${thrown.code} ${thrown.cause} ${thrown.fix}` : '';

const thrownBy = (call: () => unknown): unknown => {
  try {
    call();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
};

const rejection = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    await call();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
};

describe('finiteDurationMs refuses a duration that is not a number', () => {
  test.each(NON_FINITE)('%p is refused, under the name the caller wrote', (value) => {
    const thrown = thrownBy(() => finiteDurationMs(value, 'step.sleep', 'duration'));

    expect(thrown).toBeInstanceOf(UltimateError);
    expect(rendered(thrown)).toContain('X_INVARIANT');
    expect(rendered(thrown)).toContain('step.sleep');
    expect(rendered(thrown)).toContain('duration');
  });

  test('the string arm is unchanged — parseDuration is still the one vocabulary', () => {
    expect(finiteDurationMs('30s', 'retry', 'delay')).toBe(30_000);
    expect(finiteDurationMs('2h30m', 'retry', 'delay')).toBe(9_000_000);
    expect(finiteDurationMs('-1500ms', 'retry', 'delay')).toBe(-1500);
  });
});

// The floor is measured, not assumed. Both of these are shipped, tested behaviour elsewhere in
// this package: `retry-core-parity.test.ts` pins `maxDelay: -5` at 0, and four `.job.test.ts`
// suites configure `retry: { delay: 0 }`. `finiteCount` would have refused all of it.
describe('the floor is finiteness only — negative, zero and fractional still pass', () => {
  test.each([-5, -1500, 0, 1.5, 2.5])('%p is a duration this package accepts', (value) => {
    expect(finiteDurationMs(value, 'retry', 'delay')).toBe(value);
  });

  test('a negative maxDelay still clamps to 0 rather than throwing', () => {
    const policy = {
      attempts: 5,
      backoff: 'exponential',
      delay: 1_000,
      maxDelay: -5,
      jitter: false,
    } as const;
    expect(backoffDelayMs(policy, 1)).toBe(0);
  });

  test('a zero delay is still a retry with no wait, not a refusal', () => {
    expect(backoffDelayMs({ attempts: 3, backoff: 'fixed', delay: 0, jitter: false }, 1)).toBe(0);
  });
});

describe('the scheduling decisions built on it', () => {
  test('step.sleep(NaN) is refused at the call, never a wakeAt no clock ever reaches', async () => {
    const runner = createStepRunner({
      runId: 'run-nan',
      jobName: 'digest',
      store: createMemoryStepStore(),
    });

    const thrown = await rejection(() => runner.step.sleep('wait', Number.NaN));

    expect(thrown).toBeInstanceOf(UltimateError);
    // The whole finding: without the screen this resolves by THROWING a StepSuspension whose
    // `resumeAt` is `NaN`, the row is written `sleeping` with a `NaN` wakeAt, and every later
    // `wakeAt <= now` is false — the job never wakes and nothing is logged.
    expect(rendered(thrown)).toContain('X_INVARIANT');
    expect(rendered(thrown)).toContain('step.sleep');
    expect(rendered(thrown)).toContain('digest');
  });

  test('an ordinary sleep is unchanged — the guard refuses durations, not sleeps', async () => {
    const runner = createStepRunner({
      runId: 'run-ok',
      jobName: 'digest',
      store: createMemoryStepStore(),
    });

    const thrown = await rejection(() => runner.step.sleep('wait', '3d'));
    expect(thrown).not.toBeInstanceOf(UltimateError);
  });

  test('retry.delay names delay, and retry.maxDelay names maxDelay', () => {
    const delayFix = rendered(
      thrownBy(() =>
        backoffDelayMs({ attempts: 3, backoff: 'fixed', delay: Number.NaN, jitter: false }, 1),
      ),
    );
    expect(delayFix).toContain('X_INVARIANT');
    // `delay` is a SUBSTRING of `maxDelay` AND of `backoffDelay`, so the positive assertion alone
    // is passed by core's own refusal naming its internal `base` — which is the finding this test
    // exists for. The two negatives are what make it discriminate.
    expect(delayFix).not.toContain('maxDelay');
    expect(delayFix).not.toContain('backoffDelay');
    expect(delayFix).toContain('retry');

    const capFix = rendered(
      thrownBy(() =>
        backoffDelayMs(
          {
            attempts: 3,
            backoff: 'exponential',
            delay: 1_000,
            maxDelay: Number.NaN,
            jitter: false,
          },
          1,
        ),
      ),
    );
    expect(capFix).toContain('maxDelay');
    expect(capFix).not.toContain('backoffDelay');
  });

  test('job timeout is refused where it is declared, naming the job and the field', () => {
    const thrown = thrownBy(() =>
      job<{ n: number }>({
        tenant: 'none',
        name: 'nanTimeout',
        input: passthrough<{ n: number }>(),
        idempotencyKey: () => 'nanTimeout',
        retry: { attempts: 1 },
        timeout: Number.NaN,
        run: () => Promise.resolve(),
      }),
    );

    // `timeout` had NO guard of its own where `stepTimeout` and `eventPoll` each had one, so
    // `timeoutMs: NaN` reached `raceTimeout` and the wall-clock limit simply did not exist.
    expect(rendered(thrown)).toContain('X_INVARIANT');
    expect(rendered(thrown)).toContain('nanTimeout');
    expect(rendered(thrown)).toContain('timeout');
  });

  test('an event ttl is refused before an event that never expires is stored', async () => {
    const bus = createMemoryEventBus();
    const thrown = await rejection(() =>
      bus.publish('invoice.paid', {}, { ttl: Number.POSITIVE_INFINITY }),
    );

    expect(rendered(thrown)).toContain('X_INVARIANT');
    expect(rendered(thrown)).not.toContain('defaultTtl');
    expect(rendered(thrown)).toContain('ttl');
  });
});
