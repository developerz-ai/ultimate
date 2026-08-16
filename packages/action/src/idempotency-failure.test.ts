// The case that shipped: a throw AFTER the handler committed. `withIdempotency` released the
// reservation there, so the client's automatic retry re-ran a committed handler — idempotency
// causing the double charge it exists to prevent. Written failure-first: every test here fails
// against a gate that releases on a post-commit throw.

import { describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { IdempotencyFailure, IdempotencyStore } from './idempotency';
import { withIdempotency } from './idempotency';
import { MemoryIdempotencyStore } from './idempotency-memory';
import { invoke } from './invoke';

const Input = t.object({ amount: t.number });
// The handler returns a `chargeId` the schema requires; the drift is the provider handing back
// a fractional amount `t.number.int()` rejects — AFTER the money moved.
const Output = t.object({ chargeId: t.string, amount: t.number.int() });
const charger = createContext({
  actor: { ...userActor({ id: 'u1' }), permissions: ['card:charge'] },
});

/** Commits (increments `charges`) and then returns a value its own `output:` rejects. */
function chargeCard() {
  let charges = 0;
  const target = action({
    input: Input,
    output: Output,
    policy: can('card:charge'),
    idempotent: true,
    handle: ({ input }) => {
      charges += 1;
      // A rounding change at the provider: the money moved, the shape did not survive.
      return { chargeId: `ch_${charges}`, amount: input.amount + 0.5 };
    },
  }).named('chargeCard');
  return { target, charges: () => charges };
}

describe('a post-commit throw does not release the reservation', () => {
  test('the retry replays the failure instead of charging a second time', async () => {
    const { target, charges } = chargeCard();
    const store = new MemoryIdempotencyStore();
    const options = { ctx: charger, store, idempotencyKey: 'key-1' } as const;

    const first = await invoke(target, { amount: 10 }, options).catch((error: unknown) => error);
    expect((first as { code?: string }).code).toBe('X_OUTPUT_INVALID');
    expect(charges()).toBe(1);

    const retry = await invoke(target, { amount: 10 }, options).catch((error: unknown) => error);
    // The handler did NOT run again — that is the whole finding.
    expect(charges()).toBe(1);
    // And the caller gets the first attempt's own code back, not a fresh failure.
    expect((retry as { code?: string }).code).toBe('X_OUTPUT_INVALID');
    expect((retry as { meta?: { replayed?: boolean } }).meta?.replayed).toBe(true);
  });

  test('the record is settled as failed, never dropped', async () => {
    const { target } = chargeCard();
    const store = new MemoryIdempotencyStore();
    await invoke(target, { amount: 10 }, { ctx: charger, store, idempotencyKey: 'key-1' }).catch(
      () => undefined,
    );
    const record = await store.get('chargeCard:key-1');
    expect(record?.status).toBe('failed');
    expect(record?.failure?.code).toBe('X_OUTPUT_INVALID');
  });

  test('a handler that throws a plain Error is replayed under the framework code', async () => {
    const store = new MemoryIdempotencyStore();
    let runs = 0;
    const run = (): Promise<never> => {
      runs += 1;
      throw new TypeError('the driver is gone');
    };
    await withIdempotency(store, 'k', { a: 1 }, run).catch(() => undefined);
    const replay = await withIdempotency(store, 'k', { a: 1 }, run).catch(
      (error: unknown) => error,
    );
    expect(runs).toBe(1);
    expect((replay as { code?: string }).code).toBe('X_IDEMPOTENCY_REPLAYED_FAILURE');
  });

  test('a settle that refuses leaves the record in flight, so the retry is a 409', async () => {
    // The other post-commit path: the handler committed and the store could not record it.
    // Releasing here would re-run the handler; refusing the retry is the only safe answer.
    const inner = new MemoryIdempotencyStore();
    const store: IdempotencyStore = {
      scope: 'process',
      reserve: (key, hash) => inner.reserve(key, hash),
      settle: () => Promise.reject(new Error('store is down')),
      fail: (key, failure: IdempotencyFailure) => inner.fail(key, failure),
      release: (key) => inner.release(key),
      get: (key) => inner.get(key),
    };
    let runs = 0;
    const run = (): Promise<string> => {
      runs += 1;
      return Promise.resolve('ok');
    };
    await withIdempotency(store, 'k', { a: 1 }, run).catch(() => undefined);
    const retry = await withIdempotency(store, 'k', { a: 1 }, run).catch((error: unknown) => error);
    expect(runs).toBe(1);
    expect((retry as { code?: string }).code).toBe('X_IDEMPOTENCY_CONFLICT');
  });

  test('a store with no `fail` slot refuses the retry rather than re-running it', async () => {
    // The fail-closed fallback for an external store written against the old interface.
    const inner = new MemoryIdempotencyStore();
    const store: IdempotencyStore = {
      scope: 'process',
      reserve: (key, hash) => inner.reserve(key, hash),
      settle: (key, value) => inner.settle(key, value),
      release: (key) => inner.release(key),
      get: (key) => inner.get(key),
    };
    let runs = 0;
    const run = (): Promise<never> => {
      runs += 1;
      throw new TypeError('boom');
    };
    await withIdempotency(store, 'k', { a: 1 }, run).catch(() => undefined);
    const retry = await withIdempotency(store, 'k', { a: 1 }, run).catch((error: unknown) => error);
    expect(runs).toBe(1);
    expect((retry as { code?: string }).code).toBe('X_IDEMPOTENCY_CONFLICT');
  });
});
