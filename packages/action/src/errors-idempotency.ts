/**
 * The five idempotency failures, split out of `errors.ts` at its line ceiling. One subclass per
 * stable code, exactly as there — the codes and their titles stay in `errors.ts`'s one
 * `registerErrorCodes` call, because a second registration is how two modules end up deciding a
 * title by load order.
 */
import { errorDocsUrl, renderCauseValue, UltimateError } from '@ultimat3/core';
// Type-only: `idempotency.ts` imports the classes below, and a runtime edge here would close the
// cycle. `verbatimModuleSyntax` is what makes that guarantee mechanical.
import type { IdempotencyFailure } from './idempotency';

// Core's spelling, aliased — never a second one, and the same alias `errors.ts` takes.
const docs = errorDocsUrl;

export type IdempotencyConflictReason = 'payload-mismatch' | 'in-flight';

export class IdempotencyConflictError extends UltimateError {
  constructor(key: string, reason: IdempotencyConflictReason) {
    super({
      code: 'X_IDEMPOTENCY_CONFLICT',
      cause:
        reason === 'payload-mismatch'
          ? `idempotency key "${key}" was already used with a different payload`
          : `idempotency key "${key}" is still in flight from an earlier request`,
      // A paste-able call, the spelling `IdempotencyKeyInvalidError` already uses: both failures
      // are the CLIENT's to act on, and one header built two ways is two ways to get it wrong.
      fix:
        reason === 'payload-mismatch'
          ? 'set the Idempotency-Key header to a fresh crypto.randomUUID() — one key per payload, since this one already names a different request'
          : 'resend this request with the same Idempotency-Key once the first one settles — a fresh crypto.randomUUID() here would run the mutation twice',
      docs: docs('X_IDEMPOTENCY_CONFLICT'),
    });
  }
}

export type IdempotencyKeyProblem = 'empty' | 'too-long';

/**
 * The header arrived and cannot name one request. Refused, never read as absent: `Headers.get()`
 * answers `''` for `Idempotency-Key:` rather than `null`, so a blank value became a live key that
 * every caller sending a blank header shared — and reading it as "no key" is the quieter failure,
 * because a client whose key interpolation produced nothing would lose the protection silently
 * and double-charge on its own retry. `@ultimat3/jobs` refuses an empty key at the enqueue for the
 * same reason; it uses `assert` because the empty key there is the app's own declaration, while
 * this one is a caller's header and therefore a 4xx.
 *
 * The length bound is the one the OpenAPI operation has always published (`maxLength: 255`).
 * A contract that disagrees with the runtime is worse than no contract.
 */
export class IdempotencyKeyInvalidError extends UltimateError {
  constructor(action: string, problem: IdempotencyKeyProblem, length: number) {
    super({
      code: 'X_IDEMPOTENCY_KEY_INVALID',
      cause:
        problem === 'empty'
          ? `action "${action}" was called with an empty Idempotency-Key, which every caller sending a blank header would share`
          : `action "${action}" was called with an Idempotency-Key of ${length} characters, past the 255 its OpenAPI operation publishes`,
      fix: 'set the Idempotency-Key header to a fresh crypto.randomUUID() on the client, one per request — or omit the header entirely to run this call without idempotency',
      docs: docs('X_IDEMPOTENCY_KEY_INVALID'),
      meta: { action, problem, length },
    });
  }
}

/**
 * The deployment declared `scope: 'shared'` and the installed store cannot keep it. Refused at
 * registration, before a socket opens, because the failure it replaces is silent and expensive:
 * a per-process store under `replicas: 3` means the retry that lands on another replica finds no
 * record, re-runs the handler, and charges the card again — with nothing anywhere saying it did.
 * An UNDECLARED scope is refused the same way: what cannot be shown to be shared is not assumed
 * to be, the rule `assertRouteBuckets` already applies to a limiter that publishes no table.
 */
export class IdempotencyNotSharedError extends UltimateError {
  constructor(storeScope: string | undefined) {
    super({
      code: 'X_IDEMPOTENCY_NOT_SHARED',
      cause:
        storeScope === undefined
          ? "configureIdempotency({ scope: 'shared' }) is declared and the installed idempotency store declares no scope"
          : `configureIdempotency({ scope: 'shared' }) is declared and the installed idempotency store is ${storeScope}`,
      // NOT `executor: Bun.sql` — `Bun.sql.query` is `undefined` (it is a tagged template whose
      // positional form is `unsafe`), so that line compiled and would have thrown on the first
      // reservation. The framework's own boot already installs this store; a host booting the
      // framework itself wraps the client it opened.
      fix: "the framework boot installs a shared store — reach this only from a host that boots it itself: setIdempotencyStore(postgresIdempotencyStore({ executor: { query: (text, values) => client.query({ text, values }) } })) from '@ultimat3/action', or drop the declaration to configureIdempotency({ scope: 'process' })",
      docs: docs('X_IDEMPOTENCY_NOT_SHARED'),
      meta: { storeScope: storeScope ?? null },
    });
  }
}

/**
 * The replay of a first attempt that FAILED. It is a replay and not a re-run on purpose: `guard()`
 * and the input parse both run before the idempotency gate, so everything the gate can see throw
 * is post-authorization and possibly post-commit — a handler that took the money and then failed
 * its own `output:` schema is the case this exists for. Releasing the reservation there let the
 * client's automatic retry charge a second time, which made idempotency the cause of the double
 * charge it exists to prevent.
 *
 * The first attempt's code is re-used verbatim, the way `RemoteActionError` re-uses the server's:
 * the caller is owed the failure it would have got, not a new one. `X_IDEMPOTENCY_REPLAYED_FAILURE`
 * is the code only when the original throw carried none of its own.
 */
export class IdempotencyReplayedFailureError extends UltimateError {
  /** The recorded first attempt, so a caller reads the original code without parsing a message. */
  readonly failure: IdempotencyFailure;

  constructor(key: string, failure: IdempotencyFailure | undefined) {
    const recorded: IdempotencyFailure = failure ?? {
      code: 'X_IDEMPOTENCY_REPLAYED_FAILURE',
      cause: 'the first attempt under this key failed and the store kept no detail of it',
      fix: 'read the first attempt in the logs, then send a fresh Idempotency-Key once the cause is fixed',
    };
    super({
      code: recorded.code,
      cause: `${recorded.cause} — replayed from the first attempt under Idempotency-Key "${key}", which may have committed before it failed`,
      fix: recorded.fix,
      ...(recorded.docs === undefined ? {} : { docs: recorded.docs }),
      // `replayed` is what tells an operator this is not a second execution: nothing ran here.
      meta: { origin: 'idempotent-replay', key, replayed: true, code: recorded.code },
    });
    this.failure = recorded;
  }
}

/**
 * The stored record holds a status word this build has no branch for. Refused, never cast: with
 * `row.status as IdempotencyStatus`, an unknown word fell through every branch of
 * `withIdempotency` and answered `{ value: null, replayed: true }` — "this already ran, here is
 * its result" — for a record nobody could read, which is the silent wrong answer idempotency
 * exists to prevent. The mirror of `@ultimat3/jobs`' `X_JOB_ROW_STATUS_UNKNOWN`, for the same
 * column shape and the same cause: the record was written by whatever build was deployed when the
 * first attempt ran, which on a rolling deploy is not this one.
 */
export class IdempotencyStatusUnknownError extends UltimateError {
  constructor(input: { key: string; value: unknown; known: readonly string[] }) {
    super({
      code: 'X_IDEMPOTENCY_STATUS_UNKNOWN',
      cause:
        `x_idempotency.status holds ${renderCauseValue(input.value)} for key "${input.key}", ` +
        `which this build does not know — it reads ${input.known.join(', ')}`,
      fix: `psql "$DATABASE_URL" -c "select key, status from x_idempotency where status not in ('in-flight', 'settled', 'failed')" # then drain the older processes: a status this build cannot read was written by a newer deploy`,
      docs: docs('X_IDEMPOTENCY_STATUS_UNKNOWN'),
      meta: { key: input.key, value: renderCauseValue(input.value), known: [...input.known] },
    });
  }
}
