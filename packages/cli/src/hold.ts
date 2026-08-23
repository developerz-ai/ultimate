// Staying up. A command whose server is still listening when `run` resolves is a command whose
// process `bin.ts` exits out from under — so it hands back a hold, and `dispatch` awaits that
// before the exit code. Ctrl-C then takes core's own three-phase drain (stop accepting, finish
// in-flight, close) instead of killing a query mid-round-trip.

import { drain, installSignalHandlers, logger, onShutdown, systemClock } from '@ultimat3/core';

export interface HoldOptions {
  /**
   * What to call once the release is done, with `0`. Omit and nothing is called.
   *
   * There is exactly one caller: `runRole` in `serve.ts`, which is what `apps/web/server.ts`
   * awaits — the one entry point with nothing above it to end the process. `bin.ts` ends in
   * `process.exit(code)`, so `x dev` and `x mcp` need none of this; a container has no such line,
   * and one non-unref'd interval anywhere in the app then holds an event loop with nothing left to
   * do until `terminationGracePeriodSeconds` runs out and the kubelet SIGKILLs it.
   *
   * A function rather than a boolean because `process.exit` in a library is untestable: this is
   * the seam the test passes a spy through, and the caller is the one that knows.
   */
  readonly exit?: (code: number) => void;
}

/**
 * Wait for a shutdown, then release what core's lifecycle does not own.
 *
 * The wait is on the drain's first phase, never on a signal table of our own: core already owns
 * which signals mean stop, and a second list here would be a second answer to that question. It
 * also means anything else that calls `drain()` — a test, a supervisor, a later role — releases
 * this command too.
 *
 * `release` runs after the drain completes, so in-flight requests still see the database the
 * handler opened them against. It is the resources core never learned about: the embedded
 * Postgres, the worker, the file watcher.
 *
 * It runs INSIDE the drain's own deadline, and that is not a detail. `drain()` ABANDONS a hook
 * that overruns `ShutdownReason.deadlineAt` — the process is meant to exit without it — and
 * `release` here re-enters the very same teardown one call later: `app.stop()` ->
 * `startRoles().stop()` -> `worker.stop()`, memoised in the package that owns it, so awaiting it
 * is awaiting the promise the drain just walked away from. Unbounded, that hangs forever and the
 * deadline buys nothing.
 */
export function holdUntilShutdown(
  name: string,
  release: () => Promise<void>,
  options: HoldOptions = {},
): () => Promise<void> {
  const uninstall = installSignalHandlers({ exit: false });
  let unregister = (): void => {};
  // The hook's own `reason`, not a stopwatch of ours: `deadlineAt` is the instant core computed
  // when the drain began, on the same real monotonic clock, so this budget IS the drain's budget
  // rather than a second one that happens to be the same length.
  const shuttingDown = new Promise<number>((resolve) => {
    unregister = onShutdown(
      `cli:${name}:hold`,
      (reason) => {
        resolve(reason.deadlineAt);
      },
      { phase: 'accept' },
    );
  });

  let held: Promise<void> | undefined;
  return () => {
    // Memoised: awaiting a hold twice must not release twice, and `dispatch` is not the only
    // caller a test can be.
    held ??= (async () => {
      const deadlineAt = await shuttingDown;
      // Idempotent in core: this joins the drain already in flight and resolves when its last
      // phase is done. Calling it is what makes `release` the step after the drain, not beside it.
      await drain();
      unregister();
      uninstall();
      await releaseWithin(name, release, deadlineAt - systemClock.monotonic());
      options.exit?.(0);
    })();
    return held;
  };
}

/**
 * `release()` raced against what is left of the drain's budget.
 *
 * A local race and not core's `settleWithin`, which is internal to `lifecycle-deadline.ts` and not
 * on core's barrel. The semantics are deliberately the same, including the one that matters: a
 * REJECTION still rejects — `dispatch` awaits the hold inside its own `try`, and an embedded
 * database that would not close is a finding on the way out, never a clean exit over it.
 *
 * A budget already spent is `0`, and that abandons immediately by design: past `deadlineAt` the
 * orchestrator is already counting down to SIGKILL, so the honest move is to say so and exit
 * rather than to start a second grace period nobody granted.
 */
async function releaseWithin(
  name: string,
  release: () => Promise<void>,
  budgetMs: number,
): Promise<void> {
  const budget = Math.max(0, budgetMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandoned = new Promise<'abandoned'>((resolve) => {
    timer = setTimeout(() => resolve('abandoned'), budget);
  });
  try {
    const outcome = await Promise.race([release().then(() => 'released' as const), abandoned]);
    if (outcome === 'released') return;
    logger.warn('X_SHUTDOWN_TIMEOUT', {
      code: 'X_SHUTDOWN_TIMEOUT',
      cause: `the "${name}" release was still running ${budget}ms after the drain finished and has been ABANDONED — the process exits without it, so anything it held may not be closed`,
      fix: 'raise the budget past the slowest teardown — configureLifecycle({ deadlineMs: 600_000 }) for a 10-minute one — and set terminationGracePeriodSeconds to at least as many seconds',
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
