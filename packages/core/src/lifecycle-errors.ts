// Single responsibility: the one condition a lifecycle that has already drained raises, and the
// error that carries it. Split from `lifecycle.ts` so the state machine reads as a state machine,
// and registered here rather than in `error-codes.ts` for the reason `secrets-errors.ts` gives:
// the code and the module that throws it ship together.

import { registerErrorCodes } from './error-codes';
import { UltimateError } from './errors';

registerErrorCodes({
  X_LIFECYCLE_DRAINED: { title: 'a drained process cannot become ready again' },
});

/**
 * A role tried to become ready in a process whose lifecycle has already drained.
 *
 * Loud rather than tolerant, because the silent version was measured and is worse than a failed
 * boot: `state` never leaves `stopped` and `drain()` has memoized its promise, so a second
 * `createServer().start()` bound a real port, answered `X_DRAINING` (503) to every request, and was
 * still accepting connections after its own `stop()` returned — a dead listener holding a port,
 * with no log line naming what happened.
 *
 * The `fix` has to answer two readers, because there are exactly two ways here: a boot that starts
 * a role after SIGTERM has already arrived, and a test that drained in one case and built a server
 * in the next.
 */
export function lifecycleDrained(state: 'draining' | 'stopped'): UltimateError {
  return new UltimateError({
    code: 'X_LIFECYCLE_DRAINED',
    cause: `this process is ${state} — its lifecycle has already drained, and a drain is terminal: one process, one lifecycle. A role marked ready now would bind a socket that answers 503 to every request, and drain() memoizes, so nothing would ever close it`,
    fix: 'start every role BEFORE the first drain — a drained process is on its way out and is replaced, never reused. In a test, call resetLifecycle() from @ultimat3/core between the drain and the next start()',
    meta: { state },
  });
}
