// `retry()` meets its caller's lifetime: `X_ABORTED` is unclassified by design, so nothing in the
// classification stops a loop whose caller is gone. Every attempt here is counted, because a loop
// that outlives its caller still returns the right error, after sending to a vendor four more times.

import { describe, expect, test } from 'bun:test';
import { systemClock } from './clock';
import { ctxOf, runToCompletion, runWithContext, throwIfAborted } from './context';
import { UltimateError } from './errors';
import { retry } from './retry';

const upstream = (): UltimateError =>
  new UltimateError({
    code: 'X_RETRY_LIFETIME_UPSTREAM',
    cause: 'the dependency answered badly',
    fix: 'x doctor --json',
  });

const policy = { attempts: 5, base: 10, max: 10, jitter: 'none' } as const;
const instant = { sleep: (): Promise<void> => Promise.resolve() };
const never = (): Promise<void> => new Promise<void>(() => undefined);

const rejection = async (run: Promise<unknown>): Promise<unknown> => {
  try {
    await run;
  } catch (error) {
    return error;
  }
  return expect.unreachable('the retry resolved');
};

describe('retry() under the ambient signal', () => {
  test('a failure after the abort ends the loop on that attempt, with that error', async () => {
    const caller = new AbortController();
    const thrown = upstream();
    let attempts = 0;
    const error = await runWithContext(ctxOf({ signal: caller.signal }), () =>
      rejection(
        retry(
          async () => {
            attempts += 1;
            throwIfAborted();
            caller.abort();
            throw thrown;
          },
          policy,
          instant,
        ),
      ),
    );
    expect(attempts).toBe(1);
    expect(error).toBe(thrown);
  });

  test('an abort during the wait ends an injected sleep at once, and no attempt follows', async () => {
    const caller = new AbortController();
    const thrown = upstream();
    let attempts = 0;
    let waits = 0;
    const error = await runWithContext(ctxOf({ signal: caller.signal }), () =>
      rejection(
        retry(
          async () => {
            attempts += 1;
            throw thrown;
          },
          policy,
          {
            sleep: () => {
              waits += 1;
              caller.abort();
              return never();
            },
          },
        ),
      ),
    );
    expect({ attempts, waits }).toEqual({ attempts: 1, waits: 1 });
    expect(error).toBe(thrown);
  });

  test('the default timer ends on the abort, not on its own delay', async () => {
    const caller = new AbortController();
    const thrown = upstream();
    const startedAt = systemClock.monotonic();
    setTimeout(() => {
      caller.abort();
    }, 1);
    // The wait is raced anyway, so only this shows the minute-long timer was let go of.
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const minuteTimers: unknown[] = [];
    const cleared: unknown[] = [];
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      const timer = realSet(fn, ms);
      if (ms === 60_000) minuteTimers.push(timer);
      return timer;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(timer);
      realClear(timer);
    }) as typeof clearTimeout;
    try {
      const error = await runWithContext(ctxOf({ signal: caller.signal }), () =>
        rejection(
          retry(
            async () => {
              throw thrown;
            },
            { attempts: 2, base: 60_000, max: 60_000, jitter: 'none' },
          ),
        ),
      );
      expect(error).toBe(thrown);
      expect(systemClock.monotonic() - startedAt).toBeLessThan(5_000);
      expect(minuteTimers).toHaveLength(1);
      expect(cleared).toContain(minuteTimers[0]);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  test('a signal already aborted runs no attempt and answers its own reason', async () => {
    const caller = new AbortController();
    const reason = upstream();
    caller.abort(reason);
    let attempts = 0;
    const error = await runWithContext(ctxOf({ signal: caller.signal }), () =>
      rejection(
        retry(async () => {
          attempts += 1;
          return 'never';
        }, policy),
      ),
    );
    expect(attempts).toBe(0);
    expect(error).toBe(reason);
  });

  test('a success beside an abort is still the answer', async () => {
    const caller = new AbortController();
    const value = await runWithContext(ctxOf({ signal: caller.signal }), () =>
      retry(async () => {
        caller.abort();
        return 'landed';
      }, policy),
    );
    expect(value).toBe('landed');
  });
});

describe('retry() under the ambient deadline', () => {
  const failing = (count: () => void) => async (): Promise<string> => {
    count();
    throw upstream();
  };

  test('a spent budget takes no second attempt, even for a zero delay', async () => {
    let attempts = 0;
    const deadlineAt = systemClock.now().getTime() - 1_000;
    await runWithContext(ctxOf({ deadlineAt }), () =>
      rejection(
        retry(
          failing(() => {
            attempts += 1;
          }),
          { attempts: 5, base: 0, max: 0, jitter: 'none' },
          instant,
        ),
      ),
    );
    expect(attempts).toBe(1);
  });

  test('a wait that would end past the deadline is never started', async () => {
    let attempts = 0;
    let waits = 0;
    const deadlineAt = systemClock.now().getTime() + 60_000;
    await runWithContext(ctxOf({ deadlineAt }), () =>
      rejection(
        retry(
          failing(() => {
            attempts += 1;
          }),
          { attempts: 5, base: 120_000, max: 120_000, jitter: 'none', timeBudgetMs: 600_000 },
          {
            sleep: () => {
              waits += 1;
              return Promise.resolve();
            },
          },
        ),
      ),
    );
    expect({ attempts, waits }).toEqual({ attempts: 1, waits: 0 });
  });

  test("the policy's own budget still wins when it is the smaller", async () => {
    let attempts = 0;
    const deadlineAt = systemClock.now().getTime() + 600_000;
    await runWithContext(ctxOf({ deadlineAt }), () =>
      rejection(
        retry(
          failing(() => {
            attempts += 1;
          }),
          { attempts: 5, base: 100, max: 100, jitter: 'none', timeBudgetMs: 50 },
          instant,
        ),
      ),
    );
    expect(attempts).toBe(1);
  });
});

describe('the ways out, and the absence of a context', () => {
  test('runToCompletion under an aborted, expired parent runs all five', async () => {
    const caller = new AbortController();
    caller.abort();
    let attempts = 0;
    const parent = ctxOf({
      signal: caller.signal,
      deadlineAt: systemClock.now().getTime() - 1_000,
    });
    await runWithContext(parent, () =>
      runToCompletion(() =>
        rejection(
          retry(
            async () => {
              attempts += 1;
              throwIfAborted();
              throw upstream();
            },
            policy,
            instant,
          ),
        ),
      ),
    );
    expect(attempts).toBe(5);
  });

  test('outside any context the attempts alone decide, on the default timer', async () => {
    let attempts = 0;
    const value = await retry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw upstream();
        return 'done';
      },
      { attempts: 3, base: 1, max: 1, jitter: 'none' },
    );
    expect(value).toBe('done');
    expect(attempts).toBe(3);
  });
});
