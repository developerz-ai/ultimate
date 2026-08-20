// The X_* codes owned by @ultimat3/scraping, and — the half that carries the weight — their
// retry classification. A scraper's whole operational question is "was that the site being slow
// or the site being different?", so every code here is registered as `retryable` or `terminal`
// once, in this file, rather than re-decided by whichever `catch` saw it.

import type { ErrorRetry } from '@ultimat3/core';
import {
  errorDocsUrl,
  registerErrorCodes,
  registerErrorRetry,
  UltimateError,
} from '@ultimat3/core';

/** Codes this package declares and owns. */
export const SCRAPE_OWNED_ERROR_CODES = [
  'X_SCRAPE_DRIVER_UNKNOWN',
  'X_SCRAPE_CDP_ATTACH_FAILED',
  'X_SCRAPE_BROWSER_UNREACHABLE',
  'X_SCRAPE_PROFILE_LOCKED',
  'X_SCRAPE_HOST_BLOCKED',
  'X_SCRAPE_SELECTOR_MISSING',
  'X_SCRAPE_NOT_ACTIONABLE',
  'X_SCRAPE_TIMEOUT',
  'X_SCRAPE_WEDGED',
  'X_SCRAPE_PAGE_CRASHED',
  'X_SCRAPE_OUTPUT_INVALID',
  'X_SCRAPE_YIELD_COLLAPSED',
  'X_SCRAPE_YIELD_HISTORY_MISSING',
  'X_SCRAPE_DOWNLOAD_TIMEOUT',
  'X_SCRAPE_ROBOTS_DISALLOWED',
  'X_SCRAPE_FIXTURE_MISSING',
  'X_SCRAPE_FIXTURE_STALE',
  'X_SCRAPE_REMOTE_REQUIRED',
  'X_SCRAPE_RECOVER_REFUSED',
  'X_SCRAPE_SECRET_EXPOSED',
  'X_SCRAPE_HTTP_FAILED',
  'X_SCRAPE_BODY_TOO_LARGE',
  'X_SCRAPE_AUTH_FAILED',
  'X_SCRAPE_SESSION_EXPIRED',
  'X_SCRAPE_PROMPT_UNANSWERED',
  'X_SCRAPE_BLOCKED',
] as const;

/**
 * `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s and `recover.ts` throws it for the agent seam, the
 * way `packages/jobs/src/driver-redis.ts` does for its stub. `X_ENV_MISSING` is core's too: a
 * declared secret with no value in the environment is a missing environment variable, not a
 * scraping concept needing its own code. No title is kept here for either — one code, one owner,
 * or the two copies drift.
 */
export const SCRAPE_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED', 'X_ENV_MISSING'] as const;

export const SCRAPE_ERROR_CODES = [
  ...SCRAPE_OWNED_ERROR_CODES,
  ...SCRAPE_BORROWED_ERROR_CODES,
] as const;

export type ScrapeOwnedErrorCode = (typeof SCRAPE_OWNED_ERROR_CODES)[number];
export type ScrapeErrorCode = (typeof SCRAPE_ERROR_CODES)[number];

export const SCRAPE_ERROR_TITLES: Readonly<Record<ScrapeOwnedErrorCode, string>> = {
  X_SCRAPE_DRIVER_UNKNOWN: 'no browser driver is installed for this run',
  X_SCRAPE_CDP_ATTACH_FAILED: 'the CDP endpoint refused the attach',
  X_SCRAPE_BROWSER_UNREACHABLE: 'the browser went away mid-run',
  X_SCRAPE_PROFILE_LOCKED: 'another process holds this browser profile',
  X_SCRAPE_HOST_BLOCKED: 'the page asked for a host allowHosts does not list',
  X_SCRAPE_SELECTOR_MISSING: 'the selector never appeared inside its window',
  X_SCRAPE_NOT_ACTIONABLE: 'the element is present and cannot be acted on',
  X_SCRAPE_TIMEOUT: 'the step exceeded its wall-clock budget',
  X_SCRAPE_WEDGED: 'the browser stopped answering and was killed',
  X_SCRAPE_PAGE_CRASHED: 'the renderer process died',
  X_SCRAPE_OUTPUT_INVALID: 'the extracted rows do not match the extract schema',
  X_SCRAPE_YIELD_COLLAPSED: 'the run succeeded and returned far too little',
  X_SCRAPE_YIELD_HISTORY_MISSING:
    'a maxDrop is declared and no history store can supply its baseline',
  X_SCRAPE_DOWNLOAD_TIMEOUT: 'the download never landed',
  X_SCRAPE_ROBOTS_DISALLOWED: 'robots.txt disallows this path',
  X_SCRAPE_FIXTURE_MISSING: 'the fixture driver has no recording for this request',
  X_SCRAPE_FIXTURE_STALE: 'the recording is older than the fixture max age',
  X_SCRAPE_REMOTE_REQUIRED: 'this driver needs a cdpUrl and was given none',
  X_SCRAPE_RECOVER_REFUSED: 'the recovery hook declined to recover this failure',
  X_SCRAPE_SECRET_EXPOSED: 'an artifact would have carried a secret this run typed',
  X_SCRAPE_HTTP_FAILED: 'the site answered the HTTP leg with a non-2xx status',
  X_SCRAPE_BODY_TOO_LARGE: 'the HTTP response body passed its byte cap',
  X_SCRAPE_AUTH_FAILED: 'the credentials were rejected',
  X_SCRAPE_SESSION_EXPIRED: 'the restored session is no longer valid and nothing can renew it',
  X_SCRAPE_PROMPT_UNANSWERED: 'a login step asked for a code and nothing answered',
  X_SCRAPE_BLOCKED: 'the site refused this client — the identity is spent',
};

// One unconditional call, so a second package claiming one of these codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(SCRAPE_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

/**
 * The retry table, which is this package's most load-bearing declaration: a worker reads it to
 * decide whether attempt 2 is worth running, and both wrong answers cost real money.
 *
 * The rule used, stated once: **retryable means the same code, run again, has a real chance of a
 * different answer.** Transport, budget and liveness faults qualify. Everything that says "the
 * page is not the page this scraper was written against" does not — attempt 5 hammers a site with
 * a request that cannot succeed, and on an authenticated target that is how three wrong attempts
 * lock an account. `X_SCRAPE_YIELD_COLLAPSED` is deliberately terminal for the same reason: a run
 * that returned nothing is a human's problem, not a queue's.
 */
export const SCRAPE_ERROR_RETRY = {
  X_SCRAPE_CDP_ATTACH_FAILED: 'retryable',
  X_SCRAPE_BROWSER_UNREACHABLE: 'retryable',
  X_SCRAPE_TIMEOUT: 'retryable',
  X_SCRAPE_WEDGED: 'retryable',
  X_SCRAPE_DOWNLOAD_TIMEOUT: 'retryable',
  // Retryable AND it burns the session first (`scrape-run.ts`). Retrying a block on the SAME
  // persisted identity re-trips it every time: the flagged cookies are the thing being refused,
  // so the retry has to arrive as somebody else or it is arithmetic, not a retry.
  X_SCRAPE_BLOCKED: 'retryable',
  // Non-2xx is transient far more often than not (429, 502, a deploy). A 4xx that is genuinely
  // permanent is thrown with a per-instance `terminal` override, which `UltimateError` supports —
  // one code, and the throw site decides, because the same status is both at different sites.
  X_SCRAPE_HTTP_FAILED: 'retryable',
  // Everything below is terminal, and each one is listed rather than left to the default so that
  // deleting a line is a visible decision.
  X_SCRAPE_DRIVER_UNKNOWN: 'terminal',
  X_SCRAPE_PROFILE_LOCKED: 'terminal',
  X_SCRAPE_HOST_BLOCKED: 'terminal',
  X_SCRAPE_SELECTOR_MISSING: 'terminal',
  X_SCRAPE_NOT_ACTIONABLE: 'terminal',
  // A renderer that died takes its tab's state with it. Every retry so far in this package is a
  // retry of an attempt that could still be somewhere; this one cannot, and a re-run of a
  // half-submitted form is the incident, not the recovery.
  X_SCRAPE_PAGE_CRASHED: 'terminal',
  X_SCRAPE_OUTPUT_INVALID: 'terminal',
  // A response size is a property of the endpoint, not of the moment: attempt 2 buffers the same
  // gigabyte and dies the same way. The fix is a number on the request, so a human decides it.
  X_SCRAPE_BODY_TOO_LARGE: 'terminal',
  X_SCRAPE_YIELD_COLLAPSED: 'terminal',
  // A declaration error, raised by `scrape()` before any attempt exists — there is no run to
  // retry, and the same definition would refuse identically forever.
  X_SCRAPE_YIELD_HISTORY_MISSING: 'terminal',
  X_SCRAPE_ROBOTS_DISALLOWED: 'terminal',
  X_SCRAPE_FIXTURE_MISSING: 'terminal',
  X_SCRAPE_FIXTURE_STALE: 'terminal',
  X_SCRAPE_REMOTE_REQUIRED: 'terminal',
  X_SCRAPE_RECOVER_REFUSED: 'terminal',
  X_SCRAPE_SECRET_EXPOSED: 'terminal',
  // THE hard rule of this package. A site that locks an account after three wrong attempts turns
  // a retrying framework into the thing that destroys the user's account — so a rejected
  // credential is terminal, always, and no retry policy, recovery hook or backoff can reach it.
  X_SCRAPE_AUTH_FAILED: 'terminal',
  X_SCRAPE_SESSION_EXPIRED: 'terminal',
  X_SCRAPE_PROMPT_UNANSWERED: 'terminal',
} as const satisfies Readonly<Record<ScrapeOwnedErrorCode, 'retryable' | 'terminal'>>;

registerErrorRetry(SCRAPE_ERROR_RETRY);

export interface ScrapeErrorInit {
  readonly code: ScrapeErrorCode;
  readonly cause: string;
  readonly fix: string;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Per-instance override of the table above, for the one case where a code is genuinely both:
   * a 429 and a 404 share `X_SCRAPE_HTTP_FAILED`, and only the throw site knows which it saw.
   */
  readonly retry?: ErrorRetry | undefined;
}

export class ScrapeError extends UltimateError {
  override readonly name = 'ScrapeError';

  constructor(init: ScrapeErrorInit) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: errorDocsUrl(init.code),
      meta: init.meta,
      ...(init.retry === undefined ? {} : { retry: init.retry }),
    });
  }
}

export function isScrapeError(value: unknown): value is ScrapeError {
  return value instanceof ScrapeError;
}

/** True when the failure is one a second attempt could survive — the table above, read back. */
export function isRetryableScrapeError(value: unknown): boolean {
  return isScrapeError(value) && value.retry !== 'terminal';
}
