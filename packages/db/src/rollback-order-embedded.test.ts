// Which migration `rollback()` reverses, on the real embedded engine: the most recently APPLIED,
// never the highest id. A branch merged late applies an older id after a newer one; reversing by
// id then drops the previous release's table while the migration just shipped stays applied.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { LEDGER_TABLE, type Migration, migrate, rollback } from './migrate';
import { pgliteClient } from './pglite';
import { raw, sql } from './sql';

const PGLITE_BOOT_MS = 30_000;

const table = (id: string, name: string): Migration => ({
  id,
  name,
  up: `create table "${name}" ("id" int primary key)`,
  down: `drop table "${name}"`,
});

/** Released first, with the higher id. */
const released = table('20260102000000_released', 'order_released');
/** A branch written earlier, merged and applied after `released`. */
const lateMerge = table('20260101000000_late_merge', 'order_late_merge');

describe('rollback order on the real embedded database', () => {
  const client = pgliteClient();

  const exists = async (name: string): Promise<boolean> =>
    (
      await client.one<{ n: number }>(
        sql`select count(*)::int as n from pg_tables where tablename = ${name}`,
      )
    )?.n === 1;

  // The test clock is frozen and PGlite's `now()` reads it, so every row would share one instant:
  // each release's apply time is stamped the way a week between deploys would have written it.
  const stamp = async (id: string, appliedAt: string): Promise<void> => {
    await client.execute(
      sql`update ${raw(LEDGER_TABLE)} set applied_at = ${appliedAt}::timestamptz where id = ${id}`,
    );
  };

  beforeEach(async () => {
    await client.execute(raw(`drop table if exists ${LEDGER_TABLE}`));
    await client.execute(sql`drop table if exists order_released`);
    await client.execute(sql`drop table if exists order_late_merge`);
  }, PGLITE_BOOT_MS);

  afterAll(async () => {
    await client.close();
  });

  test(
    'rollback reverses the most recently applied migration, not the highest id, after an out-of-order apply',
    async () => {
      await migrate({ migrations: [released], appVersion: 'v1', client });
      await stamp(released.id, '2026-01-02T00:00:00Z');
      await migrate({ migrations: [lateMerge, released], appVersion: 'v2', client });
      await stamp(lateMerge.id, '2026-01-09T00:00:00Z');

      expect(await rollback({ migrations: [lateMerge, released], client })).toEqual([lateMerge.id]);
      expect(await exists('order_late_merge')).toBe(false);
      expect(await exists('order_released')).toBe(true);
    },
    PGLITE_BOOT_MS,
  );

  // One run applies in id order, and two of its rows can carry one `applied_at` (a coarse clock, a
  // ledger restored from a dump): the tiebreak must still read the run backwards.
  test(
    'rows sharing one applied_at reverse highest id first, as one run applied them',
    async () => {
      await migrate({ migrations: [lateMerge, released], appVersion: 'v1', client });
      await client.execute(raw(`update ${LEDGER_TABLE} set applied_at = '2026-01-03T00:00:00Z'`));

      expect(await rollback({ migrations: [lateMerge, released], client, steps: 2 })).toEqual([
        released.id,
        lateMerge.id,
      ]);
    },
    PGLITE_BOOT_MS,
  );
});
