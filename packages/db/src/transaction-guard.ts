// Single responsibility: the two refusals a statement meets before it reaches a transaction's
// connection, a scope that is over and work whose caller was already answered, and the scope store
// the second reads. Never on `runOn`: `settleFailure` and a job step's fenced write send past the
// abort through that funnel on purpose.

import { abandonment, asyncContext } from '@ultimat3/core';
// Type-only: `transaction.ts` imports this module, and a runtime edge would close the cycle.
import type { TxState } from './transaction';
import { txClosed } from './transaction-errors';

/** `completeTransaction()`'s mark on a root. */
export type TxMark = { readonly value: boolean };

// Core's one lazy seam, never a construction here: a module-scope `new` threw at EVALUATION in a
// browser bundle, where the bundler stubs `node:async_hooks` to `{}`, and took every importer of
// `@ultimat3/db` with it. `get()` still answers `undefined` outside a scope, so the server pays
// nothing for the deferral.
export const storage = asyncContext<TxState>('a database transaction');

/** A `DbTx` statement after its scope ended, committed and rolled back alike: one rule. */
export function refuseIfFinished(id: string, outcome: string): void {
  if (outcome !== 'open') throw txClosed(id, outcome);
}

/** The mark of the root still OPEN on this async context; a finished one exempts nothing. */
function openRootMark(): TxMark | undefined {
  const state = storage.get();
  return state?.live.value === true ? state.completing : undefined;
}

/**
 * Throws the signal's own reason, the same object: no wrapper and no new code. A marked root is
 * owed its COMMIT, so it passes. `completing` is the scope's own for a `DbTx` statement; omitted, a
 * write with no handle (entity's `writing()`, the enqueue facade) answers to the ambient root.
 */
export function refuseAbandoned(completing: TxMark | undefined = openRootMark()): void {
  if (completing?.value === true) return;
  const reason = abandonment();
  if (reason !== undefined) throw reason;
}
