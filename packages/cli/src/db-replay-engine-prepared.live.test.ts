// The server half of a prepared scratch database, against a real Postgres: the first run builds a
// template for its key, the next clones it unprepared, a new key builds its own, and no scratch
// database outlives its run.

import { afterAll, describe, expect, test } from 'bun:test';
import type { DbClient } from '@ultimat3/db';
import { postgresClient, raw, sql } from '@ultimat3/db';
import { templateNameFor, withPreparedScratch } from './db-replay-engine-prepared';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

/** Keys of this run alone: a server outlives runs, and an old run's template is not this one's. */
const run = crypto.randomUUID().replaceAll('-', '');
const keyA = `a${run}`;
const keyB = `b${run}`;
const evictors = ['c', 'd', 'e'].map((head) => `${head}${run}`);
/** Matches `x_scratch_tpl_%` under LIKE (`_` is any character) and is no template of ours. */
const decoy = `xAscratchBtplC${run.slice(0, 24)}`;
/** A template another process is cloning right now: it holds the template's advisory lock. */
const cloning = templateNameFor(`f${run}`);

describe.skipIf(!hasPostgres)('withPreparedScratch · a real Postgres', () => {
  const admin = postgresClient({ url: url ?? '' });

  afterAll(async () => {
    const names = [...[keyA, keyB, ...evictors].map(templateNameFor), decoy, cloning];
    for (const name of names) {
      await admin.execute(raw(`drop database if exists "${name}" with (force)`));
    }
    await admin.close();
  });

  const once = async (key: string) => {
    let prepared = 0;
    const tables = await withPreparedScratch(
      { kind: 'postgres', adminUrl: url ?? '', requires: [] },
      undefined,
      {
        key,
        prepare: async (client: DbClient) => {
          prepared += 1;
          await client.execute(raw('create table notes (id int primary key)'));
        },
      },
      async (client) =>
        (
          await client.query<{ name: string }>(
            raw("select tablename as name from pg_tables where schemaname = 'public'"),
          )
        ).map((row) => row.name),
    );
    return { prepared, tables };
  };

  test('a miss builds the template; the same key clones it unprepared', async () => {
    expect(await once(keyA)).toEqual({ prepared: 1, tables: ['notes'] });
    expect(await once(keyA)).toEqual({ prepared: 0, tables: ['notes'] });
    const template = await admin.one(
      sql`select 1 as hit from pg_database where datname = ${templateNameFor(keyA)}`,
    );
    expect(template).not.toBeNull();
  }, 60_000);

  test('a new key builds its own; no scratch database is left behind', async () => {
    expect((await once(keyB)).prepared).toBe(1);
    const left = await admin.query<{ datname: string }>(
      sql`select datname from pg_database where datname like ${`x_scratch_${String(process.pid)}_%`}`,
    );
    expect(left).toEqual([]);
  }, 60_000);

  test('eviction drops only its own templates, and never one another process holds', async () => {
    // Older than every template below, so each is past the newest kept when eviction runs.
    await admin.execute(raw(`create database "${decoy}"`));
    await admin.execute(raw(`create database "${cloning}"`));
    using holder = await admin.reserve();
    await holder.execute(raw(`select pg_advisory_lock(hashtext('${cloning}'))`));
    try {
      for (const key of evictors) expect((await once(key)).prepared).toBe(1);
    } finally {
      await holder.execute(raw(`select pg_advisory_unlock(hashtext('${cloning}'))`));
    }
    const left = await admin.query<{ datname: string }>(
      sql`select datname from pg_database where datname in (${decoy}, ${cloning}) order by 1`,
    );
    expect(left.map((row) => row.datname).sort()).toEqual([cloning, decoy].sort());
  }, 120_000);
});
