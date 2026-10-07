// One set of cases, two stores: the process default (memory) and the shared one (Postgres, here
// the embedded server). Dev runs the first and production the second, so a case that settles in
// one and stays in flight in the other is a bug that only ships. The live suite runs the same
// harness against Postgres 17, where the reservation really is on a second connection.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgliteClient } from '@ultimat3/db';
import { pgliteClient, withTransaction } from '@ultimat3/db';
import { withIdempotency } from './idempotency';
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
 * An answer at rest for a day must not hold a credential: a mutator is forced idempotent, so a
 * "create an API key" mutator would otherwise keep the plaintext key in `x_idempotency.value`.
 * Redacted by core's `isRedactedKey` on settle, and a replay that would hand back `[redacted]`
 * in place of the key is refused instead. Both stores, the same verdicts.
 */
for (const [name, build] of STORES) {
  describe(`idempotency redacts secrets at rest — ${name}`, () => {
    let under: Awaited<ReturnType<(typeof STORES)[number][1]>>;
    const once = (value: unknown) =>
      withIdempotency(under.store, KEY, { id: 'same-payload' }, () => Promise.resolve(value));

    beforeAll(async () => {
      under = await build();
    });

    beforeEach(async () => {
      await under.reset();
    });

    test('the first caller gets the key, the stored record holds [redacted], a replay throws', async () => {
      const first = await once({ id: 'key_1', apiKey: 'sk_live_plaintext' });
      expect(first).toEqual({
        value: { id: 'key_1', apiKey: 'sk_live_plaintext' },
        replayed: false,
      });

      const stored = await under.store.get(KEY);
      expect(stored?.value).toEqual({ id: 'key_1', apiKey: '[redacted]' });
      expect(stored?.redacted).toBe(true);
      expect(JSON.stringify(stored)).not.toContain('sk_live_plaintext');

      const replay = await once({ id: 'never-run' }).catch((error: unknown) => error);
      expect(codeOf(replay)).toBe('X_IDEMPOTENT_REPLAY_REDACTED');
    });

    test('a secret nested in objects and arrays is redacted where it sits', async () => {
      await once({ user: { id: 'u1', logins: [{ label: 'main', password: 'hunter2' }] } });
      const stored = await under.store.get(KEY);
      expect(stored?.value).toEqual({
        user: { id: 'u1', logins: [{ label: 'main', password: '[redacted]' }] },
      });
      expect(stored?.redacted).toBe(true);
      expect(codeOf(await once(null).catch((error: unknown) => error))).toBe(
        'X_IDEMPOTENT_REPLAY_REDACTED',
      );
    });

    test('an object whose toJSON yields a secret is redacted before the store sees it', async () => {
      const leaky = { toJSON: () => ({ apiKey: 'sk_live_tojson' }) };
      await once({ id: 'k1', creds: leaky });
      const stored = await under.store.get(KEY);
      expect(JSON.stringify(stored)).not.toContain('sk_live_tojson');
      expect(stored?.redacted).toBe(true);
      expect(codeOf(await once(null).catch((error: unknown) => error))).toBe(
        'X_IDEMPOTENT_REPLAY_REDACTED',
      );
    });

    test('a cyclic answer settles on both stores and its replay is refused', async () => {
      const answer: Record<string, unknown> = { id: 'k1' };
      answer['self'] = answer;
      expect(await once(answer)).toEqual({ value: answer, replayed: false });
      const stored = await under.store.get(KEY);
      expect(stored?.status).toBe('settled');
      expect(stored?.value).toEqual({ id: 'k1', self: '[redacted]' });
      expect(codeOf(await once(null).catch((error: unknown) => error))).toBe(
        'X_IDEMPOTENT_REPLAY_REDACTED',
      );
    });

    test('an answer with no secret key replays exactly as before', async () => {
      const answer = { charged: 'ch_1', amount: { minor: 1250, currency: 'EUR' }, tags: ['a'] };
      await once(answer);
      expect((await under.store.get(KEY))?.redacted).not.toBe(true);
      expect(await once({ charged: 'never-run' })).toEqual({ value: answer, replayed: true });
    });

    test('inside a transaction the settle that commits with the write is redacted too', async () => {
      await withTransaction(() => once({ token: 'tok_plaintext' }), { client });
      const stored = await under.store.get(KEY);
      expect(stored?.value).toEqual({ token: '[redacted]' });
      expect(stored?.redacted).toBe(true);
    });

    test('a store reclaiming the key forgets the redaction with the answer', async () => {
      await once({ apiKey: 'sk_1' });
      await under.age(KEY, 25 * 60 * 60 * 1000);
      // The reclaimed reservation itself, before anything settles it: a fresh record, no flag.
      const reclaimed = await under.store.reserve(KEY, 'hash');
      expect(reclaimed.created).toBe(true);
      expect(reclaimed.record.redacted).not.toBe(true);
      await under.store.settle(KEY, { charged: 'ch_2' }, reclaimed.record.id, false);
      expect((await under.store.get(KEY))?.redacted).not.toBe(true);
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
              await harness.store.settle(KEY, { late: true }, record.id, false);
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
