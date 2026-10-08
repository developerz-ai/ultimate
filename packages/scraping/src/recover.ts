// The recovery seam: what happens when a selector has moved and the run failed on it.
//
// One shape: a FUNCTION. An app writes its own fallback, gets the page and the failure, and
// answers whether the attempt should be retried. A model that re-derives the selector is the app's
// own hook wrapping `llm()` (axiom 8), never a string the framework interprets.

import { recoverRefused } from './error-throws';
import type { ScrapePage } from './page';

export interface RecoveryAttempt {
  readonly scrape: string;
  readonly page: ScrapePage;
  /** The failure, as thrown. `unknown` — it is whatever the body raised. */
  readonly failure: unknown;
  readonly attempt: number;
}

/**
 * `true` retries the body once more in the same session; `false` re-raises. A hook that returns
 * `false` is not an error — declining is a decision. `X_SCRAPE_RECOVER_REFUSED` is for the hook
 * that cannot even judge, and it carries the hook's own reason.
 */
export type RecoveryHook = (attempt: RecoveryAttempt) => Promise<boolean> | boolean;

export async function runRecovery(
  recovery: RecoveryHook,
  attempt: RecoveryAttempt,
): Promise<boolean> {
  const verdict: unknown = await recovery(attempt);
  if (typeof verdict !== 'boolean') {
    throw recoverRefused(attempt.scrape, 'the hook answered something other than true or false');
  }
  return verdict;
}
