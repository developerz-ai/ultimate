// The scratch database's drop with a logical slot still ACTIVE on it, against the
// `wal_level=logical` server: postgres refuses `DROP DATABASE … WITH (FORCE)` while a slot is held
// ("used by an active logical replication slot"), so the drill's teardown failed on a loaded
// runner. The holder here is a backend blocked creating a slot behind an open writing transaction.
// Skips unless `TEST_REPLICATION_URL` (no typed `needs` names the logical server).

import { describe, expect, test } from 'bun:test';
import { scratchDatabase } from './drill-scratch-db';

const replicationUrl = Bun.env['TEST_REPLICATION_URL'] ?? '';

describe.skipIf(replicationUrl === '')('live · the drill scratch database drop', () => {
  test('an active logical slot on it is waited out or terminated, and the drop leaves nothing', async () => {
    const database = await scratchDatabase(replicationUrl);
    const writer = new Bun.SQL(database.url);
    const creator = new Bun.SQL(database.url);
    const admin = new Bun.SQL(replicationUrl);
    const writing = await writer.reserve();
    let creating: Promise<unknown> = Promise.resolve();
    try {
      await writing.unsafe('begin');
      await writing.unsafe('create table t (id int)');
      await writing.unsafe('insert into t values (1)');
      // Blocks waiting for the writing transaction to end, with the slot already ACTIVE.
      creating = creator
        .unsafe("select pg_create_logical_replication_slot('probe_slot', 'pgoutput')")
        .catch((error: unknown) => error);
      let active = 0;
      for (let poll = 0; poll < 100 && active === 0; poll += 1) {
        const [row] = await admin.unsafe(
          'select count(*)::int as n, pg_sleep(0.05) from pg_replication_slots ' +
            'where database = $1 and active_pid is not null',
          [database.name],
        );
        active = Number(row?.n ?? 0);
      }
      expect(active).toBe(1);

      await database.drop();

      const databases = await admin.unsafe('select 1 from pg_database where datname = $1', [
        database.name,
      ]);
      const slots = await admin.unsafe('select 1 from pg_replication_slots where database = $1', [
        database.name,
      ]);
      expect([databases.length, slots.length]).toEqual([0, 0]);
    } finally {
      // After a drop the writer's session is gone, so its rollback has nothing to answer.
      await writing.unsafe('rollback').catch(() => undefined);
      await creating;
      writing.release();
      await Promise.all([writer.close(), creator.close()]);
      // What a refused drop left behind: the slot, now created and inactive, then the database.
      await admin.unsafe(
        'select pg_drop_replication_slot(slot_name) from pg_replication_slots where database = $1',
        [database.name],
      );
      await admin.unsafe(`drop database if exists ${database.name} with (force)`);
      await admin.close();
    }
  }, 30_000);
});
