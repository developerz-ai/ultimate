// The retry classification for this package's codes, apart from ./errors only because one file has
// one job and that catalogue is at its ceiling. The codes, their titles and the single
// `registerErrorCodes` call stay in ./errors — one owner, one registration.

import type { ErrorRetry } from '@ultimat3/core';
import { registerErrorRetry } from '@ultimat3/core';
import type { AiErrorCode } from './errors';

/**
 * May a client run this model call again? Unclassified means `terminal` — core fails closed — and
 * until 2026-08-23 this package classified nothing, so `X_AI_PROVIDER_UNAVAILABLE` told every HTTP
 * client not to come back from the one failure the gateway's own backoff loop exists for.
 *
 * The rule, stated once: **retryable means the same call, made again, has a real chance of a
 * different answer, and costs nothing to be wrong about beyond one more attempt.** In this package
 * that is exactly one thing — a provider that could not answer. Everything else is a statement
 * about the request, the declaration, the catalogue or the money, and a second attempt buys the
 * same answer at full price.
 *
 * **Only the exception is listed.** Everything else keeps the fail-closed default rather than being
 * registered AS terminal, and the difference is not cosmetic: `@ultimat3/jobs` dead-letters a
 * registered `terminal` on attempt 1, where an unclassified code keeps the job's own attempt count.
 * That is very likely the right answer for `X_LLM_REFUSED` and `X_AI_BUDGET_EXCEEDED` — a refusal
 * re-run is a second identical bill — but it is a change to how every app's jobs fail, and it
 * belongs to whoever makes it deliberately rather than to a sweep that was fixing the retryable
 * half.
 */
export const AI_ERROR_RETRY = {
  // The transport code. A 503, a 429, a reset socket, every candidate exhausted — the request was
  // well formed and nobody could answer it yet. `retryable` and NOT `retry-after`: that spelling
  // means the responder NAMED a time, `statedDelayMs` reads exactly one field for it
  // (`meta.retryAfterSeconds`), and neither wire format in this package parses the `Retry-After`
  // header off a 429 — so the honest answer is "come back", not a delay this package invented.
  //
  // The half of this code that is NOT transient — "no configured provider serves this model" — is
  // an `app.config.ts` edit, and it carries a per-instance `terminal` at its two throw sites
  // instead of a second code. `UltimateError` supports that override precisely because one code can
  // be both, and registering the code here is what makes the override honoured: core reads an
  // instance `terminal` on an UNREGISTERED code as unclassified.
  X_AI_PROVIDER_UNAVAILABLE: 'retryable',
} as const satisfies Readonly<Partial<Record<AiErrorCode, ErrorRetry>>>;

// `Partial`, so the table may be a subset — but every key is still checked against the declared set,
// so a typo or a renamed code is a build error rather than a classification nothing ever throws.
registerErrorRetry(AI_ERROR_RETRY);
