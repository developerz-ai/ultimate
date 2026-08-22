// Where the records live is DECLARED, refused at registration, and the memory store is bounded.
// The failure this replaces is silent: `replicas: 3` with a per-process store means the retry
// that lands on another replica finds no record and charges the card again, with `x verify` green.

import { afterEach, describe, expect, test } from 'bun:test';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { IdempotencyStore } from './idempotency';
import {
  assertIdempotencyScope,
  configureIdempotency,
  getIdempotencyStore,
  resetIdempotency,
  setIdempotencyStore,
} from './idempotency';
import { MemoryIdempotencyStore } from './idempotency-memory';
import { registerAction, resetRegistry } from './registry';

const anAction = () =>
  action({
    input: t.object({ id: t.string }),
    output: t.object({ ok: t.boolean }),
    policy: allow(),
    idempotent: true,
    handle: () => ({ ok: true }),
  });

afterEach(() => {
  resetIdempotency();
  resetRegistry();
});

describe("a 'shared' declaration over a process store is refused at boot", () => {
  test('registering an action is where it is caught, before any route is mounted', () => {
    configureIdempotency({ scope: 'shared' });
    expect(() => registerAction('chargeCard', anAction())).toThrow(/X_IDEMPOTENCY_NOT_SHARED/);
  });

  test('a store that declares no scope is refused too — unproven is not assumed', () => {
    const noScope: IdempotencyStore = {
      reserve: () => Promise.reject(new Error('unused')),
      settle: () => Promise.resolve(),
      release: () => Promise.resolve(),
      get: () => Promise.resolve(undefined),
    };
    setIdempotencyStore(noScope);
    configureIdempotency({ scope: 'shared' });
    expect(() => assertIdempotencyScope()).toThrow(/X_IDEMPOTENCY_NOT_SHARED/);
  });

  test('a shared store satisfies the same declaration', () => {
    const inner = new MemoryIdempotencyStore();
    const shared: IdempotencyStore = {
      scope: 'shared',
      windowMs: inner.windowMs,
      reserve: (key, hash) => inner.reserve(key, hash),
      settle: (key, value, id) => inner.settle(key, value, id),
      fail: (key, failure, id) => inner.fail(key, failure, id),
      release: (key) => inner.release(key),
      get: (key) => inner.get(key),
    };
    setIdempotencyStore(shared);
    configureIdempotency({ scope: 'shared' });
    expect(() => registerAction('chargeCard', anAction())).not.toThrow();
  });

  test('the default is process, so an undeclared app registers exactly as before', () => {
    expect(getIdempotencyStore().scope).toBe('process');
    expect(() => registerAction('chargeCard', anAction())).not.toThrow();
  });
});

describe('the memory store is bounded and swept', () => {
  test('a record past the window answers as a missing one, so the key is reusable', async () => {
    let now = 1_000;
    const store = new MemoryIdempotencyStore({ windowMs: 5_000, now: () => now });
    const first = await store.reserve('k', 'hash-a');
    expect(first.created).toBe(true);
    await store.settle('k', 'v', first.record.id);

    // Inside the window: the same key replays.
    expect((await store.reserve('k', 'hash-a')).created).toBe(false);
    expect(await store.get('k')).toBeDefined();

    now += 5_000;
    expect(await store.get('k')).toBeUndefined();
    // And a fresh payload under the reclaimed key is a fresh reservation, not a conflict.
    expect((await store.reserve('k', 'hash-b')).created).toBe(true);
  });

  test('the cap holds under a flood of distinct keys', async () => {
    const store = new MemoryIdempotencyStore({ maxKeys: 100 });
    for (let i = 0; i < 5_000; i += 1) {
      const { record } = await store.reserve(`k${i}`, 'hash');
      await store.settle(`k${i}`, i, record.id);
    }
    expect(store.size).toBeLessThanOrEqual(100);
  });

  test('an in-flight reservation survives the eviction that drops settled ones', async () => {
    const store = new MemoryIdempotencyStore({ maxKeys: 10 });
    // Reserved and never settled: dropping this one is what would let a concurrent duplicate run.
    await store.reserve('in-flight', 'hash');
    for (let i = 0; i < 500; i += 1) {
      const { record } = await store.reserve(`k${i}`, 'hash');
      await store.settle(`k${i}`, i, record.id);
    }
    expect((await store.get('in-flight'))?.status).toBe('in-flight');
  });
});
