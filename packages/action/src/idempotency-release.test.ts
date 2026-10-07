// `release` is fenced on the reservation's own id AND `in-flight`, exactly as `settle` and `fail`
// are. Unfenced, a straggler's release — `beforeRun` refusing after its reservation was reclaimed
// past the deadline — DELETED the replacement's record: settled, it made the next retry re-run a
// handler that had already committed (the double charge); in flight, it let a duplicate run beside it.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { setLogSink } from '@ultimat3/core';
import type { PgliteClient } from '@ultimat3/db';
import { pgliteClient } from '@ultimat3/db';
import { type IdempotencyStore, withIdempotency } from './idempotency';
import { memoryIdempotencyStore } from './idempotency-memory';
import { memoryUnderTest, postgresUnderTest } from './idempotency-tx-fixture';

const KEY = '["chargeCard","user","u1",null,"k1"]';
const HASH = 'h1';

let client: PgliteClient;

beforeAll(() => {
  client = pgliteClient();
});

afterAll(async () => {
  await client.close();
});

const STORES = [
  ['memory', () => Promise.resolve(memoryUnderTest())],
  ['postgres (embedded)', () => postgresUnderTest(client)],
] as const;

for (const [name, build] of STORES) {
  describe(`release is fenced on the reservation — ${name}`, () => {
    let under: Awaited<ReturnType<(typeof STORES)[number][1]>>;

    beforeAll(async () => {
      under = await build();
    });

    beforeEach(async () => {
      await under.reset();
    });

    test('a straggler’s release leaves the replacement’s SETTLED record standing', async () => {
      const first = await under.store.reserve(KEY, HASH);
      await under.store.release(KEY, first.record.id);
      const second = await under.store.reserve(KEY, HASH);
      expect(second.created).toBe(true);
      await under.store.settle(KEY, { charged: 'ch_2' }, second.record.id, false);

      await under.store.release(KEY, first.record.id);

      expect((await under.store.get(KEY))?.status).toBe('settled');
    });

    test('a straggler’s release leaves the replacement’s IN-FLIGHT reservation standing', async () => {
      const first = await under.store.reserve(KEY, HASH);
      await under.store.release(KEY, first.record.id);
      const second = await under.store.reserve(KEY, HASH);

      await under.store.release(KEY, first.record.id);

      const record = await under.store.get(KEY);
      expect(record?.id).toBe(second.record.id);
      expect(record?.status).toBe('in-flight');
    });

    test('the owner’s own release drops it, so a retry can run', async () => {
      const first = await under.store.reserve(KEY, HASH);
      await under.store.release(KEY, first.record.id);
      expect(await under.store.get(KEY)).toBeUndefined();
      expect((await under.store.reserve(KEY, HASH)).created).toBe(true);
    });
  });
}

describe('withIdempotency releases THIS reservation, never the key', () => {
  test('a refusing beforeRun hands release the id it reserved', async () => {
    const inner = memoryIdempotencyStore();
    const released: [string, string][] = [];
    let reserved = '';
    const store: IdempotencyStore = {
      scope: inner.scope,
      keepsRedaction: true,
      reserve: async (key, hash) => {
        const reservation = await inner.reserve(key, hash);
        reserved = reservation.record.id;
        return reservation;
      },
      settle: (key, value, id, redacted) => inner.settle(key, value, id, redacted),
      fail: (key, failure, id) => inner.fail(key, failure, id),
      release: (key, id) => {
        released.push([key, id]);
        return inner.release(key, id);
      },
      get: (key) => inner.get(key),
    };
    const refused = new RangeError('bucket empty');

    const failure = await withIdempotency(store, KEY, { amount: 1 }, () => Promise.resolve(1), {
      beforeRun: () => Promise.reject(refused),
    }).catch((error: unknown) => error);

    expect(failure).toBe(refused);
    expect(released).toEqual([[KEY, reserved]]);
    expect(await inner.get(KEY)).toBeUndefined();
  });

  test('a release the store refuses is logged, and the caller still gets the beforeRun refusal', async () => {
    const inner = memoryIdempotencyStore();
    const store: IdempotencyStore = {
      scope: inner.scope,
      keepsRedaction: true,
      reserve: (key, hash) => inner.reserve(key, hash),
      settle: (key, value, id, redacted) => inner.settle(key, value, id, redacted),
      fail: (key, failure, id) => inner.fail(key, failure, id),
      release: () => Promise.reject(new TypeError('connection reset')),
      get: (key) => inner.get(key),
    };
    const refused = new RangeError('bucket empty');
    const lines: string[] = [];
    const previous = setLogSink((line) => {
      lines.push(line);
    });
    let failure: unknown;
    try {
      failure = await withIdempotency(store, KEY, { amount: 1 }, () => Promise.resolve(1), {
        beforeRun: () => Promise.reject(refused),
      }).catch((error: unknown) => error);
    } finally {
      setLogSink(previous);
    }

    expect(failure).toBe(refused);
    expect(lines.some((line) => line.includes('action.idempotency.release-refused'))).toBe(true);
  });
});
