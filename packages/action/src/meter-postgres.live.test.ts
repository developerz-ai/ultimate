// The shared meter store against Postgres 17, on several connections at once: N parallel draws at
// the edge admit exactly the remainder, a later period rolls the row over in place, a lagging
// replica cannot reset it, and one period's warning has one claimant. Skips unless
// `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { postgresMeterStore, SQL_METER_TABLE } from './meter-postgres';
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
    store = postgresMeterStore({ executor: dbExecutor(() => client) });
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  beforeEach(async () => {
    await client.execute(raw('truncate x_meter'));
  });

  const draw = (limit: number, periodStartMs = START, subject: string = key.subject) =>
    store.draw({ ...key, subject, periodStartMs, limit });

  test('the table is idempotent to apply', async () => {
    await client.execute(raw(SQL_METER_TABLE));
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
});
