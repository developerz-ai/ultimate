// The position comparison against real servers. The paused-replay proof needs a physical standby,
// `TEST_STANDBY_URL` (the test services' `postgres-standby`), and skips, named, without it. What a
// primary can prove runs on `TEST_DATABASE_URL`: a real `pg_lsn` parses, and a server not in
// recovery is "unknown".

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type DbClient, type PostgresClient, postgresClient } from './client';
import { replicatedClient } from './replica-client';
import { parsePosition, primaryPosition } from './replica-position';
import { withReplicaReads } from './replica-scope';
import { raw, sql } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const standbyUrl = Bun.env['TEST_STANDBY_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const hasStandby = hasPostgres && typeof standbyUrl === 'string' && standbyUrl.length > 0;
const PAUSE_LIMIT_MS = 5_000;

/**
 * `pg_wal_replay_pause()` only REQUESTS the pause: the startup process may replay the next record
 * after it returns. Polled to `paused`, so the write below is one the standby cannot have.
 */
async function pauseReplay(standby: DbClient): Promise<void> {
  await standby.execute(raw('select pg_wal_replay_pause()'));
  const started = performance.now();
  for (;;) {
    const row = await standby.one<{ state: string }>(
      sql`select pg_get_wal_replay_pause_state()::text as state`,
    );
    if (row?.state === 'paused') return;
    if (performance.now() - started > PAUSE_LIMIT_MS) {
      expect.unreachable(`replay did not pause within ${String(PAUSE_LIMIT_MS)} ms`);
    }
    // real-clock: the standby's startup process pauses on its own schedule
    await Bun.sleep(20);
  }
}

describe.skipIf(!hasPostgres)('live · postgres · replica position on a primary', () => {
  let primary: PostgresClient;
  let notInRecovery: PostgresClient;

  beforeAll(() => {
    primary = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    notInRecovery = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
  });

  afterAll(async () => {
    await primary.close();
    await notInRecovery.close();
  });

  test('pg_current_wal_insert_lsn parses, and a write moves it forward', async () => {
    const before = await primaryPosition(primary);
    await primary.execute(raw('create temp table x_position_probe (id int)'));
    await primary.execute(raw('insert into x_position_probe values (1)'));
    const after = await primaryPosition(primary);
    expect(typeof before).toBe('bigint');
    expect((after ?? 0n) >= (before ?? 0n)).toBe(true);
  });

  test('a "replica" not in recovery cannot say how far it replayed: the primary answers', async () => {
    const pair = replicatedClient(primary, notInRecovery);
    const required = await primaryPosition(primary);
    await withReplicaReads(() => pair.query(sql`select 1`), { minPosition: required });
    expect(pair.stats).toMatchObject({ replica: 0, primary: 1 });
  });
});

describe.skipIf(!hasStandby)('live · standby · a paused replay', () => {
  // Needs a physical standby the test may pause: `TEST_STANDBY_URL` (a superuser on it, for
  // `pg_wal_replay_pause()`) streaming from `TEST_DATABASE_URL`. Unset on the probe box.
  test('behind while paused, caught up once resumed', async () => {
    const primary = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    const standby = postgresClient({ url: standbyUrl ?? '', role: 'web', profile: { max: 1 } });
    try {
      await pauseReplay(standby);
      await primary.execute(raw('create table if not exists x_position_live (id int)'));
      await primary.execute(raw('insert into x_position_live values (1)'));
      const written = await primaryPosition(primary);
      const pair = replicatedClient(primary, standby, { positionCacheMs: 0 });
      await withReplicaReads(() => pair.query(sql`select 1`), { minPosition: written });
      expect(pair.stats.replica).toBe(0);
      await standby.execute(raw('select pg_wal_replay_resume()'));
      for (let tries = 0; tries < 50; tries += 1) {
        const replayed = await standby.one<{ lsn: string | null }>(
          sql`select pg_last_wal_replay_lsn()::text as lsn`,
        );
        if ((parsePosition(replayed?.lsn) ?? 0n) >= (written ?? 0n)) break;
        // real-clock: the standby replays WAL in its own process
        await Bun.sleep(20);
      }
      await withReplicaReads(() => pair.query(sql`select 1`), { minPosition: written });
      expect(pair.stats.replica).toBe(1);
    } finally {
      await standby.execute(raw('select pg_wal_replay_resume()')).catch(() => undefined);
      await primary.execute(raw('drop table if exists x_position_live'));
      await primary.close();
      await standby.close();
    }
  }, 15_000);
});
