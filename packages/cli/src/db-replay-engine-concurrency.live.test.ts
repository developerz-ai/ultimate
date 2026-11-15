// A prepared scratch database on a SHARED Postgres, under concurrency and crashes: a run waiting
// on another's build outlives the web statement timeout, a failed build leaves no build database
// behind (and the next build sweeps a killed one's), and a killed run's stamped working clone is
// reaped by the next run — never an unstamped database, a fresh one, or one of another name.

import { afterAll, describe, expect, test } from 'bun:test';
import type { DbClient } from '@ultimat3/db';
import { postgresClient, raw, sql } from '@ultimat3/db';
import { templateNameFor, withPreparedScratch } from './db-replay-engine-prepared';
import { SCRATCH_MARKER } from './db-replay-scratch-reap';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const run = crypto.randomUUID().replaceAll('-', '');
const keyOf = (head: string): string => `${head}${run}`;
const engine = { kind: 'postgres' as const, adminUrl: url ?? '', requires: [] };

const notes = async (client: DbClient): Promise<void> => {
  await client.execute(raw('create table notes (id int primary key)'));
};

describe.skipIf(!hasPostgres)('withPreparedScratch · concurrency and crashes', () => {
  const admin = postgresClient({ url: url ?? '', role: 'migrate' });
  const created: string[] = [];
  const names = async (pattern: string): Promise<readonly string[]> =>
    (
      await admin.query<{ datname: string }>(
        sql`select datname from pg_database where datname ~ ${pattern} order by 1`,
      )
    ).map((row) => row.datname);

  afterAll(async () => {
    const ours = await names(run.slice(0, 23));
    for (const name of [...ours, ...created]) {
      await admin.execute(raw(`drop database if exists "${name}" with (force)`));
    }
    await admin.close();
  });

  test('a run waiting on another’s build outlives the web statement timeout', async () => {
    const key = keyOf('1');
    using holder = await admin.reserve();
    await holder.execute(raw(`select pg_advisory_lock(hashtext('${templateNameFor(key)}'))`));
    const waiting = withPreparedScratch(engine, undefined, { key, prepare: notes }, async () => 1);
    await Bun.sleep(11_000);
    await holder.execute(raw(`select pg_advisory_unlock(hashtext('${templateNameFor(key)}'))`));
    expect(await waiting.then(String, (e: unknown) => (e as { code?: string }).code)).toBe('1');
  }, 60_000);

  test('a failed build drops its build database; a killed one’s is swept by the next build', async () => {
    const key = keyOf('2');
    const killed = `x_scratch_bld_${key.slice(0, 24)}_1`;
    await admin.execute(raw(`create database "${killed}"`));
    created.push(killed);
    const failing = {
      key,
      prepare: async (client: DbClient) => {
        await notes(client);
        await client.execute(raw('select no_such_function()'));
      },
    };
    const outcome = await withPreparedScratch(engine, undefined, failing, async () => 'ran').then(
      String,
      () => 'refused',
    );
    expect(outcome).toBe('refused');
    expect(await names(`^x_scratch_bld_${key.slice(0, 24)}_`)).toEqual([]);
    expect(await names(`^${templateNameFor(key)}$`)).toEqual([]);
  }, 60_000);

  test('a killed run’s stamped clone is reaped; unstamped, fresh and foreign ones are not', async () => {
    const tail = run.slice(0, 8);
    const stale = `x_scratch_1_${tail}`;
    const fresh = `x_scratch_2_${tail}`;
    const unstamped = `x_scratch_3_${tail}`;
    const foreign = `x_scratchy_4_${tail}`;
    for (const name of [stale, fresh, unstamped, foreign]) {
      await admin.execute(raw(`create database "${name}"`));
      created.push(name);
    }
    const old = `${SCRATCH_MARKER}2020-01-01T00:00:00Z`;
    await admin.execute(raw(`comment on database "${stale}" is '${old}'`));
    await admin.execute(raw(`comment on database "${foreign}" is '${old}'`));
    const now = (
      await admin.one<{ at: string }>(
        sql`select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at`,
      )
    )?.at;
    await admin.execute(raw(`comment on database "${fresh}" is '${SCRATCH_MARKER}${now ?? ''}'`));
    await withPreparedScratch(
      engine,
      undefined,
      { key: keyOf('3'), prepare: notes },
      async () => 1,
    );
    expect(await names(`_${tail}$`)).toEqual([fresh, unstamped, foreign].sort());
  }, 60_000);
});
