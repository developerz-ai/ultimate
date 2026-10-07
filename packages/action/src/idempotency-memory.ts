/**
 * The default idempotency store: process memory, bounded and swept. Correct for one web process
 * and for tests, and refused at registration under a `shared` declaration — its `scope` says so.
 * Shaped after `@ultimat3/http`'s `memoryRateLimitStore`, including the deliberate eviction order.
 */
import { finiteCount, uuidV7 } from '@ultimat3/core';
import { IdempotencyReservationLostError } from './errors-idempotency';
import type {
  IdempotencyFailure,
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyScope,
  IdempotencyStore,
} from './idempotency';
import { requestDeadlineMs } from './request-deadline';
import { liveTransaction } from './tx-scope';

/**
 * How long a key is remembered. A day is the window every payment API this shape exists to serve
 * publishes, and it is a *bound*, not a promise of forever: a caller retrying two days later is
 * making a new request, and the store says so by treating the record as missing.
 */
export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Hard bound on tracked keys. A key is `action:caller-supplied-string`, so its cardinality is the
 * write rate, not the user count — at 500 idempotent writes a second an unbounded map is 43M
 * immortal entries a day and an OOM. At ~250 bytes an entry this cap is a few megabytes, held.
 */
export const DEFAULT_MAX_IDEMPOTENCY_KEYS = 10_000;

/** An idle store still sweeps this often, so a burst's records do not sit until the next one. */
const SWEEP_EVERY_MS = 60_000;

export interface MemoryIdempotencyStoreOptions {
  readonly windowMs?: number | undefined;
  readonly maxKeys?: number | undefined;
  /** Injectable so a test can age a record without sleeping. */
  readonly now?: (() => number) | undefined;
  /**
   * The request deadline, read at every reservation — how long an in-flight record whose
   * settlement rides a transaction is kept before a retry may take the key. Default: the app's
   * own `requestTimeoutMs` (`requestDeadlineMs`). `0` is "no deadline".
   */
  readonly reclaimAfterMs?: (() => number) | undefined;
}

/**
 * What an in-flight record's transaction has to do with it — the memory twin of the Postgres
 * store's `tx_bound` column and of the row lock its settle holds until COMMIT. Keyed by the record
 * object: a settled or failed record is a new object, so these never outlive the flight.
 */
interface Flight {
  /** Reserved inside a transaction: its settle commits with the write or not at all. */
  readonly bound: boolean;
  /** The settle ran and its transaction has not ended yet — nobody may reclaim it now. */
  settling: boolean;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  /** Declared, never inferred: this map is this process's and nothing else can reach it. */
  readonly scope: IdempotencyScope = 'process';
  readonly keepsRedaction = true as const;
  readonly windowMs: number;
  readonly #maxKeys: number;
  readonly #evictTo: number;
  readonly #now: () => number;
  readonly #reclaimAfterMs: () => number;
  readonly #flights = new WeakMap<IdempotencyRecord, Flight>();
  readonly #records = new Map<string, IdempotencyRecord>();
  #lastSweepMs = Number.NEGATIVE_INFINITY;

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    // Screened, not clamped: `Math.floor(NaN)` is `NaN`, so `size > maxKeys` is false for every
    // size and `now - at > windowMs` is false for every record — a table with no cap, holding keys
    // that never expire, out of a `Math.max` that reads like a guard.
    this.windowMs = finiteCount(
      'memoryIdempotencyStore',
      'windowMs',
      options.windowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS,
      1,
    );
    this.#maxKeys = finiteCount(
      'memoryIdempotencyStore',
      'maxKeys',
      options.maxKeys ?? DEFAULT_MAX_IDEMPOTENCY_KEYS,
      1,
    );
    // Batched down to 90% so the eviction sort is paid once per 10% of the cap, not per write.
    this.#evictTo = Math.max(1, Math.floor(this.#maxKeys * 0.9));
    this.#now = options.now ?? ((): number => Date.now());
    this.#reclaimAfterMs = options.reclaimAfterMs ?? requestDeadlineMs;
  }

  /** Records tracked right now — the bound, observable. */
  get size(): number {
    return this.#records.size;
  }

  reserve(key: string, requestHash: string): Promise<IdempotencyReservation> {
    const nowMs = this.#now();
    const existing = this.#records.get(key);
    // Expired is missing. A record past the window answers exactly as a first-ever key does, so
    // reclaiming it here is what makes the window mean something rather than being a comment.
    if (
      existing !== undefined &&
      !this.#expired(existing, nowMs) &&
      !this.#abandoned(existing, nowMs)
    ) {
      return Promise.resolve({ record: existing, created: false });
    }
    const record: IdempotencyRecord = {
      id: uuidV7(),
      key,
      requestHash,
      status: 'in-flight',
      value: undefined,
      createdAt: nowMs,
    };
    this.#records.set(key, record);
    this.#flights.set(record, { bound: liveTransaction() !== undefined, settling: false });
    this.#maintain(nowMs);
    return Promise.resolve({ record, created: true });
  }

  /**
   * An in-flight record past the request deadline whose settle was BOUND to a transaction: that
   * settle lands with the commit or not at all, so the record being in flight proves nothing
   * committed. An autocommit handler's record is never this — it may have written before it died.
   */
  #abandoned(record: IdempotencyRecord, nowMs: number): boolean {
    const flight = this.#flights.get(record);
    if (record.status !== 'in-flight' || flight === undefined) return false;
    if (!flight.bound || flight.settling) return false;
    const reclaimAfterMs = finiteCount(
      'memoryIdempotencyStore',
      'reclaimAfterMs',
      this.#reclaimAfterMs(),
    );
    return reclaimAfterMs > 0 && nowMs - record.createdAt >= reclaimAfterMs;
  }

  /**
   * Both settlements are FENCED on the reservation's own `id` AND on `in-flight`, as
   * `SQL_IDEMPOTENCY_SETTLE` is and as `@ultimat3/jobs`' `SQL_ACK` is. A record past the window is
   * reclaimed by the next caller, so a straggler from the reservation before it would otherwise
   * overwrite a record it no longer owns and the next replay would answer one request with
   * another's value. The status alone does not catch it — the reclaimed record is `in-flight`
   * again — which is why the id is half the fence. Both stores fence, or the guarantee is
   * whichever store the deployment happens to install.
   */
  settle(key: string, value: unknown, reservationId: string, redacted: boolean): Promise<void> {
    const existing = this.#owned(key, reservationId);
    // Spread only when set, so an unredacted record keeps the exact shape it always had.
    const settled = (from: IdempotencyRecord): IdempotencyRecord => ({
      ...from,
      status: 'settled',
      value,
      ...(redacted ? { redacted: true } : {}),
    });
    const tx = liveTransaction();
    if (tx === undefined) {
      if (existing !== undefined) this.#records.set(key, settled(existing));
      return Promise.resolve();
    }
    // Inside a transaction the record is settled BY the commit, as the Postgres store's is: a
    // rollback leaves it in flight rather than replaying a success for rows nobody stored. And a
    // settle that lost its reservation is thrown, because nothing has committed yet and the throw
    // is what rolls this attempt back beside the retry that replaced it.
    if (existing === undefined) {
      return Promise.reject(new IdempotencyReservationLostError(key));
    }
    const flight = this.#flights.get(existing);
    if (flight !== undefined) flight.settling = true;
    tx.onRollback(() => {
      if (flight !== undefined) flight.settling = false;
    });
    tx.onCommit(() => {
      // Still this reservation's: `settling` kept a reclaim away, and `release` may have dropped it.
      if (this.#records.get(key) === existing) {
        this.#records.set(key, settled(existing));
      }
    });
    return Promise.resolve();
  }

  fail(key: string, failure: IdempotencyFailure, reservationId: string): Promise<void> {
    const existing = this.#owned(key, reservationId);
    if (existing !== undefined) {
      this.#records.set(key, { ...existing, status: 'failed', value: undefined, failure });
    }
    return Promise.resolve();
  }

  /** The record this reservation may still write, or nothing — the fence, in one place. */
  #owned(key: string, reservationId: string): IdempotencyRecord | undefined {
    const existing = this.#records.get(key);
    if (existing === undefined) return undefined;
    if (existing.status !== 'in-flight' || existing.id !== reservationId) return undefined;
    return existing;
  }

  /** Fenced by `#owned`, as both settlements are: a record that is not this reservation stays. */
  release(key: string, reservationId: string): Promise<void> {
    if (this.#owned(key, reservationId) !== undefined) this.#records.delete(key);
    return Promise.resolve();
  }

  get(key: string): Promise<IdempotencyRecord | undefined> {
    const record = this.#records.get(key);
    if (record === undefined || this.#expired(record, this.#now()))
      return Promise.resolve(undefined);
    return Promise.resolve(record);
  }

  #expired(record: IdempotencyRecord, nowMs: number): boolean {
    return nowMs - record.createdAt >= this.windowMs;
  }

  /**
   * Sweep, then evict — and the eviction order is part of the guarantee. Expired records go for
   * free, because they already answer as missing. Only if that is not enough does the cap take
   * live state, and then **`in-flight` records are the last to go**: one of those is the
   * reservation that stops a concurrent duplicate from running the handler a second time, so
   * dropping it is the double charge this store exists to prevent. That is the mirror of
   * `memoryRateLimitStore` evicting the fullest bucket first — never swap either for an LRU.
   */
  #maintain(nowMs: number): void {
    if (this.#records.size <= this.#maxKeys && nowMs - this.#lastSweepMs < SWEEP_EVERY_MS) return;
    this.#lastSweepMs = nowMs;
    for (const [key, record] of this.#records) {
      if (this.#expired(record, nowMs)) this.#records.delete(key);
    }
    if (this.#records.size <= this.#maxKeys) return;
    const settled = [...this.#records.entries()]
      .filter(([, record]) => record.status !== 'in-flight')
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [key] of settled) {
      if (this.#records.size <= this.#evictTo) break;
      this.#records.delete(key);
    }
    // If nothing settled is left the map may still exceed the cap. That is deliberate and it is
    // bounded by in-flight concurrency, not by the write rate — and every one of those records
    // becomes sweepable the moment it ages past the window.
  }
}

/**
 * The one way to build the memory store — the twin of `postgresIdempotencyStore()`. The class
 * stays a type in the barrel (`X_FACTORY_NAME_SPELLING`), so `new` is never a second spelling.
 */
export function memoryIdempotencyStore(
  options: MemoryIdempotencyStoreOptions = {},
): MemoryIdempotencyStore {
  return new MemoryIdempotencyStore(options);
}
