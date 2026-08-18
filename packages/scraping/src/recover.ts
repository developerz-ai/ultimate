// The recovery seam: what happens when a selector has moved and the run failed on it.
//
// Two shapes. A FUNCTION is complete and shipped — an app writes its own fallback, gets the page
// and the failure, and answers whether the attempt should be retried. `'agent'` is the seam for
// letting a model re-derive the selector from the page, and it is an honest
// `X_NOT_IMPLEMENTED` today, in the shape `packages/jobs/src/driver-redis.ts` uses: correct types
// so an app can be written against it, one labelled throw, no silent no-op.

import { recoverRefused, scrapeNotImplemented } from './error-throws';
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

export type Recovery = RecoveryHook | 'agent';

/** What the agent recovery will need when it lands. Declared now so the seam is typed, not free. */
export interface AgentRecovery {
  readonly kind: 'agent';
  /** The model call. Deliberately not typed against `@ultimat3/ai` yet — see the throw below. */
  readonly instruction?: string | undefined;
}

const AGENT_FIX =
  "replace recover: 'agent' with a function — recover: ({ page }) => page.waitFor('<the moved selector>').then(() => true) — which is complete today";

export async function runRecovery(recovery: Recovery, attempt: RecoveryAttempt): Promise<boolean> {
  if (recovery === 'agent') {
    // The agent path lands with `@ultimat3/ai`'s `llm()` behind it: page HTML in, a selector out,
    // re-run once. Until it does, this throws rather than answering `false` — a recovery that
    // silently declines is indistinguishable from one that was never configured.
    throw scrapeNotImplemented("recover: 'agent'", AGENT_FIX);
  }
  const verdict: unknown = await recovery(attempt);
  if (typeof verdict !== 'boolean') {
    throw recoverRefused(attempt.scrape, 'the hook answered something other than true or false');
  }
  return verdict;
}
