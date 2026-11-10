// The idempotency-store suite over `@ultimat3/action`'s memory store (a handler's transactions on the
// embedded Postgres), and the proof it can fail: a store that settles by key alone, unfenced, one
// that settles outside the handler's transaction, and one that drops the redaction flag.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { memoryIdempotencyStore } from '@ultimat3/action';
import type { IdempotencyStore } from '@ultimat3/action/adapter';
import type { PgliteClient } from '@ultimat3/db';
import { outsideTransaction, pgliteClient, raw } from '@ultimat3/db';
import type { IdempotencyStoreSubject } from './idempotency-store-conformance';
import {
  IDEMPOTENCY_STORE_CHECKS,
  idempotencyStoreConformance,
} from './idempotency-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const RECLAIM_MS = 30_000;
// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 60_000;

let client: PgliteClient;

// `pgliteClient()` boots on its first statement: paid here, inside the hook's budget.
beforeAll(async () => {
  client = pgliteClient();
  await client.execute(raw('select 1'));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

/** The memory store, aged by moving its injected clock; `wrap` corrupts it for the broken cases. */
function memorySubject(
  wrap: (store: IdempotencyStore) => IdempotencyStore = (store) => store,
): IdempotencyStoreSubject {
  let nowMs = 1_700_000_000_000;
  const build = () =>
    wrap(memoryIdempotencyStore({ now: () => nowMs, reclaimAfterMs: () => RECLAIM_MS }));
  let store = build();
  return {
    get store() {
      return store;
    },
    get client() {
      return client;
    },
    reclaimAfterMs: RECLAIM_MS,
    age: (_key, ms) => {
      nowMs += ms;
      return Promise.resolve();
    },
    reset: () => {
      store = build();
      return Promise.resolve();
    },
  };
}

describe(testName('unit', 'the memory idempotency store'), () => {
  const subject = memorySubject();
  behavesLike(idempotencyStoreConformance, () => subject);
});

/** Settles whatever is under the key, whoever reserved it — the straggler overwrite. */
const unfenced = (inner: IdempotencyStore): IdempotencyStore => ({
  scope: inner.scope,
  keepsRedaction: true,
  reserve: (key, hash) => inner.reserve(key, hash),
  async settle(key, value, _reservationId, redacted) {
    const held = await inner.get(key);
    if (held !== undefined) await inner.settle(key, value, held.id, redacted);
  },
  release: (key, id) => inner.release(key, id),
  get: (key) => inner.get(key),
});

/** Declares `keepsRedaction` and drops the flag anyway: the replay hands back `[redacted]`. */
const forgetful = (inner: IdempotencyStore): IdempotencyStore => ({
  scope: inner.scope,
  keepsRedaction: true,
  reserve: (key, hash) => inner.reserve(key, hash),
  settle: (key, value, id) => inner.settle(key, value, id, false),
  release: (key, id) => inner.release(key, id),
  get: (key) => inner.get(key),
});

/** Settles at once, whatever transaction is open: a rollback leaves a success for a write that is gone. */
const autocommitOnly = (inner: IdempotencyStore): IdempotencyStore => ({
  scope: inner.scope,
  keepsRedaction: true,
  reserve: (key, hash) => outsideTransaction(() => inner.reserve(key, hash)),
  settle: (key, value, id, redacted) =>
    outsideTransaction(() => inner.settle(key, value, id, redacted)),
  release: (key, id) => inner.release(key, id),
  get: (key) => inner.get(key),
});

const check = (name: string) => {
  const found = IDEMPOTENCY_STORE_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

const failsOn = async (wrap: (store: IdempotencyStore) => IdempotencyStore, name: string) => {
  const broken = memorySubject(wrap);
  await broken.reset();
  await expect(check(name).run(broken)).rejects.toThrow();
  const sound = memorySubject();
  await check(name).run(sound);
};

describe(
  testName('unit', 'an idempotency store that breaks the contract fails conformance'),
  () => {
    test('a settle not fenced on the reservation id', async () => {
      await failsOn(unfenced, 'settle, fail and release are fenced');
    });

    test('a settle that ignores the open transaction', async () => {
      await failsOn(autocommitOnly, 'in a transaction: a rollback after the settle');
    });

    test('a settle that drops the redaction flag', async () => {
      await failsOn(forgetful, 'settle keeps the redaction flag');
      await failsOn(forgetful, 'a secret answer rests [redacted]');
    });

    test('every check has a name of its own', () => {
      const names = IDEMPOTENCY_STORE_CHECKS.map((each) => each.name);
      expect(new Set(names).size).toBe(names.length);
    });
  },
);
