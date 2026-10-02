// One set of cases, two stores: the process default (memory) and the shared one (Postgres, here
// the embedded server). Dev runs the first and production the second, so a case that settles in
// one and stays in flight in the other is a bug that only ships. The live suite runs the same
// harness against Postgres 17, where the reservation really is on a second connection.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgliteClient } from '@ultimat3/db';
import { createPgliteClient, withTransaction } from '@ultimat3/db';
import {
  memoryUnderTest,
  postgresUnderTest,
  RECLAIM_MS,
  type TxHarness,
  txHarness,
} from './idempotency-tx-fixture';

const KEY = '["chargeCard","user","u1",null,"k1"]';
const late = (): Promise<void> => Promise.reject(new RangeError('the unit of work failed late'));
const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

let client: PgliteClient;

beforeAll(() => {
  client = createPgliteClient();
});

afterAll(async () => {
  await client.close();
});

const STORES = [
  ['memory', () => Promise.resolve(memoryUnderTest())],
  ['postgres (embedded)', () => postgresUnderTest(client)],
] as const;

for (const [name, build] of STORES) {
  describe(`idempotency in a transaction — ${name}`, () => {
    let harness: TxHarness;

    beforeAll(async () => {
      harness = await txHarness(client, await build());
    });

    beforeEach(async () => {
      await harness.reset();
    });

    test('a commit settles the record with the write, and the retry replays it', async () => {
      await harness.charge(KEY, 'ch_1');
      expect(await harness.statusOf(KEY)).toBe('settled');
      expect(await harness.charge(KEY, 'ch_2')).toEqual({
        value: { charged: 'ch_1' },
        replayed: true,
      });
      expect(await harness.charges()).toEqual(['ch_1']);
    });

    test('a rollback after the settle leaves no settled record for a write that is gone', async () => {
      const failure = await harness
        .charge(KEY, 'ch_1', { after: late })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(RangeError);
      expect(await harness.charges()).toEqual([]);
      expect(await harness.statusOf(KEY)).not.toBe('settled');
    });

    test('past the deadline the retry RUNS, and exactly one write is stored', async () => {
      await harness.charge(KEY, 'ch_1', { after: late }).catch(() => undefined);
      await harness.age(KEY, RECLAIM_MS + 1_000);

      expect(await harness.charge(KEY, 'ch_2')).toEqual({
        value: { charged: 'ch_2' },
        replayed: false,
      });
      expect(await harness.charges()).toEqual(['ch_2']);
      expect(await harness.statusOf(KEY)).toBe('settled');
    });

    test('a record reserved in a transaction and never settled is freed by the deadline', async () => {
      await withTransaction(
        async () => {
          expect((await harness.store.reserve(KEY, 'hash')).created).toBe(true);
        },
        { client },
      );
      await harness.age(KEY, RECLAIM_MS + 1_000);
      expect((await harness.store.reserve(KEY, 'hash')).created).toBe(true);
    });

    test('an AUTOCOMMIT record that never settled is NOT freed by the deadline', async () => {
      // No transaction: the handler may have committed before the process died.
      expect((await harness.store.reserve(KEY, 'hash')).created).toBe(true);
      await harness.age(KEY, RECLAIM_MS + 1_000);

      const second = await harness.store.reserve(KEY, 'hash');
      expect(second.created).toBe(false);
      expect(second.record.status).toBe('in-flight');
    });

    test('autocommit, unchanged: the settle is immediate and a retry replays', async () => {
      await harness.chargeAutocommit(KEY, 'ch_1');
      expect(await harness.statusOf(KEY)).toBe('settled');
      expect(await harness.chargeAutocommit(KEY, 'ch_2')).toEqual({
        value: { charged: 'ch_1' },
        replayed: true,
      });
      expect(await harness.charges()).toEqual(['ch_1']);
    });
  });
}

/**
 * The two cases that need the reservation to OUTLIVE the transaction it was made in. The embedded
 * server has one session, so a reservation there joins the transaction and a rollback takes it;
 * memory and a real Postgres pool both keep it — this half is the live suite's twin.
 */
describe('idempotency in a transaction — memory, where the reservation survives a rollback', () => {
  let harness: TxHarness;

  beforeAll(async () => {
    harness = await txHarness(client, memoryUnderTest());
  });

  beforeEach(async () => {
    await harness.reset();
  });

  test('a rolled-back record is in flight: refused inside the deadline, reclaimed after it', async () => {
    await harness.charge(KEY, 'ch_1', { after: late }).catch(() => undefined);
    expect(await harness.statusOf(KEY)).toBe('in-flight');

    const early = await harness.charge(KEY, 'ch_2').catch((error: unknown) => error);
    expect(codeOf(early)).toBe('X_IDEMPOTENCY_CONFLICT');

    await harness.age(KEY, RECLAIM_MS + 1_000);
    expect((await harness.store.reserve(KEY, 'hash')).created).toBe(true);
  });

  test('a takeover before the settle: the slow attempt is refused and its write is undone', async () => {
    const slow = await harness
      .charge(KEY, 'slow', {
        // Past the deadline with the record still in flight: a retry takes the key and settles.
        during: async () => {
          await harness.age(KEY, RECLAIM_MS + 1_000);
          const retry = await harness.store.reserve(KEY, 'hash');
          expect(retry.created).toBe(true);
        },
      })
      .catch((error: unknown) => error);

    expect(codeOf(slow)).toBe('X_IDEMPOTENCY_RESERVATION_LOST');
    expect(await harness.charges()).toEqual([]);
  });

  // A promise chain the transaction's body forgot to await still finds the scope's handle after
  // it closed. A settle "bound" to that finished transaction is bound to nothing: after a
  // ROLLBACK its commit hook never fires, and the record would sit in flight — reclaimable —
  // beside a handler that ran with every statement its own commit.
  for (const ending of ['commit', 'rollback'] as const) {
    test(`a straggler that outlives a ${ending} settles at once — its transaction is over`, async () => {
      const gate = Promise.withResolvers<void>();
      let straggler: Promise<unknown> = Promise.resolve();
      await withTransaction(
        () => {
          straggler = gate.promise.then(() =>
            harness.store.reserve(KEY, 'hash').then(async ({ record }) => {
              await harness.store.settle(KEY, { late: true }, record.id);
            }),
          );
          return ending === 'commit' ? Promise.resolve() : late();
        },
        { client },
      ).catch(() => undefined);

      gate.resolve();
      await straggler;
      expect(await harness.statusOf(KEY)).toBe('settled');
    });
  }

  test('a settle waiting on its commit is nobody’s to reclaim, however old the record is', async () => {
    await harness.charge(KEY, 'ch_1', {
      // After the gate returned — the settle ran — and before the commit.
      after: async () => {
        await harness.age(KEY, RECLAIM_MS + 1_000);
        expect((await harness.store.reserve(KEY, 'hash')).created).toBe(false);
      },
    });
    expect(await harness.statusOf(KEY)).toBe('settled');
  });
});
