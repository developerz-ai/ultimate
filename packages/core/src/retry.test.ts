import { afterEach, describe, expect, test } from 'bun:test';
import { registerErrorRetry, registeredErrorRetry, resetErrorRetry } from './error-retry';
import { UltimateError } from './errors';
import { retry, retryDecision } from './retry';

/**
 * What was registered before this file ran — the preload's packages, whose module bodies will not
 * run again. A bare `resetErrorRetry()` deletes those too, and every file loaded after this one
 * then reads its own package's codes as unclassified.
 */
const BASELINE = registeredErrorRetry();

afterEach(() => {
  resetErrorRetry(BASELINE);
});

const recorder = (): { readonly slept: number[]; sleep: (ms: number) => Promise<void> } => {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number): Promise<void> => {
      slept.push(ms);
    },
  };
};

const coded = (
  code: string,
  init?: { retry?: 'terminal' | 'retryable' | 'retry-after'; meta?: Record<string, unknown> },
): UltimateError =>
  new UltimateError({
    code,
    cause: 'the dependency answered badly',
    fix: 'x doctor --json',
    retry: init?.retry,
    meta: init?.meta,
  });

const policy = {
  attempts: 4,
  base: 1_000,
  max: 30_000,
  jitter: 'none',
} as const;

describe('retry', () => {
  test('returns the first success and never sleeps', async () => {
    const timer = recorder();
    const attempts: number[] = [];
    const answer = await retry(
      async (attempt) => {
        attempts.push(attempt);
        return 'ok';
      },
      policy,
      { sleep: timer.sleep },
    );
    expect(answer).toBe('ok');
    expect(attempts).toEqual([1]);
    expect(timer.slept).toEqual([]);
  });

  test('backs off a retryable failure and hands the attempt number to work', async () => {
    const timer = recorder();
    const attempts: number[] = [];
    const answer = await retry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 3) throw coded('X_DRAINING');
        return 'ok';
      },
      policy,
      { sleep: timer.sleep },
    );
    expect(answer).toBe('ok');
    expect(attempts).toEqual([1, 2, 3]);
    expect(timer.slept).toEqual([1_000, 2_000]);
  });

  test('a TERMINAL classification stops on the attempt that failed', async () => {
    const timer = recorder();
    let runs = 0;
    await expect(
      retry(
        async () => {
          runs += 1;
          throw coded('X_NOT_IMPLEMENTED');
        },
        policy,
        { sleep: timer.sleep },
      ),
    ).rejects.toMatchObject({ code: 'X_NOT_IMPLEMENTED' });
    expect(runs).toBe(1);
    expect(timer.slept).toEqual([]);
  });

  test('an UNCLASSIFIED code is retried — the attempt count stays in charge', async () => {
    const timer = recorder();
    let runs = 0;
    await expect(
      retry(
        async () => {
          runs += 1;
          throw coded('X_APP_NEVER_CLASSIFIED');
        },
        { ...policy, attempts: 3 },
        { sleep: timer.sleep },
      ),
    ).rejects.toMatchObject({ code: 'X_APP_NEVER_CLASSIFIED' });
    expect(runs).toBe(3);
    expect(timer.slept).toEqual([1_000, 2_000]);
  });

  test("an instance `retry: 'terminal'` on an unregistered code is read as unclassified", async () => {
    const timer = recorder();
    let runs = 0;
    await expect(
      retry(
        async () => {
          runs += 1;
          throw coded('X_APP_NEVER_CLASSIFIED', { retry: 'terminal' });
        },
        { ...policy, attempts: 2 },
        { sleep: timer.sleep },
      ),
    ).rejects.toMatchObject({ code: 'X_APP_NEVER_CLASSIFIED' });
    // Two runs, not one: a per-instance `terminal` is indistinguishable from the fail-closed
    // default, and honouring it would end the retry policy of every app whose codes nobody typed.
    expect(runs).toBe(2);
  });

  test('a registered terminal code IS honoured on the first attempt', async () => {
    registerErrorRetry({ X_APP_CONFIG_WRONG: 'terminal' });
    const timer = recorder();
    let runs = 0;
    await expect(
      retry(
        async () => {
          runs += 1;
          throw coded('X_APP_CONFIG_WRONG');
        },
        policy,
        { sleep: timer.sleep },
      ),
    ).rejects.toMatchObject({ code: 'X_APP_CONFIG_WRONG' });
    expect(runs).toBe(1);
  });

  test('a foreign throw is not classified, so the policy decides', async () => {
    const timer = recorder();
    let runs = 0;
    await expect(
      retry(
        async () => {
          runs += 1;
          // A `TypeError` from a driver is INPUT here, not this test's verdict.
          throw new TypeError('undefined is not a function');
        },
        { ...policy, attempts: 2 },
        { sleep: timer.sleep },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(runs).toBe(2);
  });

  test('`retry-after` waits the delay the responder NAMED, not the computed backoff', async () => {
    const timer = recorder();
    let runs = 0;
    const answer = await retry(
      async (attempt) => {
        runs += 1;
        if (attempt === 1) {
          throw coded('X_APP_THROTTLED', { retry: 'retry-after', meta: { retryAfterSeconds: 7 } });
        }
        return 'ok';
      },
      policy,
      { sleep: timer.sleep },
    );
    expect(answer).toBe('ok');
    expect(runs).toBe(2);
    expect(timer.slept).toEqual([7_000]);
  });

  test("a stated delay is clamped by the policy's own ceiling", async () => {
    const timer = recorder();
    await retry(
      async (attempt) => {
        if (attempt === 1) {
          throw coded('X_APP_THROTTLED', {
            retry: 'retry-after',
            meta: { retryAfterSeconds: 86_400 },
          });
        }
        return 'ok';
      },
      policy,
      { sleep: timer.sleep },
    );
    expect(timer.slept).toEqual([30_000]);
  });

  test('`retry-after` with nothing stated falls back to the computed backoff', async () => {
    const timer = recorder();
    await retry(
      async (attempt) => {
        if (attempt === 1) throw coded('X_APP_THROTTLED', { retry: 'retry-after' });
        return 'ok';
      },
      policy,
      { sleep: timer.sleep },
    );
    expect(timer.slept).toEqual([1_000]);
  });

  test('exhaustion rethrows the LAST error, code and fix intact', async () => {
    const timer = recorder();
    const failure = await retry(
      async (attempt) => {
        throw coded(`X_APP_ATTEMPT_${attempt}`);
      },
      { ...policy, attempts: 3 },
      { sleep: timer.sleep },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'X_APP_ATTEMPT_3', fix: 'x doctor --json' });
  });

  test('jitter is deterministic under an injected random', async () => {
    const timer = recorder();
    await retry(
      async (attempt) => {
        if (attempt === 1) throw coded('X_DRAINING');
        return 'ok';
      },
      { ...policy, jitter: 'equal' },
      { sleep: timer.sleep, random: () => 0.5 },
    );
    expect(timer.slept).toEqual([750]);
  });

  test('a time budget stops a wait the caller cannot afford, before sleeping it', async () => {
    const timer = recorder();
    let clock = 0;
    let runs = 0;
    await expect(
      retry(
        async () => {
          runs += 1;
          clock += 400;
          throw coded('X_DRAINING');
        },
        { ...policy, attempts: 10, timeBudgetMs: 2_000 },
        { sleep: timer.sleep, now: () => clock },
      ),
    ).rejects.toMatchObject({ code: 'X_DRAINING' });
    // The injected clock only moves while work runs: 400ms, a 1000ms wait, 400ms more — so at the
    // second decision 800ms of the 2000ms budget are spent and a 2000ms wait would end at 2800.
    // It is never started, and the last error reaches the caller instead.
    expect(timer.slept).toEqual([1_000]);
    expect(runs).toBe(2);
  });

  test('attempts below 1 still run the work once', async () => {
    const timer = recorder();
    let runs = 0;
    const answer = await retry(
      async () => {
        runs += 1;
        return 'ok';
      },
      { ...policy, attempts: 0 },
      { sleep: timer.sleep },
    );
    expect([answer, runs]).toEqual(['ok', 1]);
  });
});

describe('retryDecision', () => {
  test('is pure, and names why it stopped', () => {
    expect(retryDecision(policy, 1, coded('X_DRAINING'))).toEqual({
      retry: true,
      delayMs: 1_000,
      attempt: 1,
      nextAttempt: 2,
      classification: 'retryable',
      stoppedBy: undefined,
    });
    expect(retryDecision(policy, 4, coded('X_DRAINING')).stoppedBy).toBe('attempts-exhausted');
    expect(retryDecision(policy, 1, coded('X_NOT_IMPLEMENTED')).stoppedBy).toBe('terminal');
  });
});

describe('unit · a retry bound that is not a number is refused, never looped on', () => {
  const policy = { attempts: 3, base: 10, max: 100, jitter: 'none' as const };

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 2.5])(
    'attempts: %p refuses before the first try',
    async (attempts) => {
      // `attempt >= NaN` is false forever, so the loop this guards never ended. A CALL CAP and not
      // a timeout: an unscreened loop spins on microtasks and a timer would never get to fire.
      let calls = 0;
      const { sleep } = recorder();
      const work = async (): Promise<never> => {
        calls += 1;
        if (calls > 20) throw coded('X_NOT_IMPLEMENTED', { retry: 'terminal' });
        throw coded('X_DRAINING', { retry: 'retryable' });
      };
      try {
        await retry(work, { ...policy, attempts }, { sleep });
        expect.unreachable();
      } catch (error) {
        expect((error as UltimateError).code).toBe('X_INVARIANT');
      }
      expect(calls).toBe(0);
    },
  );

  test('retryDecision refuses the same bound, so a hand-written loop cannot spin either', () => {
    expect(() => retryDecision({ ...policy, attempts: Number.NaN }, 1, new TypeError('x'))).toThrow(
      /attempts is NaN/,
    );
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'timeBudgetMs: %p refuses — `elapsed > NaN` is false, so the budget would not exist',
    async (timeBudgetMs) => {
      let calls = 0;
      const { sleep } = recorder();
      try {
        await retry(
          async () => {
            calls += 1;
            throw coded('X_DRAINING', { retry: 'retryable' });
          },
          { ...policy, timeBudgetMs },
          { sleep, now: () => 0 },
        );
        expect.unreachable();
      } catch (error) {
        expect((error as UltimateError).code).toBe('X_INVARIANT');
      }
      expect(calls).toBe(0);
    },
  );

  test('a whole budget and a whole attempt count still run', async () => {
    const { sleep } = recorder();
    expect(await retry(async () => 'ok', { ...policy, timeBudgetMs: 0 }, { sleep })).toBe('ok');
  });
});
