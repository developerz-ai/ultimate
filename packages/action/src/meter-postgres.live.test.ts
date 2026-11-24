// The shared meter store against Postgres 17, on several connections at once: N parallel draws at
// the edge admit exactly the remainder, a later period rolls the row over in place, a lagging
// replica cannot reset it, and one period's warning has one claimant. Skips unless
// `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { postgresMeterStore, SQL_METER_KEY_TABLE, SQL_METER_TABLE } from './meter-postgres';
import type { MeterStore } from './meter-store';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_action_meter_live');
const DAY = 86_400_000;
const START = Date.parse('2026-11-06T00:00:00.000Z');
const key = { subject: 'org:o1', meter: 'calls', period: 'day@UTC' } as const;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

describe.skipIf(!hasPostgres)('live · postgres · the meter store', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  let store: MeterStore;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 8 } });
    await client.execute(raw(SQL_METER_TABLE));
    await client.execute(raw(SQL_METER_KEY_TABLE));
    store = postgresMeterStore({ executor: dbExecutor(() => client) });
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  beforeEach(async () => {
    await client.execute(raw('truncate x_meter, x_meter_key'));
  });

  const draw = (limit: number, periodStartMs = START, subject: string = key.subject) =>
    store.draw({ ...key, subject, periodStartMs, limit });

  test('the table is idempotent to apply', async () => {
    await client.execute(raw(SQL_METER_TABLE));
    await client.execute(raw(SQL_METER_KEY_TABLE));
  });

  test('N parallel draws over 8 connections admit exactly the limit, on a fresh row too', async () => {
    const results = await Promise.all(Array.from({ length: 60 }, () => draw(9)));
    expect(results.filter((result) => result.allowed)).toHaveLength(9);
    expect(results.filter((result) => !result.allowed).every((r) => r.used === 9)).toBe(true);
  });

  test('a limit of 0 refuses and writes no row', async () => {
    expect((await draw(0)).allowed).toBe(false);
    const rows = await dbExecutor(() => client).query('select 1 from x_meter', []);
    expect(rows).toHaveLength(0);
  });

  test('a later period rolls over in place; an earlier one adds to the current', async () => {
    await draw(2, START + DAY);
    await draw(2, START + DAY);
    expect((await draw(2, START + DAY)).allowed).toBe(false);
    expect((await draw(2, START)).allowed).toBe(false);
    expect(await draw(2, START + 2 * DAY)).toEqual({ allowed: true, used: 1, warned: false });
    const rows = await dbExecutor(() => client).query('select used from x_meter', []);
    expect(rows).toHaveLength(1);
  });

  test("one period's warning has one claimant, is released, and resets with the period", async () => {
    await draw(5);
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => store.claimWarning(key, START)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await draw(5)).warned).toBe(true);
    await store.releaseWarning(key, START);
    expect(await store.claimWarning(key, START)).toBe(true);
    expect((await draw(5, START + DAY)).warned).toBe(false);
  });

  test('subjects are separate rows', async () => {
    await draw(1);
    expect((await draw(1, START, 'org:o2')).allowed).toBe(true);
    expect((await draw(1)).allowed).toBe(false);
  });

  const keyed = (limit: number, amount: number, drawKey: string, periodStartMs = START) =>
    store.draw({ ...key, periodStartMs, limit, amount, drawKey });

  /**
   * A store whose caller is held after its `n`th statement returns, until `release()`: the window
   * between two statements of one draw, opened on purpose so another draw lands inside it.
   */
  const heldAfter = (n: number) => {
    const base = dbExecutor(() => client);
    let seen = 0;
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reach = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const executor: PgExecutor = {
      async query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
        const rows = await base.query<R>(sql, params);
        seen += 1;
        if (seen === n) {
          reach();
          await released;
        }
        return rows;
      },
    };
    const held = postgresMeterStore({ executor });
    return {
      keyed: (limit: number, amount: number, drawKey: string, periodStartMs = START) =>
        held.draw({ ...key, periodStartMs, limit, amount, drawKey }),
      reached,
      release,
    };
  };

  test('N parallel draws under one key over 8 connections add it once, on a fresh row too', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => keyed(1000, 7, 'run-1')));
    expect(results.filter((result) => result.replayed !== true)).toHaveLength(1);
    const rows = await dbExecutor(() => client).query<{ used: string }>(
      'select used from x_meter',
      [],
    );
    expect(rows.map((row) => Number(row.used))).toEqual([7]);
  });

  test('N parallel keyed draws at the edge admit exactly what fits, each key once', async () => {
    const keys = Array.from({ length: 40 }, (_, i) => `run-${i % 20}`);
    const results = await Promise.all(keys.map((drawKey) => keyed(10, 2, drawKey)));
    const counted = results.filter((result) => result.allowed && result.replayed !== true);
    expect(counted).toHaveLength(5);
    expect(results.filter((result) => !result.allowed).every((r) => r.used === 10)).toBe(true);
    // Key by key: a counted key's twin replays it, and a key that never counted is refused twice.
    const byKey = new Map<string, string[]>();
    results.forEach((result, i) => {
      const outcome = !result.allowed ? 'refused' : result.replayed === true ? 'replay' : 'fresh';
      byKey.set(keys[i] ?? '', [...(byKey.get(keys[i] ?? '') ?? []), outcome]);
    });
    for (const outcomes of byKey.values()) {
      expect([
        ['fresh', 'replay'],
        ['refused', 'refused'],
      ]).toContainEqual(outcomes.sort());
    }
  });

  // A draw refused under a low limit races one under a higher limit with the same key: when the
  // refusal learns the key counted after all, it answers the count that key left, never the stale
  // count it was refused at.
  test('a refusal that finds its key counted by a racing draw answers the count after it', async () => {
    await keyed(10, 4, 'base');
    const low = heldAfter(1);
    const refusing = low.keyed(4, 2, 'k');
    // Refused at 4 by its first statement, and held before it looks the key up.
    await low.reached;
    expect(await keyed(10, 2, 'k')).toEqual({
      allowed: true,
      used: 6,
      warned: false,
      periodStartMs: START,
    });
    low.release();
    expect(await refusing).toEqual({
      allowed: true,
      used: 6,
      warned: false,
      replayed: true,
      periodStartMs: START,
    });
  });

  // Day two is full and owes the retry of day one's key a replay; day three, landing between the
  // refusal and its key lookup, purges that key and has room. Judged against day three, the retry
  // counts there — never refused by a lookup that no longer matches the counter it was refused on.
  test('a refusal whose counter moves before its key lookup is judged again', async () => {
    await keyed(2, 1, 'k', START);
    await keyed(2, 2, 'fill', START + DAY);
    const retry = heldAfter(1);
    const retrying = retry.keyed(2, 1, 'k', START + DAY);
    await retry.reached;
    expect((await keyed(2, 1, 'other', START + 2 * DAY)).used).toBe(1);
    retry.release();
    expect(await retrying).toEqual({
      allowed: true,
      used: 2,
      warned: false,
      periodStartMs: START + 2 * DAY,
    });
  });

  // The first draw on a counter opens it charged: a zero row opened first let a lagging day-one
  // draw spend day two's only unit before the day-two draw that opened it was charged.
  test('a first keyed draw opens its counter already charged', async () => {
    const opening = heldAfter(2);
    const first = opening.keyed(1, 1, 'day-two', START + DAY);
    await opening.reached;
    expect(await keyed(1, 1, 'day-one', START)).toEqual({
      allowed: false,
      used: 1,
      warned: false,
      periodStartMs: START + DAY,
    });
    opening.release();
    expect(await first).toEqual({
      allowed: true,
      used: 1,
      warned: false,
      periodStartMs: START + DAY,
    });
  });

  test("a lagging keyed draw and its refusal both answer the counter's period", async () => {
    await draw(5, START + DAY);
    expect(await keyed(5, 3, 'late', START)).toEqual({
      allowed: true,
      used: 4,
      warned: false,
      periodStartMs: START + DAY,
    });
    expect(await keyed(5, 3, 'over', START)).toEqual({
      allowed: false,
      used: 4,
      warned: false,
      periodStartMs: START + DAY,
    });
  });

  test("a counter keeps this period's keys and the last's, and no older ones", async () => {
    await keyed(100, 1, 'a', START);
    await keyed(100, 1, 'b', START + DAY);
    await keyed(100, 1, 'c', START + 2 * DAY);
    const rows = await dbExecutor(() => client).query<{ draw_key: string }>(
      'select draw_key from x_meter_key order by draw_key',
      [],
    );
    expect(rows.map((row) => row.draw_key)).toEqual(['b', 'c']);
  });
});
