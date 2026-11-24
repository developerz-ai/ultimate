// The shared meter store against Postgres 17, on several connections at once: N parallel draws at
// the edge admit exactly the remainder, a later period rolls the row over in place, a lagging
// replica cannot reset it, and one period's warning has one claimant. Skips unless
// `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw, withTransaction } from '@ultimat3/db';
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

  /**
   * The counter row held by another transaction, so draws queue on its lock in the order they
   * start: each one's snapshot is taken before the ones ahead of it commit. `queued(n)` waits until
   * `n` statements are blocked on it; `release()` commits the holder.
   */
  const holdCounter = async () => {
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lock = (): void => undefined;
    const locked = new Promise<void>((resolve) => {
      lock = resolve;
    });
    const held = withTransaction(
      async (tx) => {
        await tx.execute(raw(`select 1 from x_meter where subject = '${key.subject}' for update`));
        lock();
        await released;
      },
      { client },
    );
    await locked;
    return {
      async queued(n: number): Promise<void> {
        for (;;) {
          const rows = await dbExecutor(() => admin).query<{ n: number }>(
            "select count(*)::int as n from pg_stat_activity where datname = $1 and wait_event_type = 'Lock'",
            [PROBE_DB],
          );
          if ((rows[0]?.n ?? 0) >= n) return;
          // real-clock: polls Postgres for other backends to block on the lock; no timer of ours to move
          await Bun.sleep(5);
        }
      },
      async release(): Promise<void> {
        release();
        await held;
      },
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
    const holder = await holdCounter();
    const counting = keyed(10, 2, 'k');
    await holder.queued(1);
    // Queued behind it: this statement's snapshot predates that draw's commit, and its own limit
    // of 4 refuses the count it then finds — only the key's index can tell it the key counted.
    const refusing = keyed(4, 2, 'k');
    await holder.queued(2);
    await holder.release();
    expect(await counting).toEqual({ allowed: true, used: 6, warned: false, periodStartMs: START });
    expect(await refusing).toEqual({
      allowed: true,
      used: 6,
      warned: false,
      replayed: true,
      periodStartMs: START,
    });
    // The refusal's probe left no placeholder behind.
    const keys = await dbExecutor(() => client).query<{ draw_key: string }>(
      'select draw_key from x_meter_key order by draw_key',
      [],
    );
    expect(keys.map((row) => row.draw_key)).toEqual(['base', 'k']);
  });

  // Day two is full and owes the retry of day one's key a replay; a day-three draw ahead of it in
  // the lock queue purges that key and leaves room. Judged against day three, the retry counts
  // there — one statement, one lock, never a refusal decided on a counter that has since moved.
  test('a refusal judged behind a draw that moved the counter is judged on the moved counter', async () => {
    await keyed(2, 1, 'k', START);
    await keyed(2, 2, 'fill', START + DAY);
    const holder = await holdCounter();
    const dayThree = keyed(2, 1, 'other', START + 2 * DAY);
    await holder.queued(1);
    const retrying = keyed(2, 1, 'k', START + DAY);
    await holder.queued(2);
    await holder.release();
    expect((await dayThree).used).toBe(1);
    expect(await retrying).toEqual({
      allowed: true,
      used: 2,
      warned: false,
      periodStartMs: START + 2 * DAY,
    });
  });

  // A refusal that looked its key up in a second statement restarted whenever another draw charged
  // the counter in between, so steady traffic on one tenant could keep a large draw from ever
  // answering. Here a charge lands after every statement the refused draw sends.
  test('a refusal answers in one statement while other draws keep charging around it', async () => {
    await keyed(1000, 990, 'base');
    const base = dbExecutor(() => client);
    let statements = 0;
    const executor: PgExecutor = {
      async query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
        const rows = await base.query<R>(sql, params);
        statements += 1;
        if (statements <= 5) await keyed(1000, 1, `around-${statements}`);
        return rows;
      },
    };
    const big = postgresMeterStore({ executor });
    const refused = await big.draw({
      ...key,
      periodStartMs: START,
      limit: 1000,
      amount: 50,
      drawKey: 'big',
    });
    expect(refused).toEqual({ allowed: false, used: 990, warned: false, periodStartMs: START });
    // One decision, plus the delete of the probe's placeholder.
    expect(statements).toBe(2);
  });

  // A text-mode client renders a timestamp in the session's DateStyle (`German`: 07.11.2026), which
  // `Date.parse` cannot read: every period the store reads back is epoch ms, never a timestamp.
  test('a text-mode client in any DateStyle reads every period back', async () => {
    const base = dbExecutor(() => client);
    const german = (value: unknown): unknown =>
      value instanceof Date
        ? `${value.getUTCDate()}.${value.getUTCMonth() + 1}.${value.getUTCFullYear()} 00:00:00 UTC`
        : value;
    const executor: PgExecutor = {
      async query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
        const rows = await base.query<Record<string, unknown>>(sql, params);
        return rows.map(
          (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, german(v)])) as R,
        );
      },
    };
    const text = postgresMeterStore({ executor });
    const at = (limit: number, drawKey: string, periodStartMs: number) =>
      text.draw({ ...key, periodStartMs, limit, amount: 2, drawKey });
    await at(4, 'a', START + DAY);
    expect(await at(4, 'b', START)).toMatchObject({ allowed: true, periodStartMs: START + DAY });
    expect(await at(4, 'c', START)).toMatchObject({ allowed: false, periodStartMs: START + DAY });
    expect(await at(4, 'a', START)).toMatchObject({ replayed: true, periodStartMs: START + DAY });
  });

  test('a refused keyed draw leaves no row in x_meter_key', async () => {
    await keyed(2, 2, 'fill');
    expect((await keyed(2, 1, 'refused')).allowed).toBe(false);
    const keys = await dbExecutor(() => client).query<{ draw_key: string }>(
      'select draw_key from x_meter_key',
      [],
    );
    expect(keys.map((row) => row.draw_key)).toEqual(['fill']);
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
