// The shared store's statements against a real Postgres in the unit step (the embedded server): the
// port's own answers, and the settle that commits with the handler's write. The store CONTRACT is
// `@ultimat3/testing`'s `idempotencyStoreConformance`; the reservation-on-the-pool half needs a
// second connection, which only its live run has.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgliteClient } from '@ultimat3/db';
import { pgliteClient } from '@ultimat3/db';
import { withIdempotency } from './idempotency';
import { postgresUnderTest, RECLAIM_MS, type TxHarness, txHarness } from './idempotency-tx-fixture';

const KEY = '["chargeCard","user","u1",null,"k1"]';
const DAY_MS = 24 * 60 * 60 * 1000;
// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 60_000;
const late = (): Promise<void> => Promise.reject(new RangeError('the unit of work failed late'));
const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

let client: PgliteClient;
let harness: TxHarness;

beforeAll(async () => {
  client = pgliteClient();
  harness = await txHarness(client, await postgresUnderTest(client));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await harness.reset();
});

describe('the postgres idempotency store on the embedded server — the port', () => {
  test('concurrent reserves of one key create exactly one record', async () => {
    const all = await Promise.all(Array.from({ length: 8 }, () => harness.store.reserve(KEY, 'h')));
    expect(all.filter((each) => each.created)).toHaveLength(1);
    expect(new Set(all.map((each) => each.record.id)).size).toBe(1);
  });

  test('settle keeps the value and the redaction flag; fail keeps the failure', async () => {
    const { record } = await harness.store.reserve(KEY, 'h');
    await harness.store.settle(KEY, { apiKey: '[redacted]' }, record.id, true);
    expect(await harness.store.get(KEY)).toMatchObject({
      status: 'settled',
      value: { apiKey: '[redacted]' },
      redacted: true,
    });
    const other = '["chargeCard","user","u1",null,"k2"]';
    const second = await harness.store.reserve(other, 'h');
    const failure = { code: 'X_FORBIDDEN', cause: 'declined', fix: 'use another card' };
    await harness.store.fail?.(other, failure, second.record.id);
    expect(await harness.store.get(other)).toMatchObject({ status: 'failed', failure });
  });

  test('settle, fail and release are fenced on the reservation id', async () => {
    const { record } = await harness.store.reserve(KEY, 'h');
    const stranger = '00000000-0000-7000-8000-000000000000';
    await harness.store.settle(KEY, { stolen: true }, stranger, false);
    await harness.store.fail?.(KEY, { code: 'X_INTERNAL', cause: 'c', fix: 'f' }, stranger);
    await harness.store.release(KEY, stranger);
    expect(await harness.store.get(KEY)).toMatchObject({ id: record.id, status: 'in-flight' });
    await harness.store.release(KEY, record.id);
    expect(await harness.store.get(KEY)).toBeUndefined();
  });

  test('past the window a record is missing and the key is reclaimed unredacted', async () => {
    const first = await harness.store.reserve(KEY, 'h');
    await harness.store.settle(KEY, { apiKey: '[redacted]' }, first.record.id, true);
    await harness.age(KEY, DAY_MS + 1_000);
    expect(await harness.store.get(KEY)).toBeUndefined();
    const reclaimed = await harness.store.reserve(KEY, 'h');
    expect(reclaimed.created).toBe(true);
    expect(reclaimed.record.redacted).not.toBe(true);
  });

  test('an autocommit reservation that never settled is not reclaimed by the deadline', async () => {
    expect((await harness.store.reserve(KEY, 'h')).created).toBe(true);
    await harness.age(KEY, RECLAIM_MS + 1_000);
    expect((await harness.store.reserve(KEY, 'h')).created).toBe(false);
  });
});

describe('the postgres idempotency store on the embedded server — the transaction', () => {
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
    const failure = await harness.charge(KEY, 'ch_1', { after: late }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RangeError);
    expect(await harness.charges()).toEqual([]);
    expect(await harness.statusOf(KEY)).not.toBe('settled');
  });

  test('a secret answer rests redacted and its replay is refused', async () => {
    const once = (value: unknown) =>
      withIdempotency(harness.store, KEY, { id: 'same-payload' }, () => Promise.resolve(value));
    await once({ id: 'key_1', apiKey: 'sk_live_plaintext' });
    expect(JSON.stringify(await harness.store.get(KEY))).not.toContain('sk_live_plaintext');
    expect(codeOf(await once(null).catch((e: unknown) => e))).toBe('X_IDEMPOTENT_REPLAY_REDACTED');
  });

  test('an unserialisable answer is refused first and on replay, and settles failed', async () => {
    const once = () =>
      withIdempotency(harness.store, KEY, { id: 'same-payload' }, () =>
        Promise.resolve({ note: 'a\u0000b' }),
      ).catch((e: unknown) => e);
    expect(codeOf(await once())).toBe('X_IDEMPOTENCY_OUTPUT_UNSERIALIZABLE');
    expect(await harness.statusOf(KEY)).toBe('failed');
    expect(codeOf(await once())).toBe('X_IDEMPOTENCY_OUTPUT_UNSERIALIZABLE');
  });
});
