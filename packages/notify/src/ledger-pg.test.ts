// The Postgres ledger over a recording executor: the claim's atomicity is Postgres's problem, but
// how this store READS the answer is this package's, and getting it backwards means every replay
// sends again.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/jobs';
import type { DeliveryClaim } from './ledger';
import {
  createPgDeliveryLedger,
  DEFAULT_DELIVERY_WINDOW_MS,
  SQL_NOTIFY_CLAIM,
  SQL_NOTIFY_DELIVERIES_PURGE,
  SQL_NOTIFY_DELIVERIES_TABLE,
  SQL_NOTIFY_SETTLE,
} from './ledger-pg';

const AT = new Date('2026-08-24T09:00:00Z');
const claim: DeliveryClaim = {
  notifier: 'post.liked',
  key: 'like:p1',
  recipient: 'ana',
  channel: 'email',
};

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const executorOf = (answers: readonly (readonly unknown[])[], calls: Call[]): PgExecutor => ({
  query: <R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> => {
    calls.push({ sql, params });
    return Promise.resolve((answers[calls.length - 1] ?? []) as readonly R[]);
  },
});

describe('unit · postgres delivery ledger', () => {
  test('a returned row means this caller owns the delivery; no row means it already went out', async () => {
    const calls: Call[] = [];
    const owned = createPgDeliveryLedger({ executor: executorOf([[{ attempts: 1 }]], calls) });
    expect(await owned.claim(claim, AT)).toBe(true);
    expect(calls[0]?.sql).toBe(SQL_NOTIFY_CLAIM);
    expect(calls[0]?.params).toEqual(['post.liked', 'like:p1', 'ana', 'email', AT]);

    const taken = createPgDeliveryLedger({ executor: executorOf([[]], []) });
    expect(await taken.claim(claim, AT)).toBe(false);
  });

  test('the claim statement refuses to re-claim a `sent` row, in the statement itself', () => {
    // The `where` on the `do update` is the whole guarantee: without it the upsert would bump
    // `attempts` on a completed delivery and hand the caller a row back.
    expect(SQL_NOTIFY_CLAIM).toContain("where x_notify_deliveries.status <> 'sent'");
    expect(SQL_NOTIFY_CLAIM).toContain(
      "on conflict (notifier, key, channel, coalesce(recipient, ''))",
    );
  });

  test("the unique index reads a null recipient as '' so a bulk claim has exactly one row", () => {
    // NULLs are distinct in a plain unique index on every Postgres before 15, which would let one
    // bulk send be claimed an unbounded number of times.
    expect(SQL_NOTIFY_DELIVERIES_TABLE).toContain(
      "on x_notify_deliveries (notifier, key, channel, coalesce(recipient, ''))",
    );
    expect(SQL_NOTIFY_DELIVERIES_TABLE).toContain('create table if not exists x_notify_deliveries');
  });

  test('settle names the status and the clock, positionally, on every path', async () => {
    const calls: Call[] = [];
    const ledger = createPgDeliveryLedger({ executor: executorOf([[]], calls) });
    await ledger.settle(claim, 'sent', AT);
    expect(calls[0]?.sql).toBe(SQL_NOTIFY_SETTLE);
    expect(calls[0]?.params).toEqual(['post.liked', 'like:p1', 'ana', 'email', 'sent', AT]);
    // Scoped by all four columns, so settling one channel never touches another's row.
    expect(SQL_NOTIFY_SETTLE).toContain("coalesce(recipient, '') = coalesce($3, '')");
  });

  test('a delivery nothing has ever claimed answers undefined rather than a row', async () => {
    const ledger = createPgDeliveryLedger({ executor: executorOf([[]], []) });
    expect(await ledger.find(claim)).toBeUndefined();
  });

  test('a status column this build does not know reads as `failed`, never as `sent`', async () => {
    const ledger = createPgDeliveryLedger({
      executor: executorOf(
        [[{ ...claim, status: 'queued-for-later', attempts: 3, at: AT.toISOString() }]],
        [],
      ),
    });
    const record = await ledger.find(claim);
    // Only `sent` suppresses a resend, so nothing unknown may be allowed to imply it.
    expect(record?.status).toBe('failed');
    expect(record?.at).toEqual(AT);
  });
});

describe('unit · delivery retention', () => {
  // The cutoff is `nowMs - windowMs`, computed from the JOB's clock. A cutoff computed inside
  // Postgres (`now() - interval`) measures the offset between two clocks instead of the age of the
  // row, because `at` is written by whichever process took the delivery.
  test('the cutoff is the caller clock minus the ledger own window', async () => {
    const calls: Call[] = [];
    const ledger = createPgDeliveryLedger({
      executor: executorOf([[]], calls),
      windowMs: 60_000,
    });
    await ledger.purgeExpired(AT.getTime());
    expect(SQL_NOTIFY_DELIVERIES_PURGE).toContain('at < $1');
    expect(calls[0]?.params).toEqual([new Date(AT.getTime() - 60_000)]);
  });

  test('the window defaults to 24h and is readable, so a caller can copy it', () => {
    const ledger = createPgDeliveryLedger({ executor: executorOf([[]], []) });
    expect(DEFAULT_DELIVERY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(ledger.windowMs).toBe(DEFAULT_DELIVERY_WINDOW_MS);
  });

  // The statement the store RUNS carries `returning`, and the exported constant deliberately does
  // not — a caller pasting it into psql wants the delete, and the count is this store's business.
  // Without it `rows.length` is zero on every sweep while the delete succeeds.
  test('the count is read off returned rows, not off an unreturning delete', async () => {
    const calls: Call[] = [];
    const ledger = createPgDeliveryLedger({ executor: executorOf([[{ key: 'a' }]], calls) });
    expect(await ledger.purgeExpired(AT.getTime())).toBe(1);
    expect(calls[0]?.sql).toContain('returning');
  });

  test('a window that is not a positive finite number is refused at construction', () => {
    for (const windowMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => createPgDeliveryLedger({ executor: executorOf([[]], []), windowMs })).toThrow();
    }
  });
});
