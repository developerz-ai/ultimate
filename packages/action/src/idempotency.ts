/**
 * Idempotency for actions marked `idempotent`: the store seam, where the deployment declares
 * what it needs of one, and the replay-or-run gate. A retried key replays the first OUTCOME —
 * a value or a failure — and a concurrent duplicate is refused rather than run twice, because a
 * double charge is worse than a 409.
 */
import { fingerprint, isUltimateError, logger } from '@ultimat3/core';
import {
  IdempotencyConflictError,
  IdempotencyNotSharedError,
  IdempotencyReplayedFailureError,
} from './errors';
import { MemoryIdempotencyStore } from './idempotency-memory';

/**
 * Where a store's records live. Declared by the driver, never inferred — the same rule
 * `@ultimat3/http`'s `RateLimitStore.scope` follows, and for a worse failure: N replicas each
 * holding their own records means the retry that lands on replica B has never seen the key, so
 * the handler runs a second time and the card is charged twice. Silently, with `x verify` green.
 */
export type IdempotencyScope = 'process' | 'shared';

/**
 * What a failed attempt left behind, flat enough to survive a database round trip. An `Error`
 * object cannot: the record outlives the process that produced it, so the replay is rebuilt from
 * the four fields `UltimateError` already promises rather than from a serialized stack.
 */
export interface IdempotencyFailure {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs?: string | undefined;
}

/**
 * The closed list, in the order a record moves through it — and the ONE declaration. The type is
 * derived from it below rather than restated beside it, so a fourth status cannot be added to one
 * and missed by the other, which is exactly how `isIdempotencyStatus` would start refusing a word
 * this build writes itself.
 */
export const IDEMPOTENCY_STATUSES = Object.freeze(['in-flight', 'settled', 'failed'] as const);

export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

/**
 * The one narrowing for the status column, and never a cast. A record crosses a process boundary —
 * the row under this key was written by whatever build was deployed when the first attempt ran,
 * which on a rolling deploy is not this one — so `row.status as IdempotencyStatus` made an unknown
 * word answer `{ value: null, replayed: true }` in `withIdempotency`: the caller was told "this
 * already ran, here is its result" for a row nobody could read. The rule `@ultimat3/jobs`'
 * `statusIn` already writes out for the same column in the same situation.
 */
export function isIdempotencyStatus(value: string): value is IdempotencyStatus {
  return (IDEMPOTENCY_STATUSES as readonly string[]).includes(value);
}

export interface IdempotencyRecord {
  readonly id: string;
  readonly key: string;
  /** Fingerprint of the parsed input — a reused key with a new payload is a bug. */
  readonly requestHash: string;
  readonly status: IdempotencyStatus;
  readonly value: unknown;
  /** Present exactly when `status === 'failed'` — what the replay re-throws. */
  readonly failure?: IdempotencyFailure | undefined;
  /** Epoch milliseconds. The store's own dedupe window is measured from here. */
  readonly createdAt: number;
}

export interface IdempotencyReservation {
  readonly record: IdempotencyRecord;
  /** True only for the caller that won the race and must therefore run the handler. */
  readonly created: boolean;
}

export interface IdempotencyStore {
  /**
   * Where these records live. Optional only so an existing external implementation still
   * type-checks; an absent scope cannot be checked, so `assertIdempotencyScope` refuses it
   * exactly as it refuses a wrong one — the same rule `RateLimiter.buckets` follows.
   */
  readonly scope?: IdempotencyScope | undefined;
  /**
   * How long a key is remembered. Outside it a record answers as a missing one, which is the
   * only thing that keeps the store bounded: a key is caller-supplied, so an unbounded store
   * is one immortal entry per write, forever.
   */
  readonly windowMs?: number | undefined;
  /** Atomically create-or-fetch the record for `key`. The atomicity is the point. */
  reserve(key: string, requestHash: string): Promise<IdempotencyReservation>;
  /**
   * Settle the record `reservationId` owns — `IdempotencyReservation.record.id`, never the key
   * alone. Fenced on the id AND the status, the way `@ultimat3/jobs`' `SQL_ACK` fences on
   * `id = $1 and state = 'running'`.
   *
   * The status alone was not enough, and the gap it left is silent: a reservation whose window
   * lapsed is reclaimed by the next caller, so the record under that key is `in-flight` AGAIN and
   * belongs to someone else. A straggler from the first attempt satisfied the status fence
   * exactly, overwrote a live reservation, and the replacement's own settle was then fenced out —
   * so the retry replayed a value produced for a different request. A settlement that matches no
   * record is logged, never thrown: it lands after the handler has committed.
   */
  settle(key: string, value: unknown, reservationId: string): Promise<void>;
  /**
   * Settle a FAILURE, so the retry replays it instead of re-running a handler that may already
   * have committed. Fenced on the same reservation id as `settle`, for the same case — a
   * straggler's failure marking a live reservation `failed` is the worse half of it.
   *
   * Optional so an existing store still type-checks — and when it is absent the gate leaves the
   * reservation standing rather than releasing it, because refusing the retry is the safe answer
   * and re-running it is the double charge.
   */
  fail?(key: string, failure: IdempotencyFailure, reservationId: string): Promise<void>;
  /** Drop a reservation, so a retry can run. Only ever correct BEFORE the handler starts. */
  release(key: string): Promise<void>;
  get(key: string): Promise<IdempotencyRecord | undefined>;
}

/**
 * What the DEPLOYMENT requires of a store, against what the store provides. Two halves checked
 * once at registration, exactly as `RateLimitConfig.scope` is checked against `RateLimitStore`.
 */
export interface IdempotencyConfig {
  readonly scope: IdempotencyScope;
}

/**
 * One process is the only thing a framework can promise without being told; an app that runs
 * more than one says so, and brings the store that makes it true.
 */
export const DEFAULT_IDEMPOTENCY_CONFIG: IdempotencyConfig = Object.freeze({ scope: 'process' });

let config: IdempotencyConfig = DEFAULT_IDEMPOTENCY_CONFIG;
let defaultStore: IdempotencyStore = new MemoryIdempotencyStore();

/** Declared at boot, before `registerActions()`. Nothing infers a replica count. */
export function configureIdempotency(next: IdempotencyConfig): void {
  config = next;
}

export function idempotencyConfig(): IdempotencyConfig {
  return config;
}

export function setIdempotencyStore(store: IdempotencyStore): void {
  defaultStore = store;
}

export function getIdempotencyStore(): IdempotencyStore {
  return defaultStore;
}

/** Test-only. A process configures its idempotency once at boot and never reconfigures it. */
export function resetIdempotency(): void {
  config = DEFAULT_IDEMPOTENCY_CONFIG;
  defaultStore = new MemoryIdempotencyStore();
}

/**
 * Boot, never the first request — `registerAction` calls it, which every registration path funnels
 * through and which necessarily runs before a route is mounted. A per-process store under a
 * `'shared'` declaration is not a smaller guarantee, it is no guarantee: the retry that lands on
 * another replica finds no record and re-runs the handler, so an `idempotent: true` action charges
 * twice with nothing in any log to say it did. A store that declares no scope is refused too —
 * what cannot be shown to be shared is not assumed to be.
 */
export function assertIdempotencyScope(
  declared: IdempotencyConfig = idempotencyConfig(),
  store: IdempotencyStore = getIdempotencyStore(),
): void {
  if (declared.scope !== 'shared') return;
  if (store.scope !== 'shared') throw new IdempotencyNotSharedError(store.scope);
}

export interface IdempotentOutcome<T> {
  readonly value: T;
  readonly replayed: boolean;
}

/**
 * Replay-or-run. Five outcomes: fresh run, replay of a settled record, replay of a FAILED record,
 * X_IDEMPOTENCY_CONFLICT for a payload mismatch, X_IDEMPOTENCY_CONFLICT for a duplicate still in
 * flight.
 *
 * **Everything `run()` throws is treated as possibly-committed.** `guard()` and `validateInput`
 * both run before this gate is reached (`invoke.ts`), so by the time `run` is called the only
 * things left are the handler and `validateOutput` — and the second of those throws *after* the
 * first has committed. Releasing the reservation there is what turned a rounding change in an
 * output schema into a second charge: `X_OUTPUT_INVALID` dropped the record, and the client's
 * automatic retry re-ran a handler that had already taken the money. So the failure is SETTLED
 * and replayed, and `release` is reserved for a pre-handler failure — of which this gate has none.
 */
export async function withIdempotency<T>(
  store: IdempotencyStore,
  key: string,
  input: unknown,
  run: () => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  const requestHash = fingerprint(input);
  const { record, created } = await store.reserve(key, requestHash);
  if (record.requestHash !== requestHash) {
    throw new IdempotencyConflictError(key, 'payload-mismatch');
  }
  if (!created) {
    if (record.status === 'in-flight') throw new IdempotencyConflictError(key, 'in-flight');
    if (record.status === 'failed') throw new IdempotencyReplayedFailureError(key, record.failure);
    // The stored value is the previous return of this very handler.
    return { value: record.value as T, replayed: true };
  }
  let value: T;
  try {
    value = await run();
  } catch (error) {
    await settleFailure(store, key, record.id, error);
    throw error;
  }
  // Outside the `try` on purpose: a `settle` that refuses is itself post-commit, and the record
  // stays in flight rather than being released — a retry then gets a 409 it can act on instead of
  // re-running a handler that has already committed.
  //
  // `record.id` is THIS reservation's, so a straggler from an attempt whose window has since
  // lapsed cannot land on the replacement that reclaimed the key.
  await store.settle(key, value, record.id);
  return { value, replayed: false };
}

/**
 * Record the failure, and never let recording it replace the failure itself. A store that refuses
 * here would otherwise surface as the caller's error, hiding the `X_OUTPUT_INVALID` or the
 * handler's own throw that is the thing worth reading — the same rule `auditThrew` follows.
 */
async function settleFailure(
  store: IdempotencyStore,
  key: string,
  reservationId: string,
  error: unknown,
): Promise<void> {
  if (store.fail === undefined) {
    // Deliberately NOT `release`. A store with no failure slot cannot say "this already ran", and
    // the retry-safe reading of that is "refuse the retry", not "run it again".
    logger.warn('action.idempotency.failure-unrecorded', { key });
    return;
  }
  try {
    await store.fail(key, failureOf(error), reservationId);
  } catch (sinkError) {
    // Never the error's own text: rendering an `unknown` into a message is the second throw this
    // branch exists to prevent. The logger takes it as a field and shapes it itself.
    logger.error('action.idempotency.fail-refused', { key, error: sinkError });
  }
}

/**
 * A throw, flattened to the four fields a replay is rebuilt from. A non-`UltimateError` — a `row:`
 * loader's `TypeError`, a driver's own error — carries no stable code, so the record takes
 * `X_IDEMPOTENCY_REPLAYED_FAILURE` and says exactly that rather than inventing a code an app
 * might match on.
 */
function failureOf(error: unknown): IdempotencyFailure {
  if (!isUltimateError(error)) {
    return {
      code: 'X_IDEMPOTENCY_REPLAYED_FAILURE',
      cause: 'the first attempt under this key threw a value that is not an UltimateError',
      fix: 'read the first attempt in the logs, then send a fresh Idempotency-Key once the cause is fixed',
    };
  }
  return {
    code: error.code,
    cause: error.cause,
    fix: error.fix,
    docs: error.docs,
  };
}
