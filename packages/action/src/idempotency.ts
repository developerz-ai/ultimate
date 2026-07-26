/**
 * Idempotency for actions marked `idempotent`. A retried key replays the first
 * response; a concurrent duplicate is refused rather than run twice, because a
 * double charge is worse than a 409.
 */
import { uuid } from '@ultimat3/core';
import { IdempotencyConflictError } from './errors';
import { fingerprint } from './stable';

export interface IdempotencyRecord {
  readonly id: string;
  readonly key: string;
  /** Fingerprint of the parsed input — a reused key with a new payload is a bug. */
  readonly requestHash: string;
  readonly status: 'in-flight' | 'settled';
  readonly value: unknown;
  readonly createdAt: number;
}

export interface IdempotencyReservation {
  readonly record: IdempotencyRecord;
  /** True only for the caller that won the race and must therefore run the handler. */
  readonly created: boolean;
}

export interface IdempotencyStore {
  /** Atomically create-or-fetch the record for `key`. The atomicity is the point. */
  reserve(key: string, requestHash: string): Promise<IdempotencyReservation>;
  settle(key: string, value: unknown): Promise<void>;
  /** Drop a reservation whose handler threw, so a retry can run. */
  release(key: string): Promise<void>;
  get(key: string): Promise<IdempotencyRecord | undefined>;
}

/**
 * Default store: process memory. Correct for one web process and for tests;
 * production swaps in a Postgres-backed store behind the same interface (a
 * single `insert ... on conflict do nothing returning` gives the same atomicity).
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, IdempotencyRecord>();

  async reserve(key: string, requestHash: string): Promise<IdempotencyReservation> {
    const existing = this.#records.get(key);
    if (existing !== undefined) return { record: existing, created: false };
    const record: IdempotencyRecord = {
      id: uuid(),
      key,
      requestHash,
      status: 'in-flight',
      value: undefined,
      createdAt: Date.now(),
    };
    this.#records.set(key, record);
    return { record, created: true };
  }

  async settle(key: string, value: unknown): Promise<void> {
    const existing = this.#records.get(key);
    if (existing === undefined) return;
    this.#records.set(key, { ...existing, status: 'settled', value });
  }

  async release(key: string): Promise<void> {
    this.#records.delete(key);
  }

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    return this.#records.get(key);
  }
}

let defaultStore: IdempotencyStore = new MemoryIdempotencyStore();

export function setIdempotencyStore(store: IdempotencyStore): void {
  defaultStore = store;
}

export function getIdempotencyStore(): IdempotencyStore {
  return defaultStore;
}

/** Keys are namespaced per action: the same key under two actions is two keys. */
export function idempotencyKeyFor(actionName: string, key: string): string {
  return `${actionName}:${key}`;
}

export interface IdempotentOutcome<T> {
  readonly value: T;
  readonly replayed: boolean;
}

/**
 * Replay-or-run. Four outcomes: fresh run, replay of a settled record,
 * X_IDEMPOTENCY_CONFLICT for a payload mismatch, X_IDEMPOTENCY_CONFLICT for a
 * duplicate that is still in flight.
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
    // The stored value is the previous return of this very handler.
    return { value: record.value as T, replayed: true };
  }
  try {
    const value = await run();
    await store.settle(key, value);
    return { value, replayed: false };
  } catch (error) {
    await store.release(key);
    throw error;
  }
}
