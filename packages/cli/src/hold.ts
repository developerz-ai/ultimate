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
 * It is BOUNDED, and that is not a detail. `drain()` ABANDONS a hook that overruns
 * `ShutdownReason.deadlineAt` — the process is meant to exit without it — and `release` here
 * re-enters the very same teardown one call later: `app.stop()` -> `startRoles().stop()` ->
 * `worker.stop()`, memoised in the package that owns it, so awaiting it is awaiting the promise
 * the drain just walked away from. Unbounded, that hangs forever and the deadline buys nothing.
 *
 * The bound is what is LEFT of the drain's budget, under a floor of `MIN_RELEASE_MS` — see there
 * for why the remainder alone answered `0` on every busy pod and abandoned the teardown before it
 * closed anything.
 */
export function holdUntilShutdown(
  name: string,
  release: () => Promise<void>,
  options: HoldOptions = {},
): () => Promise<void> {
  const uninstall = installSignalHandlers({ exit: false });
  let unregister = (): void => {};
  // The hook's own `reason`, not a stopwatch of ours: `deadlineAt` is the instant core computed
  // when the drain began, on the same real monotonic clock, so what is left of the drain's budget
  // is read off the drain's own number and never off a second one of the same length.
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
      await releaseWithin(name, release, releaseBudgetMs(deadlineAt - systemClock.monotonic()));
      options.exit?.(0);
    })();
    return held;
  };
}

/**
 * The floor under `release`'s budget, and the reason the drain's REMAINDER alone is the wrong one.
 *
 * The remainder is what is left of a budget that was spent on something else. A drain that used
 * all of it — one request over budget is enough, and that is the ordinary shutdown on a busy pod —
 * hands `release` a NEGATIVE number, `Math.max(0, …)` reads it as `0`, and `setTimeout(resolve, 0)`
 * wins against any teardown whose first await is real work. Measured at `deadlineMs: 60` with one
 * `beginWork()` outstanding: the release STARTED and was abandoned 0ms later, so `app.stop()` never
 * reached the pool close, the NATS close, the cache tiers or the mail driver, and the outbox relay
 * was abandoned somewhere between `driver.enqueue` and `markPublished` — a duplicate job on the
 * next boot. The abandonment is not the harmless "exit slightly early" it was written as: it is
 * every resource the process holds, left to the kernel.
 *
 * So `release` gets a budget of its own, floored, never a leftover. 5s, and the arithmetic is
 * what makes it defensible rather than a feel: `DEFAULT_DEADLINE_MS` is 25s
 * (`packages/core/src/lifecycle.ts`) and `docker/helm/templates/deployments.yaml` sets
 * `terminationGracePeriodSeconds: 45`, so a drain that spends everything PLUS a release that
 * spends everything is 30s — still inside the grace period, so the kubelet never SIGKILLs a
 * process this floor kept alive. It stays a floor and not a clamp: an app that raised
 * `deadlineMs` for a slow teardown keeps the bigger number.
 */
export const MIN_RELEASE_MS = 5_000;

/**
 * What `release` really gets. Non-finite is the floor rather than the input, for the reason
 * `packages/core/src/lifecycle-bounds.test.ts` exists: `Math.max(n, NaN)` is `NaN` and
 * `setTimeout(fn, NaN)` fires on the next tick, which is this whole defect a second time.
 */
export const releaseBudgetMs = (remainingMs: number): number =>
  Number.isFinite(remainingMs) ? Math.max(MIN_RELEASE_MS, remainingMs) : MIN_RELEASE_MS;

/**
 * `release()` raced against its own budget.
 *
 * A local race and not core's `settleWithin`, which is internal to `lifecycle-deadline.ts` and not
 * on core's barrel. The semantics are deliberately the same, including the one that matters: a
 * REJECTION still rejects — `dispatch` awaits the hold inside its own `try`, and an embedded
 * database that would not close is a finding on the way out, never a clean exit over it.
 */
async function releaseWithin(
  name: string,
  release: () => Promise<void>,
  budgetMs: number,
): Promise<void> {
  // Screened by `releaseBudgetMs`, which is the one answer to "how long does a teardown get" —
  // a second `Math.max` here would be a second, quieter one.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandoned = new Promise<'abandoned'>((resolve) => {
    timer = setTimeout(() => resolve('abandoned'), budgetMs);
  });
  try {
    const outcome = await Promise.race([release().then(() => 'released' as const), abandoned]);
    if (outcome === 'released') return;
    logger.warn('X_SHUTDOWN_TIMEOUT', {
      code: 'X_SHUTDOWN_TIMEOUT',
      // Rounded: `deadlineAt - monotonic()` is a float, and `4923.185900000001ms` in a shutdown
      // log reads as a bug in the number rather than as the budget it is.
      cause: `the "${name}" release was still running ${Math.round(budgetMs)}ms after the drain finished and has been ABANDONED — the process exits without it, so anything it held may not be closed`,
      fix: 'raise the budget past the slowest teardown — configureLifecycle({ deadlineMs: 600_000 }) for a 10-minute one — and set terminationGracePeriodSeconds to at least as many seconds',
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
