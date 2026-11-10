// The notify-stores suite over the Postgres stores and a real server, plus what only a database
// can be asked: a digest window outlives the store that opened it, concurrent first appends open
// ONE window, and two executions of one appender at once land its event once.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import {
  memoryPreferenceStore,
  postgresDeliveryLedger,
  postgresDigestStore,
  postgresInboxStore,
  SQL_NOTIFY_DELIVERIES_TABLE,
  SQL_NOTIFY_DIGESTS_TABLE,
  SQL_NOTIFY_INBOX_TABLE,
} from '@ultimat3/notify';
import type { DigestSlot, DigestStore } from '@ultimat3/notify/adapter';
import { CONFORMANCE_ADMIN_URL, conformanceDatabase } from './notify-conformance-pg-fixture';
import { notifyStoresConformance } from './notify-stores-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe.skipIf(CONFORMANCE_ADMIN_URL === '')(
  testName('live', 'the postgres notify stores'),
  () => {
    const pg = conformanceDatabase('ultimate_notify_conformance', [
      SQL_NOTIFY_DELIVERIES_TABLE,
      SQL_NOTIFY_INBOX_TABLE,
      SQL_NOTIFY_DIGESTS_TABLE,
    ]);

    behavesLike(notifyStoresConformance, () => ({
      ledger: postgresDeliveryLedger({ executor: pg.executor, reclaimAfterMs: 60_000 }),
      inbox: postgresInboxStore({ executor: pg.executor }),
      // Preferences have no Postgres store: the table is the app's (axiom 8).
      preferences: memoryPreferenceStore(),
      digest: postgresDigestStore({ executor: pg.executor }),
    }));

    describe('what a heap cannot do', () => {
      let minted = 0;
      const slotOf = (): DigestSlot => {
        minted += 1;
        const recipient = `durable-${process.pid.toString(36)}-${minted.toString(36)}`;
        return { recipient, notifier: 'post.commented', channel: 'email', group: 'g' };
      };
      const append = (store: DigestStore, slot: DigestSlot, key: string, now: number) =>
        store.append({
          slot,
          event: { notifier: 'post.commented', key, params: { key }, at: new Date(now) },
          windowMs: 100,
          now: new Date(now),
          appender: `run-${key}`,
        });
      const fresh = (executor: PgExecutor = pg.executor) => postgresDigestStore({ executor });
      const keys = async (slot: DigestSlot): Promise<readonly string[]> =>
        (await fresh().drain(slot, 100)).map((one) => one.key);

      test('a window outlives the store that opened it', async () => {
        const slot = slotOf();
        await append(fresh(), slot, 'e1', 0);
        expect(await append(fresh(), slot, 'e2', 10)).toEqual({ opened: false, endsAt: 100 });
        expect(await keys(slot)).toEqual(['e1', 'e2']);
      });

      test('concurrent first appends open ONE window, so exactly one run owns the flush', async () => {
        const slot = slotOf();
        const buckets = await Promise.all(
          ['a', 'b', 'c', 'd'].map((key) => append(fresh(), slot, key, 0)),
        );
        expect(buckets.filter((bucket) => bucket.opened)).toHaveLength(1);
        expect([...(await keys(slot))].sort()).toEqual(['a', 'b', 'c', 'd']);
      });

      test('two executions of ONE appender at once (a lapsed lease) land its event once', async () => {
        const slot = slotOf();
        const sql = new Bun.SQL(pg.url(), { max: 2, prepare: false });
        const held = await sql.reserve();
        // `Bun.SQL` over `unsafe` binds a `Date` by `toString()`, which Postgres cannot parse.
        const bound = (value: unknown): unknown =>
          value instanceof Date ? value.toISOString() : value;
        try {
          // The first execution's insert is held uncommitted, so the second one's statement takes
          // its snapshot — in which `prior` finds nothing — before the first row is visible to it.
          await held.unsafe('begin', []);
          const inTx: PgExecutor = {
            query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
              [...(await held.unsafe(text, values.map(bound)))] as R[],
          };
          expect(await append(fresh(inTx), slot, 'e1', 0)).toEqual({ opened: true, endsAt: 100 });
          const racing = append(fresh(), slot, 'e1', 0);
          await waitForLockWait(sql, new URL(pg.url()).pathname.slice(1));
          await held.unsafe('commit', []);
          expect(await racing).toEqual({ opened: true, endsAt: 100 });
        } finally {
          held.release();
          await sql.end();
        }
        expect(await keys(slot)).toEqual(['e1']);
      });
    });
  },
);

/**
 * Until a backend in this database is blocked on a lock — the racing statement, waiting. Polled by
 * round trip, never by a timer: each `select` is itself the wait, and the bound is a count.
 */
async function waitForLockWait(sql: InstanceType<typeof Bun.SQL>, database: string): Promise<void> {
  for (let poll = 0; poll < 2000; poll += 1) {
    const [row] = await sql.unsafe(
      `select count(*)::int as waiting from pg_stat_activity
       where datname = $1 and wait_event_type = 'Lock'`,
      [database],
    );
    if ((row as { waiting: number } | undefined)?.waiting) return;
  }
  expect.unreachable('the racing append never blocked on the held insert');
}
