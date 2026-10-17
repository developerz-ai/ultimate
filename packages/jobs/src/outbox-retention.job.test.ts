// The published-outbox sweep against a real Postgres — the embedded one, with this package's DDL.
// Rows are written straight into `x_outbox` with the `published_at` each case needs: the statement
// reads nothing else. Opt-in (`.job.`): booting Postgres costs seconds.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { embeddedPg } from './embedded-pg-fixture';
import { outboxPurgeTarget } from './outbox-retention';

const DAY_MS = 86_400_000;
/** The job's clock for every pass here — `published_at` is written from the relay's clock. */
const NOW_MS = Date.UTC(2026, 9, 17, 12);

afterAll(async () => {
  await (await embeddedPg()).close();
});

beforeEach(async () => {
  await (await embeddedPg()).reset();
});

let seq = 0;

/** One staged row; `publishedDaysAgo` null leaves it unpublished. Answers its id. */
async function outboxRow(publishedDaysAgo: number | null, stagedDaysAgo = 400): Promise<string> {
  const { executor } = await embeddedPg();
  seq += 1;
  const id = crypto.randomUUID();
  await executor.query(
    `insert into x_outbox (id, job, input, idempotency_key, staged_at, published_at)
     values ($1, 'mail.send', '{"to":"someone@example.test"}'::jsonb, $2,
             to_timestamp($3 / 1000.0),
             case when $4::bigint is null then null else to_timestamp($4 / 1000.0) end)`,
    [
      id,
      `o${seq}`,
      NOW_MS - stagedDaysAgo * DAY_MS,
      publishedDaysAgo === null ? null : NOW_MS - publishedDaysAgo * DAY_MS,
    ],
  );
  return id;
}

async function ids(): Promise<Set<string>> {
  const { executor } = await embeddedPg();
  const rows = await executor.query<{ id: string }>('select id from x_outbox', []);
  return new Set(rows.map((row) => row.id));
}

const target = async (extra: { batchSize?: number; maxBatches?: number } = {}) =>
  outboxPurgeTarget({
    executor: (await embeddedPg()).executor,
    publishedRetentionMs: 7 * DAY_MS,
    ...extra,
  });

describe('pg · the published-outbox sweep', () => {
  test('a row published past the window goes; a recent one stays', async () => {
    const old = await outboxRow(8);
    const young = await outboxRow(6);
    expect(await (await target()).purgeExpired(NOW_MS)).toBe(1);
    const left = await ids();
    expect(left.has(old)).toBe(false);
    expect(left.has(young)).toBe(true);
  });

  test('an unpublished row is never deleted, however long ago it was staged', async () => {
    const pending = await outboxRow(null, 400);
    expect(await (await target()).purgeExpired(NOW_MS)).toBe(0);
    expect((await ids()).has(pending)).toBe(true);
  });

  test('the cutoff is the job clock, not the server clock', async () => {
    // Published 8 days before NOW_MS: past the window by the job's clock. A pass whose clock reads
    // 2 days earlier sees it 6 days old and keeps it — a server-clock cutoff could not tell.
    await outboxRow(8);
    expect(await (await target()).purgeExpired(NOW_MS - 2 * DAY_MS)).toBe(0);
    expect(await (await target()).purgeExpired(NOW_MS)).toBe(1);
  });

  test('deletes in batches until the backlog is gone, and stops at the pass cap', async () => {
    for (let index = 0; index < 5; index += 1) await outboxRow(30);
    expect(await (await target({ batchSize: 2, maxBatches: 2 })).purgeExpired(NOW_MS)).toBe(4);
    expect(await (await target({ batchSize: 2 })).purgeExpired(NOW_MS)).toBe(1);
    expect((await ids()).size).toBe(0);
  });

  test('a window that is not a positive number is refused at construction', async () => {
    const { executor } = await embeddedPg();
    expect(() => outboxPurgeTarget({ executor, publishedRetentionMs: 0 })).toThrow(
      /publishedRetentionMs/,
    );
  });
});
