// Single responsibility: the drain's time budget — one deadline for the WHOLE drain, a hook that
// overruns it abandoned rather than awaited, and the default that is enforced when no role
// declares one. The unit under it is `lifecycle-deadline.ts`; split from `lifecycle.test.ts`
// for the file-size ceiling.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import { createLogger } from './logger';

// Lifecycle state is process-global, and any suite that boots a server calls `markReady()` — so
// this resets on the way IN as well as out, or the first assertion reads another file's process.
beforeEach(() => {
  resetLifecycle();
});

afterEach(() => {
  resetLifecycle();
});

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
      logger: createLogger({ level: 'info', writer: (line) => lines.push(line) }),
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
      logger: createLogger({ level: 'info', writer: (line) => lines.push(line) }),
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
    configureLifecycle({
      deadlineMs: 30,
      logger: createLogger({ level: 'info', writer: (line) => lines.push(line) }),
    });

    onShutdown('spends-it', () => stuck.promise, { phase: 'accept' });
    // Deterministic, and not a stopwatch: both waits are timers in one queue, so they settle in
    // due-time order however slow the machine is. Whole-drain, this hook's budget is already 0 and
    // its own 15ms timer cannot beat it; per-hook, it would get a fresh 30ms and finish.
    let finished = false;
    onShutdown(
      'after-it',
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            finished = true;
            resolve();
          }, 15);
        }),
      { phase: 'close' },
    );

    await drain('SIGTERM');

    const overran = lines.filter((line) => line.includes('X_SHUTDOWN_TIMEOUT'));
    expect(overran).toHaveLength(2);
    expect(overran[1]).toContain('after-it');
    expect(finished).toBe(false);

    stuck.resolve();
  });

  // The default is ENFORCED, not absent: `jobs`, `realtime` and `cli` declare no budget, and a
  // deadline that bounded only the packages that happened to ask would be a mechanism claiming
  // more than it enforces — the worker pod the finding proved would still be SIGKILLed.
  test('an unset deadline is the DEFAULT budget, enforced — not the absence of one', async () => {
    const order: string[] = [];
    const entered = deferred();
    const release = deferred();
    configureLifecycle({
      logger: createLogger({ level: 'info', writer: () => undefined }),
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
    // Not an ordering assertion: a hook well inside the budget must be awaited to completion, so
    // waiting longer only strengthens this. 30ms against a 25s budget is what makes a default that
    // shrank — to 0, to a per-phase slice, to whatever a refactor thought "no budget" meant — show
    // up here as an abandoned hook rather than as a green test.
    await Bun.sleep(30);
    expect(order).toEqual([]);

    release.resolve();
    await drained;
    expect(order).toEqual(['hook', 'drained']);
  });

  test('the budget is REAL elapsed time — a frozen clock cannot extend a grace period', async () => {
    const clock = frozenClock(0);
    configureLifecycle({ deadlineMs: 5_000, clock });
    clock.advance(1_000_000);
    let seen: number | undefined;
    onShutdown('probe', (reason) => {
      seen = reason.deadlineAt;
    });

    await drain('SIGTERM');

    // `waitForIdle` sleeps on a real `setTimeout` while the budget was read off the injected
    // clock, so the two disagreed: here the old arithmetic answered 1,005,000 — a 16-minute
    // budget, on a clock a test controls, for a deadline the kubelet enforces in real seconds.
    expect(seen).toBeLessThan(1_000_000);
    expect(seen).toBeGreaterThan(systemClock.monotonic());
  });
});
