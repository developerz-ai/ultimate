// The settlement and the handler's transaction, against Postgres 17 — the one place the two are
// really on different connections. A settlement that commits WITH the write means an in-flight
// record never hides a committed handler, which is what makes one past the request deadline safe
// to reclaim. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PostgresClient } from '@ultimat3/db';
import { createPostgresClient, raw, sql, withTransaction } from '@ultimat3/db';
import { withIdempotency } from './idempotency';
import { postgresUnderTest, RECLAIM_MS, type TxHarness, txHarness } from './idempotency-tx-fixture';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = 'x_action_idempotency_live';
const KEY = '["chargeCard","user","u1",null,"k1"]';

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

/** The outer unit of work failing after the gate returned — the settle already ran. */
const late = (): Promise<void> => Promise.reject(new RangeError('the unit of work failed late'));

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

describe.skipIf(!hasPostgres)('live · postgres · idempotency settles in the handler tx', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  let harness: TxHarness;

  beforeAll(async () => {
    admin = createPostgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = createPostgresClient({ url: probeUrl(), role: 'web', profile: { max: 4 } });
    harness = await txHarness(client, await postgresUnderTest(client));
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  test('a transaction that commits settles with it, and the retry replays one write', async () => {
    await harness.charge(KEY, 'ch_1');
    expect(await harness.statusOf(KEY)).toBe('settled');

    const replay = await harness.charge(KEY, 'ch_2');
    expect(replay).toEqual({ value: { charged: 'ch_1' }, replayed: true });
    expect(await harness.charges()).toEqual(['ch_1']);
  });

  test('a transaction that rolls back AFTER the settle leaves no settled record behind', async () => {
    const failure = await harness
      .charge(KEY, 'ch_1', { after: late })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RangeError);
    expect(await harness.charges()).toEqual([]);
    // `settled` here was the defect: the retry replayed a success for a write that rolled back.
    expect(await harness.statusOf(KEY)).toBe('in-flight');
  });

  test('that record refuses a retry inside the deadline and is reclaimed after it', async () => {
    await harness.charge(KEY, 'ch_1', { after: late }).catch(() => undefined);

    const early = await harness.charge(KEY, 'ch_2').catch((error: unknown) => error);
    expect(codeOf(early)).toBe('X_IDEMPOTENCY_CONFLICT');

    await harness.age(KEY, RECLAIM_MS + 1_000);
    expect(await harness.charge(KEY, 'ch_2')).toEqual({
      value: { charged: 'ch_2' },
      replayed: false,
    });
    expect(await harness.charges()).toEqual(['ch_2']);
    expect(await harness.statusOf(KEY)).toBe('settled');
  });

  test('an AUTOCOMMIT handler that never settled is not reclaimable before the window', async () => {
    // No transaction: the handler may have committed before the process died, and nothing can
    // tell. The deadline frees only a record whose settlement was bound to a transaction.
    const first = await harness.store.reserve(KEY, 'hash');
    expect(first.created).toBe(true);
    await harness.age(KEY, RECLAIM_MS + 1_000);

    const second = await harness.store.reserve(KEY, 'hash');
    expect(second.created).toBe(false);
    expect(second.record.status).toBe('in-flight');
  });

  test('a takeover before the settle: the slow attempt is refused and its write is undone', async () => {
    const reached = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    // Started here and finished below: the retry must run OUTSIDE the slow attempt's async
    // context, or its `withTransaction` would be a savepoint in the very transaction it races.
    const slow = harness
      .charge(KEY, 'slow', {
        during: async () => {
          reached.resolve();
          await proceed.promise;
        },
      })
      .catch((error: unknown) => error);
    await reached.promise;

    // Past the deadline with the record still in flight: a retry reclaims the key and commits.
    await harness.age(KEY, RECLAIM_MS + 1_000);
    const takeover = await harness.charge(KEY, 'retry');
    proceed.resolve();

    expect(takeover).toEqual({ value: { charged: 'retry' }, replayed: false });
    expect(codeOf(await slow)).toBe('X_IDEMPOTENCY_RESERVATION_LOST');
    expect(await harness.charges()).toEqual(['retry']);
    expect(await harness.statusOf(KEY)).toBe('settled');
  });

  // #591: the row is what an operator, a backup and a read replica see for a day. The secret must
  // not be in it in any form, and the replay of an answer that lost one is refused.
  for (const bound of [false, true]) {
    test(`a secret answer rests redacted (${bound ? 'in a transaction' : 'autocommit'}) and refuses its replay`, async () => {
      const once = (value: unknown) =>
        withIdempotency(harness.store, KEY, { id: 'same-payload' }, () => Promise.resolve(value));
      const first = bound
        ? await withTransaction(() => once({ id: 'k1', apiKey: 'sk_live_plain' }), { client })
        : await once({ id: 'k1', apiKey: 'sk_live_plain' });
      expect(first).toEqual({ value: { id: 'k1', apiKey: 'sk_live_plain' }, replayed: false });

      const rows = await client.query<{ value: string; redacted: boolean }>(
        sql`select value::text as value, redacted from x_idempotency where key = ${KEY}`,
      );
      expect(rows[0]?.redacted).toBe(true);
      expect(JSON.parse(rows[0]?.value ?? 'null')).toEqual({ id: 'k1', apiKey: '[redacted]' });
      expect(rows[0]?.value).not.toContain('sk_live_plain');

      const replay = await once({ id: 'never-run' }).catch((error: unknown) => error);
      expect(codeOf(replay)).toBe('X_IDEMPOTENT_REPLAY_REDACTED');
    });
  }

  test('autocommit, unchanged: the settle is its own statement and a retry replays', async () => {
    await harness.chargeAutocommit(KEY, 'ch_1');
    expect(await harness.chargeAutocommit(KEY, 'ch_2')).toEqual({
      value: { charged: 'ch_1' },
      replayed: true,
    });
    expect(await harness.charges()).toEqual(['ch_1']);
  });
});
