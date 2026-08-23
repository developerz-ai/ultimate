// The hold is the difference between a dev server and a dev server that has already exited. What
// is worth pinning: it does not resolve while nothing has asked for a shutdown, it waits for the
// whole drain rather than the signal alone, and awaiting it twice releases once.

import { afterEach, describe, expect, test } from 'bun:test';
import { configureLifecycle, drain, onShutdown, resetLifecycle } from '@ultimat3/core';
import { dbUnavailable } from '@ultimat3/db';
import { holdUntilShutdown } from './hold';

afterEach(() => {
  resetLifecycle();
});

/** Resolves to what `promise` did, or to `'pending'` if it has not settled by the next ticks. */
async function settledOr<T>(promise: Promise<T>, fallback: string): Promise<T | string> {
  return Promise.race([
    promise,
    // Two macrotask turns: enough for any already-resolved continuation chain to run.
    new Promise<string>((resolve) => {
      setTimeout(() => resolve(fallback), 2);
    }),
  ]);
}

describe('holdUntilShutdown', () => {
  test('does not resolve, and does not release, while the process is still running', async () => {
    let released = 0;
    const hold = holdUntilShutdown('probe', async () => {
      released += 1;
    });

    expect(await settledOr(hold(), 'pending')).toBe('pending');
    expect(released).toBe(0);
  });

  test('resolves once the drain has run, and releases after it — never during', async () => {
    const order: string[] = [];
    onShutdown(
      'probe:close',
      () => {
        order.push('close-phase');
      },
      { phase: 'close' },
    );
    const hold = holdUntilShutdown('probe', async () => {
      order.push('release');
    });

    const held = hold();
    void drain('SIGINT');
    await held;

    // Release last: a resource freed inside the drain is one an in-flight request still holds.
    expect(order).toEqual(['close-phase', 'release']);
  });

  test('awaiting the hold twice releases exactly once', async () => {
    let released = 0;
    const hold = holdUntilShutdown('probe', async () => {
      released += 1;
    });

    const first = hold();
    const second = hold();
    void drain('SIGTERM');
    await Promise.all([first, second]);

    expect(released).toBe(1);
  });

  test('the wait is on the drain, not on a signal table of its own', async () => {
    // `x verify` and a test both drain without a signal. Waiting on the phase rather than on
    // SIGINT is what makes those release the command too.
    let released = 0;
    const hold = holdUntilShutdown('probe', async () => {
      released += 1;
    });
    const held = hold();
    void drain();
    await held;

    expect(released).toBe(1);
  });

  // The whole shutdown is bounded by ONE budget, and `release` is inside it. `drain()` ABANDONS a
  // hook that overruns the deadline — core's design — and `release` here re-enters the same
  // teardown: `app.stop()` -> `startRoles().stop()` -> `worker.stop()`, memoised in the package
  // that owns it, so awaiting it is awaiting the promise that was just abandoned. Unbounded, the
  // container hung past `terminationGracePeriodSeconds` and the kubelet SIGKILLed it — which is
  // the failure the deadline exists to prevent, arriving one call after the deadline worked.
  test('a release that never settles still ends the hold, at the drain’s own deadline', async () => {
    configureLifecycle({ deadlineMs: 50 });
    const hold = holdUntilShutdown('probe', () => new Promise<void>(() => {}));
    const held = hold();
    void drain('SIGTERM');

    await held;
    expect(true).toBe(true);
  }, 5_000);

  test('the exit the caller supplied is reached, even then', async () => {
    // `apps/web/server.ts` is the one entry point with nothing above it to exit: `bin.ts` ends in
    // `process.exit(code)` and a container's `runRole` does not. A non-unref’d interval anywhere
    // in the app then holds an event loop that has nothing left to do.
    configureLifecycle({ deadlineMs: 50 });
    const codes: number[] = [];
    const hold = holdUntilShutdown('probe', () => new Promise<void>(() => {}), {
      exit: (code) => codes.push(code),
    });
    const held = hold();
    void drain('SIGTERM');
    await held;

    expect(codes).toEqual([0]);
  }, 5_000);

  test('a release that fails rejects the hold rather than exiting 0 over it', async () => {
    // `dispatch` awaits the hold inside its own try, so a database that would not close is a
    // finding on the way out. Swallowing it would report a clean shutdown of a process that
    // still holds the PGlite directory. Coded, like the real release: `RunningServices.stop()`
    // rethrows the first failure it hit, and a bare Error would reach `dispatch` with no fix.
    const hold = holdUntilShutdown('probe', () =>
      Promise.reject(dbUnavailable('the embedded PGlite would not close')),
    );
    const held = hold();
    void drain('SIGINT');

    // Awaited: an unawaited `.rejects` is an assertion the runner never sees fail.
    await expect(held).rejects.toBeUltimateError('X_DB_UNAVAILABLE');
  });
});
