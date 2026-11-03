// Single responsibility: run work again, on the framework's own terms AND within its caller's
// lifetime. The executor `error-retry.ts` never had — that module declares `terminal | retryable |
// retry-after` and nothing in the tree consulted it before deciding to try again, so four packages
// each shipped their own loop and only `@ultimat3/jobs`' asked the classification at all.

import type { Random } from './backoff';
import type { Ctx } from './context';
import { tryUseContext } from './context';
import type { RetryPolicy } from './retry-loop';
import { retryLoop } from './retry-loop';

export interface RetryDeps {
  /** Injected so a retry schedule is provable without waiting for one. Defaults to a timer. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Monotonic ms, read only when a time budget applies. Defaults to the system clock. */
  now?: (() => number) | undefined;
  random?: Random | undefined;
}

/** A timer an abort lets go of, so a retry abandoned mid-wait holds nothing for the full delay. */
const abortableTimer = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise<void>((done) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });

/**
 * The request's deadline as the loop's budget, when it is the tighter of the two. Not
 * `remainingBudgetMs`: that answers `undefined` for a spent budget as well as for no deadline,
 * which is right for a header and here would lift the bound exactly when it has run out.
 */
function withinDeadline(policy: RetryPolicy, ctx: Ctx | undefined): RetryPolicy {
  if (ctx === undefined || ctx.deadlineAt === null) return policy;
  const left = ctx.deadlineAt - ctx.now().getTime();
  const timeBudgetMs =
    policy.timeBudgetMs === undefined ? left : Math.min(policy.timeBudgetMs, left);
  return { ...policy, timeBudgetMs };
}

/**
 * Run `work` until it succeeds, the policy runs out, the classification says stop, the time budget
 * does, or the ambient caller is gone. Ambient and not an option, because a required `signal` is
 * the argument an agent forgets, and after the budget a forgotten one keeps sending to a vendor.
 *
 * The one place a retry loop meets its caller's lifetime. Work that must outlive its caller runs
 * inside `runToCompletion(fn)`, where the signal is live and the deadline null, so nothing clamps;
 * `retry()` has no opt-out of its own. The last error, or the signal's reason when no attempt ran,
 * reaches the caller unchanged.
 */
export async function retry<T>(
  work: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  deps: RetryDeps = {},
): Promise<T> {
  const ctx = tryUseContext();
  return await retryLoop(work, withinDeadline(policy, ctx), {
    sleep: deps.sleep ?? abortableTimer,
    now: deps.now,
    random: deps.random,
    signal: ctx?.signal,
  });
}
