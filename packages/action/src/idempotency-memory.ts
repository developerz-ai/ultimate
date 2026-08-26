/**
 * The default idempotency store: process memory, bounded and swept. Correct for one web process
 * and for tests, and refused at registration under a `shared` declaration — its `scope` says so.
 * Shaped after `@ultimat3/http`'s `memoryRateLimitStore`, including the deliberate eviction order.
 */
import { finiteCount, uuid } from '@ultimat3/core';
import type {
  IdempotencyFailure,
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyScope,
  IdempotencyStore,
} from './idempotency';

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
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  /** Declared, never inferred: this map is this process's and nothing else can reach it. */
  readonly scope: IdempotencyScope = 'process';
  readonly windowMs: number;
  readonly #maxKeys: number;
  readonly #evictTo: number;
  readonly #now: () => number;
  readonly #records = new Map<string, IdempotencyRecord>();
  #lastSweepMs = Number.NEGATIVE_INFINITY;

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    // Screened, not clamped: `Math.floor(NaN)` is `NaN`, so `size > maxKeys` is false for every
    // size and `now - at > windowMs` is false for every record — a table with no cap, holding keys
    // that never expire, out of a `Math.max` that reads like a guard.
    this.windowMs = finiteCount(
      'MemoryIdempotencyStore',
      'windowMs',
      options.windowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS,
      1,
    );
    this.#maxKeys = finiteCount(
      'MemoryIdempotencyStore',
      'maxKeys',
      options.maxKeys ?? DEFAULT_MAX_IDEMPOTENCY_KEYS,
      1,
    );
    // Batched down to 90% so the eviction sort is paid once per 10% of the cap, not per write.
    this.#evictTo = Math.max(1, Math.floor(this.#maxKeys * 0.9));
    this.#now = options.now ?? ((): number => Date.now());
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
    if (existing !== undefined && !this.#expired(existing, nowMs)) {
      return Promise.resolve({ record: existing, created: false });
    }
    const record: IdempotencyRecord = {
      id: uuid(),
      key,
      requestHash,
      status: 'in-flight',
      value: undefined,
      createdAt: nowMs,
    };
    this.#records.set(key, record);
    this.#maintain(nowMs);
    return Promise.resolve({ record, created: true });
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
  settle(key: string, value: unknown, reservationId: string): Promise<void> {
    const existing = this.#owned(key, reservationId);
    if (existing !== undefined) {
      this.#records.set(key, { ...existing, status: 'settled', value });
    }
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

  release(key: string): Promise<void> {
    this.#records.delete(key);
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
