// Single responsibility: the drain's time budget — one deadline for the WHOLE drain, a hook that
// overruns it abandoned rather than awaited, and the default that is enforced when no role
// declares one. The unit under it is `lifecycle-deadline.ts`; split from `lifecycle.test.ts`
// for the file-size ceiling.

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { frozenClock, systemClock } from './clock';
import {
  configureLifecycle,
  drain,
  drainDeadlineMs,
  lifecycleState,
  markReady,
  onShutdown,
  resetLifecycle,
} from './lifecycle';
import { structuredLogger } from './logger';

// Lifecycle state is process-global, and any suite that boots a server calls `markReady()` — so
// this resets on the way IN as well as out, or the first assertion reads another file's process.
beforeEach(() => {
  resetLifecycle();
});

afterEach(() => {
  jest.useRealTimers();
  resetLifecycle();
});

/**
 * Moves Bun's fake clock 1 ms at a time, letting the promise jobs each fired timer queued run, until
 * `drained` settles — so a timer past the drain's end (an abandoned hook's) is never fired — or
 * `ms` runs out.
 */
async function drainOver(drained: Promise<void>, ms: number): Promise<void> {
  let settled = false;
  void drained.then(() => {
    settled = true;
  });
  for (let m = 0; m < 20; m += 1) await Promise.resolve();
  for (let i = 0; i < ms && !settled; i += 1) {
    jest.advanceTimersByTime(1);
    for (let m = 0; m < 20; m += 1) await Promise.resolve();
  }
  if (!settled) expect.unreachable(`the drain was still running ${ms} fake ms in`);
}

/**
 * A promise a test resolves by hand. Races here are driven by these and never by a sleep: a
 * shutdown-deadline assertion ordered on wall-clock time is exactly the shard that flakes.
 */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('the drain deadline', () => {
  test('a declared deadline bounds a slow hook: the drain abandons it and names it', async () => {
    const lines: string[] = [];
    const stuck = deferred();
    configureLifecycle({
      deadlineMs: 10,
      logger: structuredLogger({ level: 'info', writer: (line) => lines.push(line) }),
    });
    markReady();
    expect(drainDeadlineMs()).toBe(10);

    // A `worker` pod's real shape: `jobs`' hook awaits every in-flight job and then `driver.close()`.
    // Nothing in it reads `reason.deadlineAt`, so before this the 10ms budget bounded nothing at
    // all — `drain()` sat here until the kubelet SIGKILLed the process mid-job.
    onShutdown('slow-accept', () => stuck.promise, { phase: 'accept' });
    let closed = 0;
    onShutdown('close-db', () => {
      closed += 1;
    });

    await drain('SIGTERM');

    expect(lifecycleState()).toBe('stopped');
    // The code alone is not an instruction: an operator has to know WHICH hook to shorten.
    const timeout = lines.find((line) => line.includes('X_SHUTDOWN_TIMEOUT'));
    expect(timeout).toContain('slow-accept');
    expect(timeout).toContain('accept');
    // Abandoned, not merely logged — the phases after it still ran, which is the whole point of
    // resolving: `installSignalHandlers` reaches `process.exit(0)` instead of being killed.
    expect(closed).toBe(1);

    stuck.resolve();
  });

  test('a hook abandoned at the deadline cannot crash the process when it later rejects', async () => {
    const lines: string[] = [];
    const stuck = deferred();
    configureLifecycle({
      deadlineMs: 10,
      logger: structuredLogger({ level: 'info', writer: (line) => lines.push(line) }),
    });
    let rejectLate!: (error: unknown) => void;
    const late = new Promise<void>((_resolve, reject) => {
      rejectLate = reject;
    });
    onShutdown('slow-accept', () => late, { phase: 'accept' });

    await drain('SIGTERM');
    // The drain has moved on and nobody awaits this promise anymore. Unhandled, it would take
    // down the process the drain exists to end cleanly.
    rejectLate(new Error('closed after abandonment'));
    stuck.resolve();
    await stuck.promise;

    expect(lifecycleState()).toBe('stopped');
  });

  test('the budget bounds the WHOLE drain — a hook that spends it leaves none for the ones behind', async () => {
    const lines: string[] = [];
    const stuck = deferred();
    jest.useFakeTimers();
    configureLifecycle({
      deadlineMs: 30,
      logger: structuredLogger({ level: 'info', writer: (line) => lines.push(line) }),
    });

    onShutdown('spends-it', () => stuck.promise, { phase: 'accept' });
    // Deterministic, and not a stopwatch: the clock is Bun's fake one, moved by the test. Whole-
    // drain, the hook behind is left a budget of 0, so it is abandoned on the next tick and the
    // drain ends at 31 fake ms (the 0 ms timer armed at 30 fires on the stepper's next ms);
    // per-hook, it would get a fresh 30 and the drain end at 61.
    const behind = deferred();
    let finished = false;
    onShutdown(
      'after-it',
      async () => {
        await behind.promise;
        finished = true;
      },
      { phase: 'close' },
    );

    const startedAt = performance.now();
    const drained = drain('SIGTERM');
    await drainOver(drained, 100);
    expect(performance.now() - startedAt).toBe(31);

    const overran = lines.filter((line) => line.includes('X_SHUTDOWN_TIMEOUT'));
    expect(overran).toHaveLength(2);
    expect(overran[1]).toContain('after-it');
    expect(finished).toBe(false);

    behind.resolve();
    stuck.resolve();
  });

  // The default is ENFORCED, not absent: `jobs`, `realtime` and `cli` declare no budget, and a
  // deadline that bounded only the packages that happened to ask would be a mechanism claiming
  // more than it enforces — the worker pod the finding proved would still be SIGKILLed.
  test('an unset deadline is the DEFAULT budget, enforced — not the absence of one', async () => {
    const order: string[] = [];
    const entered = deferred();
    const release = deferred();
    jest.useFakeTimers();
    configureLifecycle({
      logger: structuredLogger({ level: 'info', writer: () => undefined }),
    });
    markReady();
    // 25s, the literal, because no stopwatch in a test can tell 25s from unbounded — so the value
    // is pinned where it is decided, and `remainingBudget` has no second place to disagree from.
    expect(drainDeadlineMs()).toBe(25_000);
    onShutdown(
      'slow-accept',
      async () => {
        entered.resolve();
        await release.promise;
        order.push('hook');
      },
      { phase: 'accept' },
    );

    const drained = drain('SIGTERM').then(() => {
      order.push('drained');
    });
    await entered.promise;
    // Not an ordering assertion: a hook inside the budget must be awaited to completion. The fake
    // clock is moved to 1 ms short of the 25 s default, so a default that shrank by ANY amount — to
    // 0, to a per-phase slice, to whatever a refactor thought "no budget" meant — shows up here as
    // an abandoned hook rather than as a green test. Nothing else is armed: one jump is exact.
    jest.advanceTimersByTime(25_000 - 1);
    for (let m = 0; m < 20; m += 1) await Promise.resolve();
    expect(order).toEqual([]);

    release.resolve();
    await drained;
    expect(order).toEqual(['hook', 'drained']);
  });

  test('the budget is REAL elapsed time — a frozen clock cannot extend a grace period', async () => {
    const clock = frozenClock(0);
    const deadlineMs = 5_000;
    configureLifecycle({ deadlineMs, clock });
    clock.advance(1_000_000);
    let seen: number | undefined;
    onShutdown('probe', (reason) => {
      seen = reason.deadlineAt;
    });

    await drain('SIGTERM');

    // `waitForIdle` sleeps on a real `setTimeout` while the budget was read off the injected
    // clock, so the two disagreed: here the old arithmetic answered 1,005,000 — a 16-minute
    // budget, on a clock a test controls, for a deadline the kubelet enforces in real seconds.
    // A RELATIVE bound on `seen - systemClock.monotonic()` instead of an absolute 1,000,000:
    // the live-clock answer is `systemClock + deadlineMs` at drain time, the injected answer
    // is 1,005,000 either way; the first is within `deadlineMs` of the current monotonic,
    // the second never is. The `> 0` half survives a long test suite where
    // `performance.now()` itself exceeds 1,000,000 — the absolute bound did not.
    const drift = (seen ?? 0) - systemClock.monotonic();
    expect(drift).toBeGreaterThan(0);
    expect(drift).toBeLessThan(deadlineMs * 2);
    expect(seen).toBeGreaterThan(systemClock.monotonic());
  });
});
