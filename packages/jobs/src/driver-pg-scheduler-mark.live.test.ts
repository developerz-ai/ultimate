// `SQL_SCHEDULER_STATE_MARK` writes a row version only when the watermark MOVES. A mark that
// `greatest()` leaves where it was rewrote the row anyway — a dead tuple per task per round on a
// table of a few dozen rows (25% dead on 43 rows, production 2026-11-14). `xmin` is the row
// version: unchanged means nothing was written. Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { SQL_JOBS_TABLE } from './driver-pg-ddl';
import { SQL_SCHEDULER_STATE_MARK } from './driver-pg-sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_scheduler_mark_live');
const AT = Date.UTC(2026, 10, 14, 3, 0, 0);

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

describe.skipIf(!hasPostgres)('live · postgres · the scheduler watermark mark', () => {
  let admin: PostgresClient;
  let client: PostgresClient;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 1 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  const mark = (occurrenceMs: number): Promise<unknown> =>
    client.query({ text: SQL_SCHEDULER_STATE_MARK, values: ['nightly', occurrenceMs] });

  const row = async (): Promise<{ version: string; at: number }> => {
    const rows = await client.query<{ version: string; at: number | string }>({
      text: `select xmin::text as version,
                    (extract(epoch from last_fired_at) * 1000)::bigint as at
               from x_scheduler_state where task_name = 'nightly'`,
      values: [],
    });
    return { version: rows[0]?.version ?? '', at: Number(rows[0]?.at) };
  };

  test('a mark at or behind the watermark writes nothing, a later one moves it', async () => {
    await mark(AT);
    const first = await row();
    expect(first.at).toBe(AT);

    await mark(AT);
    await mark(AT - 60_000);
    expect(await row()).toEqual(first);

    await mark(AT + 60_000);
    const moved = await row();
    expect(moved.at).toBe(AT + 60_000);
    expect(moved.version).not.toBe(first.version);
  });
});
