// Staying up. A command whose server is still listening when `run` resolves is a command whose
// process `bin.ts` exits out from under — so it hands back a hold, and `dispatch` awaits that
// before the exit code. Ctrl-C then takes core's own three-phase drain (stop accepting, finish
// in-flight, close) instead of killing a query mid-round-trip.

import { drain, installSignalHandlers, onShutdown } from '@ultimat3/core';

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
 */
export function holdUntilShutdown(name: string, release: () => Promise<void>): () => Promise<void> {
  const uninstall = installSignalHandlers({ exit: false });
  let unregister = (): void => {};
  const shuttingDown = new Promise<void>((resolve) => {
    unregister = onShutdown(
      `cli:${name}:hold`,
      () => {
        resolve();
      },
      { phase: 'accept' },
    );
  });

  let held: Promise<void> | undefined;
  return () => {
    // Memoised: awaiting a hold twice must not release twice, and `dispatch` is not the only
    // caller a test can be.
    held ??= (async () => {
      await shuttingDown;
      // Idempotent in core: this joins the drain already in flight and resolves when its last
      // phase is done. Calling it is what makes `release` the step after the drain, not beside it.
      await drain();
      unregister();
      uninstall();
      await release();
    })();
    return held;
  };
}
