// Single responsibility: is this error worth trying again? One classification per code, carried on
// every `UltimateError` and in `--json`, so a client never has to hardcode a table of codes.
// The cycle with ./errors is the same deliberate one ./error-codes has: nothing here touches
// UltimateError at module-evaluation time.

import { UltimateError } from './errors';

/**
 * `terminal` — the same call will fail the same way forever (a config fault, a validation error,
 * a permission denial). `retryable` — a transient failure; back off and try again. `retry-after`
 * — retryable, but the responder said WHEN, and the client must read `Retry-After` / the error's
 * `meta` rather than guessing.
 */
export type ErrorRetry = 'terminal' | 'retryable' | 'retry-after';

export const ERROR_RETRY_KINDS = ['terminal', 'retryable', 'retry-after'] as const;

/**
 * Fail closed. An unclassified code is a code nobody thought about, and a client that retries one
 * during an incident triples the load on a service that is already broken — `X_TENANCY_UNSCOPED`
 * and `X_DB_DRIFT` are 500s and permanent config faults, so `status >= 500` was never the answer.
 */
export const DEFAULT_ERROR_RETRY: ErrorRetry = 'terminal';

/**
 * Core's own codes, and closed: an app that could reclassify `X_DRAINING` as terminal would be an
 * app whose clients stop retrying a rolling restart, which is the one case retrying always wins.
 * Only the exceptions are listed — everything else is `terminal` by the default above.
 */
// A `Map`, not a frozen object: `code` is a caller's string on every read below, and
// `CORE_ERROR_RETRY['constructor']` on an object literal answers the `Object` FUNCTION — which
// `retryFor` then returned as an `ErrorRetry`, into every `UltimateError.retry` and `toJSON()`.
const CORE_ERROR_RETRY: ReadonlyMap<string, ErrorRetry> = new Map(
  Object.entries({
    X_DRAINING: 'retryable',
    // A deadline that expired is the canonical back-off-and-try-again case: nothing about the
    // request was wrong, the budget ran out. Deliberately NOT `retry-after` — that spelling means
    // the responder named a time, and a timeout by definition produced no such answer. Its twin
    // `X_ABORTED` (the caller went away) is left to the `terminal` DEFAULT rather than listed here:
    // the answer is the same, and listing it would close a door nobody has asked to open.
    X_TIMEOUT: 'retryable',
    // Listed even though `terminal` is the default, and that is the whole point: `classifyThrown`
    // reads an UNREGISTERED code carrying `terminal` as unclassified, because a per-instance
    // `terminal` is indistinguishable from the default and honouring it would dead-letter the
    // first attempt of every job in every app whose codes nobody has classified. So a stub that
    // says "this build does not have the feature" fell through to the attempt count and burned a
    // job's whole retry policy on a fact that cannot change between attempt 1 and attempt 5.
    // It is core's code — every `notImplemented()` stub in the framework raises it — so it is
    // classified once here rather than by each package that happens to throw it.
    X_NOT_IMPLEMENTED: 'terminal',
  } as const),
);

const REGISTERED = new Map<string, ErrorRetry>();

export function isErrorRetry(value: unknown): value is ErrorRetry {
  return typeof value === 'string' && (ERROR_RETRY_KINDS as readonly string[]).includes(value);
}

function retryInvalid(code: string, cause: string): UltimateError {
  return new UltimateError({
    code: 'X_ERROR_RETRY_INVALID',
    cause: `${code}: ${cause}`,
    fix: `x errors list --json   # then registerErrorRetry({ ${code}: 'retryable' }) with one of ${ERROR_RETRY_KINDS.join(' | ')}`,
    meta: { code },
  });
}

/**
 * Declare how the codes this package or app throws should be retried. Call it once at boot beside
 * the module that declares the codes — importing that module IS the registration, the convention
 * `registerErrorCodes` and `registerErrorStatus` already use.
 *
 * ```ts
 * registerErrorRetry({ X_OAUTH_EXCHANGE_FAILED: 'retryable', X_RATE_LIMITED: 'retry-after' });
 * ```
 *
 * Re-registering the same value is fine — a module imported twice is not a bug. Registering a
 * DIFFERENT value throws, so two packages can never disagree about whether a code is safe to
 * hammer, and core's own codes cannot be moved at all.
 */
export function registerErrorRetry(retries: Readonly<Record<string, ErrorRetry>>): void {
  for (const [code, retry] of Object.entries(retries)) {
    if (!isErrorRetry(retry)) {
      throw retryInvalid(code, `"${String(retry)}" is not ${ERROR_RETRY_KINDS.join(' | ')}`);
    }
    const core = CORE_ERROR_RETRY.get(code);
    if (core !== undefined) {
      throw retryInvalid(code, `the framework already classifies it as ${core}`);
    }
    const existing = REGISTERED.get(code);
    if (existing !== undefined && existing !== retry) {
      throw retryInvalid(code, `already registered as ${existing}`);
    }
    REGISTERED.set(code, retry);
  }
}

/** Test seam. Production registers once at boot and never unregisters. */
export function resetErrorRetry(): void {
  REGISTERED.clear();
}

/**
 * The classification somebody actually DECLARED for this code, `undefined` when nobody did.
 *
 * `retryFor` answers a client's question — "may I send this again?" — and fails closed, so it
 * cannot tell a code declared `terminal` from a code nobody classified. A caller deciding whether
 * to STOP work already in flight has to tell them apart: the job executor reads this, because
 * treating every unclassified code as `terminal` would end the retry policy of every job in every
 * shipped app, which is a far larger fault than the one that reading brings.
 *
 * Core table first, for the same belt-and-braces reason `retryFor` had it first.
 */
export function declaredErrorRetry(code: string): ErrorRetry | undefined {
  return CORE_ERROR_RETRY.get(code) ?? REGISTERED.get(code);
}

export function retryFor(code: string): ErrorRetry {
  return declaredErrorRetry(code) ?? DEFAULT_ERROR_RETRY;
}

/** Every classification a package or app declared, for `x errors list` and the manifest. */
export function registeredErrorRetry(): Readonly<Record<string, ErrorRetry>> {
  return Object.fromEntries([...REGISTERED].sort(([a], [b]) => a.localeCompare(b)));
}
