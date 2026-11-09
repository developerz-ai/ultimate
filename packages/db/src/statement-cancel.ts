// Single responsibility: cancel a POOLED READ on the server when the scope that sent it aborts, so a
// caller who hung up stops holding a pool connection until `statement_timeout`. The scope's signal
// is read ambiently (core's context), once per statement, by `client.ts`'s pooled `run`.

import { isUltimateError, throwIfAborted, tryUseContext } from '@ultimat3/core';
import type { BunSqlDriver } from './bun-sql';
import { statementVerb } from './statement-shape';

type Send = Pick<BunSqlDriver, 'unsafe'>;

/** `Bun.SQL`'s query: a promise with `cancel()`, which sends the server a CancelRequest (`57014`). */
type CancellableQuery = Promise<unknown> & { readonly cancel?: unknown };

export interface AbortWatch {
  /** `driver`, with each query it sends watched. */
  on(driver: Send): Send;
  /** What the caller is thrown: the abort's own error when this watch cancelled, else `error`. */
  failure(error: unknown): unknown;
  /** Detach from the signal; the statement settled. */
  end(): void;
}

/**
 * A watch for one pooled statement, or `undefined` when there is nothing to cancel — and the rule
 * for which is the whole design:
 *
 * - **A read, by its verb (`select`), never a write.** A hang-up is Bun's uncoded abort, and a
 *   click followed by a navigation must keep landing (`abandonment()` in core); a `with` may hide a
 *   data-modifying CTE, so it is not a read here.
 * - **Pooled, never pinned.** Cancelling a statement inside a transaction aborts the transaction,
 *   which is `transaction-guard.ts`'s decision to make, not a funnel's (`completeTransaction()`).
 * - **In flight when the abort lands, never sent after it.** A job's settle and a fenced write go
 *   out past their abort on purpose, so an already-aborted scope sends exactly as before.
 *
 * A driver whose query carries no `cancel()` (a fake) is waited out, as before this existed.
 */
export function watchAbort(text: string): AbortWatch | undefined {
  const ctx = tryUseContext();
  if (ctx === undefined || ctx.signal.aborted || statementVerb(text) !== 'select') return undefined;
  const { signal } = ctx;
  let query: CancellableQuery | undefined;
  let settled = false;
  let cancelled = false;
  const cancel = (): void => {
    if (settled || query === undefined || typeof query.cancel !== 'function') return;
    cancelled = true;
    // Synchronous on `Bun.SQL`; a throw here is the driver's and the statement simply runs on.
    try {
      query.cancel();
    } catch {
      cancelled = false;
    }
  };
  signal.addEventListener('abort', cancel, { once: true });
  return {
    on: (driver) => ({
      unsafe(statement, values) {
        const sending = driver.unsafe(statement, values) as CancellableQuery;
        query = sending;
        // Marked on the query's own settle, before the funnel's chain resumes: a cancel sent after
        // the answer would land on whatever this connection runs next.
        const mark = (): void => {
          settled = true;
        };
        sending.then(mark, mark);
        return sending;
      },
    }),
    failure(error) {
      if (!cancelled) return error;
      // A coded reason was somebody answered (`X_TIMEOUT`, a job's `X_ABORTED`): the same object,
      // as `abandonment()` hands it. Uncoded is a hang-up: core's own `X_ABORTED`, by its one maker.
      if (isUltimateError(signal.reason)) return signal.reason;
      try {
        throwIfAborted(ctx);
      } catch (aborted) {
        return aborted;
      }
      return error;
    },
    end: () => {
      settled = true;
      signal.removeEventListener('abort', cancel);
    },
  };
}
