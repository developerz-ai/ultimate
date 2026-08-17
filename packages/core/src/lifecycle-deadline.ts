// Single responsibility: run one shutdown hook under the drain's remaining budget. A hook that
// overruns is ABANDONED — still running, no longer awaited — because a deadline that only logged
// leaves the kubelet to SIGKILL the process, which is the failure the budget exists to prevent.
// Split out of `lifecycle.ts` so the race has no access to the drain's module state.

/**
 * What became of one hook. `abandoned` is the only outcome the caller must report: the hook is
 * still running, nothing will ever read its result, and whatever it had in flight may be
 * incomplete — which is the price of a deadline and has to be visible in the log line.
 */
export type HookOutcome =
  | { readonly kind: 'settled' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'abandoned' };

const SETTLED: HookOutcome = Object.freeze({ kind: 'settled' });
const ABANDONED: HookOutcome = Object.freeze({ kind: 'abandoned' });

const failed = (error: unknown): HookOutcome => ({ kind: 'failed', error });

/**
 * `work()` raced against `budgetMs` of REAL elapsed time. `budgetMs` is required and is a `number`:
 * every drain has a budget, so "no budget" is not a case this has to answer for, and the signature
 * is what stops it from becoming one.
 *
 * A synchronous throw and a rejection are one outcome (`failed`); the caller logs both the same
 * way. Nothing here throws: a drain that rejects never reaches `process.exit(0)`.
 */
export function settleWithin(
  work: () => void | Promise<void>,
  budgetMs: number,
): Promise<HookOutcome> {
  let started: void | Promise<void>;
  try {
    started = work();
  } catch (error) {
    return Promise.resolve(failed(error));
  }
  const pending = Promise.resolve(started);
  return new Promise<HookOutcome>((resolve) => {
    let decided = false;
    const timer = setTimeout(
      () => {
        if (decided) return;
        decided = true;
        resolve(ABANDONED);
      },
      Math.max(0, budgetMs),
    );
    // A budget already spent still gives a synchronous hook its turn — a resolved promise settles
    // on a microtask and this timer on a macrotask — so closing a pool costs nothing it does not
    // already have. It must also never be the thing keeping a drained process alive.
    timer.unref?.();
    // Attached unconditionally, on both settle paths: an abandoned hook that rejects later has
    // nobody left awaiting it, and an unhandled rejection would kill the process this drain is
    // trying to end cleanly. After the decision the outcome is dropped on purpose — the overrun
    // was already reported, and a second line about a hook nobody is waiting for is noise.
    pending.then(
      () => {
        if (decided) return;
        decided = true;
        clearTimeout(timer);
        resolve(SETTLED);
      },
      (error: unknown) => {
        if (decided) return;
        decided = true;
        clearTimeout(timer);
        resolve(failed(error));
      },
    );
  });
}
