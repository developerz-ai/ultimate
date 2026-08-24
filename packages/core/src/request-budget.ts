// How much of THIS request's budget is left, and the one header that carries it to the next hop.
// The header name lives here rather than in `@ultimat3/http` because both ends need it and only
// one of them is tier 2: the reader is http's `resolveTimeoutMs`, the writer is a typed client in
// tier 0, and a second literal in the writer is a propagation that silently stops working the day
// either string is edited.

import type { Ctx } from './context';
import { tryUseContext } from './context';

/**
 * A caller may SHORTEN the hop it is calling, never lengthen it — `@ultimat3/http`'s
 * `resolveTimeoutMs` takes the minimum of its own configured budget and this. It had ONE reader
 * and zero writers anywhere in the tree, so a 30s gateway budget that had already been spent to
 * t=29 handed the next service a fresh 30s: work still running, still holding a pool slot and a
 * vendor connection, 30 seconds after the caller's socket was answered `X_TIMEOUT`.
 */
export const REQUEST_TIMEOUT_HEADER = 'x-request-timeout-ms';

/**
 * Milliseconds left before this context's deadline, or `undefined` when there is no deadline or
 * it has already passed.
 *
 * `undefined` for a spent budget rather than `0`, and that is not a nicety: the far side ignores
 * anything under 1ms and falls back to its OWN configured budget, so a `0` on the wire reads as
 * "the caller asked for nothing" — the exact failure this header exists to prevent, one hop later.
 * Whether to make a call whose budget is gone is the caller's decision (`throwIfAborted`), not
 * this function's.
 */
export const remainingBudgetMs = (ctx: Ctx): number | undefined => {
  if (ctx.deadlineAt === null) return undefined;
  const left = Math.floor(ctx.deadlineAt - ctx.now().getTime());
  return left >= 1 ? left : undefined;
};

/**
 * The budget header for the ambient request, or nothing. Rounded DOWN by `remainingBudgetMs`:
 * a hop must never be told it has more time than the caller will wait.
 */
export const budgetHeaders = (): Record<string, string> => {
  const ctx = tryUseContext();
  if (ctx === undefined) return {};
  const left = remainingBudgetMs(ctx);
  return left === undefined ? {} : { [REQUEST_TIMEOUT_HEADER]: String(left) };
};
