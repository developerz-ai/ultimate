// Single responsibility: is this error worth trying again? One classification per code, carried on
// every `UltimateError` and in `--json`, so a client never has to hardcode a table of codes.
// The cycle with ./errors is the same deliberate one ./error-codes has: nothing here touches
// UltimateError at module-evaluation time.

import { isUltimateError, UltimateError } from './errors';

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
    // A gate at its ceiling with a full queue is the canonical "not now": nothing about the work
    // was wrong and the same call succeeds once a slot frees. `retry-after` rather than
    // `retryable` because the refusal NAMES a delay — `retryAfterSeconds` on its `meta`, the one
    // spelling `@ultimat3/http`'s `retryAfterOf` reads onto the header — so a caller that guesses
    // a backoff is guessing against an answer it was already given.
    X_FLIGHT_GATE_OVERLOADED: 'retry-after',
    // Listed for the same reason `X_NOT_IMPLEMENTED` is, and it matters more here: superseded work
    // re-run produces the same refusal by construction, so an UNCLASSIFIED reading would spend a
    // job's whole retry policy proving that the world has still moved on.
    X_SUPERSEDED: 'terminal',
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

/**
 * Test seam. Production registers once at boot and never unregisters.
 *
 * `restore` is not a nicety: this map is PROCESS-WIDE and every package fills it at module
 * evaluation, so a bare `clear()` in one file's `afterEach` deletes registrations that file never
 * made. Bun runs one process for the whole suite and `scripts/test-setup.ts` imports packages
 * before any test runs, so their module bodies never run again to repair it — measured,
 * `@ultimat3/policy`'s codes read as unclassified in every file loaded after core's tests, and
 * `@ultimat3/db`, `@ultimat3/ai` and `@ultimat3/jobs` each carry a `beforeEach` that re-registers
 * their own table for exactly this reason. Pass `registeredErrorRetry()` captured at module scope
 * and the wipe is scoped to what the test added.
 */
export function resetErrorRetry(restore: Readonly<Record<string, ErrorRetry>> = {}): void {
  REGISTERED.clear();
  for (const [code, retry] of Object.entries(restore)) REGISTERED.set(code, retry);
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

/**
 * The classification that was DECLARED for this throw, or `undefined` when there is none.
 *
 * Deliberately not `error.retry` alone. That field is `init.retry ?? retryFor(code)` and `retryFor`
 * fails closed, so every unclassified `UltimateError` already carries `terminal` — reading it would
 * dead-letter the first attempt of every job in every app whose codes nobody has classified yet. So
 * `terminal` counts only when it can have come from somewhere: an explicit per-instance override is
 * indistinguishable from the default here, which is why an UNCLASSIFIED code carrying an instance
 * `retry: 'terminal'` is read as unclassified. Register the code
 * (`registerErrorRetry({ X_YOUR_CODE: 'terminal' })`) to have it honoured.
 *
 * Lives here rather than beside an executor because it is the reader of the table above, and every
 * executor in the framework has to answer it the same way — `@ultimat3/jobs`' `classifyThrown` in
 * `retry-classification.ts` is this function, one tier up, and can delegate to it unchanged.
 */
export function classifyThrown(error: unknown): ErrorRetry | undefined {
  // The brand check, never `instanceof`: a duplicated module instance in the dependency tree makes
  // `instanceof` answer false for an error this framework built.
  if (!isUltimateError(error)) return undefined;
  const retry: unknown = error.retry;
  if (!isErrorRetry(retry)) return undefined;
  // Anything other than the fail-closed default can only have come from the code table or from an
  // explicit override, so it is somebody's answer either way.
  if (retry !== DEFAULT_ERROR_RETRY) return retry;
  return declaredErrorRetry(error.code) === undefined ? undefined : retry;
}

/**
 * The delay a `retry-after` error NAMED, in ms, or `undefined` when it named none.
 *
 * `retryAfterSeconds` on the error's `meta` is the framework's ONE spelling for it —
 * `@ultimat3/http`'s `rateLimited` writes it, its `retryAfterOf` renders it onto the `Retry-After`
 * header, `@ultimat3/auth`'s `kdfOverloaded` carries it — so a retry loop and an HTTP client wait
 * the same number. A literal key, not a constant: a computed read of a record is what
 * `bun run proto-index` refuses, and `meta` is a caller's object.
 */
export function statedDelayMs(error: unknown): number | undefined {
  if (!isUltimateError(error)) return undefined;
  const seconds: unknown = error.meta?.['retryAfterSeconds'];
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1_000);
}
