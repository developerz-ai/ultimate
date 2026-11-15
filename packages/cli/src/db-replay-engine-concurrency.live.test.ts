// A prepared scratch database on a SHARED Postgres, under concurrency and crashes: a run waiting
// on another's build never sits inside one statement (so no statement timeout can cancel it), a
// failed build leaves no build database behind (and the next build sweeps a killed one's), and a
// killed run's stamped working clone is reaped by the next run — never an unstamped database, a
// fresh one, or one of another name. Every database created here is named per run.

import { afterAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName, subscribe } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { postgresClient, raw, sql } from '@ultimat3/db';
import { templateNameFor, withPreparedScratch } from './db-replay-engine-prepared';
import { SCRATCH_MARKER } from './db-replay-scratch-reap';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const engine = { kind: 'postgres' as const, adminUrl: url ?? '', requires: [] };

/** A per-run key: the hex of a probe name, so a template of this run is no other run's. */
const hexOf = (probe: string): string => new Bun.CryptoHasher('sha256').update(probe).digest('hex');

const notes = async (client: DbClient): Promise<void> => {
  await client.execute(raw('create table notes (id int primary key)'));
};

/** Resolves once `count` lock polls have been sent — the waiter's own statements, on the bus. */
const polls = (template: string, count: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  let seen = 0;
  const off = subscribe('db.statement', (event) => {
    if (!event.payload.text.includes('pg_try_advisory_lock')) return;
    if (!event.payload.values.includes(template)) return;
    seen += 1;
    if (seen < count) return;
    off();
    resolve();
  });
  return promise;
};

describe.skipIf(!hasPostgres)('withPreparedScratch · concurrency and crashes', () => {
  const admin = postgresClient({ url: url ?? '', role: 'migrate' });
  const created: string[] = [];
  const keys: string[] = [];
  const present = async (candidates: readonly string[]): Promise<readonly string[]> =>
    (
      await admin.query<{ datname: string }>(
        sql`select datname from pg_database where datname = any(${[...candidates]}) order by 1`,
      )
    ).map((row) => row.datname);

  afterAll(async () => {
    const ours = [...created, ...keys.map(templateNameFor)];
    for (const name of ours) {
      await admin.execute(raw(`drop database if exists "${name}" with (force)`));
    }
    await admin.close();
  });

  // The old wait was ONE `pg_advisory_lock` statement, cancelled by the pool's 10 s statement
  // timeout. Polled, each statement answers at once: two polls while held prove the wait is ours.
  test('a run waiting on another’s build polls the lock — no statement a timeout could cancel', async () => {
    const key = hexOf(probeDatabaseName('wait'));
    keys.push(key);
    const template = templateNameFor(key);
    // Its own client: the `migrate` pool holds one connection, and the checks below need it.
    const other = postgresClient({ url: url ?? '' });
    using holder = await other.reserve();
    await holder.execute(sql`select pg_advisory_lock(hashtext(${template}))`);
    const polled = polls(template, 2);
    const waiting = withPreparedScratch(engine, undefined, { key, prepare: notes }, async () => 1);
    await polled;
    const blocked = await admin.query<{ pid: number }>(
      sql`select pid from pg_stat_activity where wait_event_type = 'Lock' and query like '%advisory_lock%'`,
    );
    expect(blocked).toEqual([]);
    await holder.execute(sql`select pg_advisory_unlock(hashtext(${template}))`);
    holder.release();
    await other.close();
    expect(await waiting.then(String, (e: unknown) => (e as { code?: string }).code)).toBe('1');
  }, 30_000);

  test('a failed build drops its build database; a killed one’s is swept by the next build', async () => {
    const killed = `x_scratch_bld_${hexOf(probeDatabaseName('bld')).slice(0, 24)}_1`;
    const key = killed.slice('x_scratch_bld_'.length, -'_1'.length);
    keys.push(key);
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
    const builds = await admin.query<{ datname: string }>(
      sql`select datname from pg_database where starts_with(datname, ${`x_scratch_bld_${key}_`})`,
    );
    expect(builds).toEqual([]);
    expect(await present([templateNameFor(key)])).toEqual([]);
  }, 60_000);

  test('a killed run’s stamped clone is reaped; unstamped, fresh and foreign ones are not', async () => {
    const stale = `x_scratch_1_${hexOf(probeDatabaseName('stale')).slice(0, 8)}`;
    const fresh = `x_scratch_2_${hexOf(probeDatabaseName('fresh')).slice(0, 8)}`;
    const unstamped = `x_scratch_3_${hexOf(probeDatabaseName('unstamped')).slice(0, 8)}`;
    const foreign = probeDatabaseName('x_scratchy');
    await admin.execute(raw(`create database "${stale}"`));
    await admin.execute(raw(`create database "${fresh}"`));
    await admin.execute(raw(`create database "${unstamped}"`));
    await admin.execute(raw(`create database "${foreign}"`));
    created.push(stale, fresh, unstamped, foreign);
    const old = `${SCRATCH_MARKER}2020-01-01T00:00:00Z`;
    await admin.execute(raw(`comment on database "${stale}" is '${old}'`));
    await admin.execute(raw(`comment on database "${foreign}" is '${old}'`));
    const now = (
      await admin.one<{ at: string }>(
        sql`select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at`,
      )
    )?.at;
    await admin.execute(raw(`comment on database "${fresh}" is '${SCRATCH_MARKER}${now ?? ''}'`));
    const key = hexOf(probeDatabaseName('reap'));
    keys.push(key);
    await withPreparedScratch(engine, undefined, { key, prepare: notes }, async () => 1);
    expect(await present([stale, fresh, unstamped, foreign])).toEqual(
      [fresh, unstamped, foreign].sort(),
    );
  }, 60_000);
});
