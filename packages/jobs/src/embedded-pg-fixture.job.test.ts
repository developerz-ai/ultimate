// The embedded-Postgres fixture keeps its two promises for EVERY table the DDL installs, not the
// ones it was written alongside: `reset()` empties each, and `age()` moves each stored instant.
// A table added to `SQL_JOBS_TABLE` later is held to both without touching the fixture.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';

let pg: EmbeddedPg;

beforeEach(async () => {
  pg = await embeddedPg();
  await pg.reset();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

const epochMs = async (sql: string): Promise<number> => {
  const rows = await pg.executor.query<{ at: number | string }>(
    `select floor(extract(epoch from (${sql})) * 1000)::bigint as at`,
    [],
  );
  return Number(rows[0]?.at);
};

describe('the embedded Postgres fixture', () => {
  test('reset() empties every table the DDL installs', async () => {
    await pg.executor.query(
      `insert into x_scheduler_leader (lock_key, holder, expires_at) values ('lead', 'me', now())`,
      [],
    );
    await pg.executor.query(
      `insert into x_backfills (run_id, name, checksum, app_version)
       values (gen_random_uuid(), 'bf', 'sum', 'v1')`,
      [],
    );
    await pg.reset();
    const tables = await pg.executor.query<{ name: string }>(
      `select table_name as name from information_schema.tables
        where table_schema = current_schema() and table_type = 'BASE TABLE'`,
      [],
    );
    expect(tables.length).toBeGreaterThan(0);
    for (const { name } of tables) {
      const [row] = await pg.executor.query<{ n: number }>(
        `select count(*)::int as n from ${name}`,
        [],
      );
      expect({ name, rows: row?.n }).toEqual({ name, rows: 0 });
    }
  });

  test('age() moves an outbox claim and a leader lease into the past too', async () => {
    const now = await epochMs('now()');
    await pg.executor.query(
      `insert into x_outbox (id, job, input, idempotency_key, claimed_at, claimed_by)
       values (gen_random_uuid(), 'j', '{}'::jsonb, 'k', now(), 'relay-1')`,
      [],
    );
    await pg.executor.query(
      `insert into x_scheduler_leader (lock_key, holder, expires_at) values ('lead', 'me', now())`,
      [],
    );
    await pg.age(60_000);
    expect(await epochMs('select claimed_at from x_outbox')).toBe(now - 60_000);
    expect(await epochMs('select staged_at from x_outbox')).toBe(now - 60_000);
    expect(await epochMs('select expires_at from x_scheduler_leader')).toBe(now - 60_000);
  });
});
