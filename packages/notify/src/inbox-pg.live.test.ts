// The inbox's idempotent `add` racing a concurrent writer of the same notification, on a real
// server and two connections: under READ COMMITTED the conflict wait ends AFTER the statement's
// snapshot was taken, so the statement's own fallback select cannot see the row it conflicted
// with. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName } from '@ultimat3/core';
import { SQL } from 'bun';
import { postgresInboxStore, SQL_NOTIFY_INBOX_TABLE } from './inbox-pg';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_notify_inbox_live');
const WINNER = '00000000-0000-7000-8000-0000000000a1';
const LOSER = '00000000-0000-7000-8000-0000000000b2';

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

const executorOf = (sql: SQL): PgExecutor => ({
  query: async <R>(text: string, params: readonly unknown[]) =>
    (await sql.unsafe(text, [...params])) as R[],
});

describe.skipIf(!hasPostgres)('live · postgres · inbox add under a concurrent writer', () => {
  let admin: SQL;
  let writer: SQL;
  let racer: SQL;

  beforeAll(async () => {
    admin = new SQL(url ?? '');
    await admin.unsafe(`drop database if exists ${PROBE_DB} with (force)`);
    await admin.unsafe(`create database ${PROBE_DB}`);
    writer = new SQL({ url: probeUrl(), max: 1 });
    racer = new SQL({ url: probeUrl(), max: 1 });
    await writer.unsafe(SQL_NOTIFY_INBOX_TABLE);
  });

  afterAll(async () => {
    await writer?.close();
    await racer?.close();
    await admin?.unsafe(`drop database if exists ${PROBE_DB} with (force)`);
    await admin?.close();
  });

  test('the row answered is the row in the table, never an id that was never written', async () => {
    const tx = await writer.reserve();
    await tx.unsafe('begin');
    await tx.unsafe(
      `insert into x_notify_inbox (id, recipient, notifier, key, params, created_at)
       values ($1, 'ana', 'post.liked', 'k1', '{}', now())`,
      [WINNER],
    );
    const store = postgresInboxStore({ executor: executorOf(racer), newId: () => LOSER });
    const added = store.add({
      recipient: 'ana',
      notifier: 'post.liked',
      key: 'k1',
      params: {},
      createdAt: new Date('2026-11-12T09:00:00Z'),
    });
    // Until the racer is WAITING on the writer's row lock — a round trip per look, no timer.
    for (let look = 0; look < 1_000; look += 1) {
      const waiting = (await admin.unsafe(
        `select 1 from pg_stat_activity where datname = $1 and wait_event_type = 'Lock'`,
        [PROBE_DB],
      )) as unknown[];
      if (waiting.length > 0) break;
    }
    await tx.unsafe('commit');
    tx.release();
    const row = await added;
    expect(row.id).toBe(WINNER);
    const stored = (await writer.unsafe('select id from x_notify_inbox')) as { id: string }[];
    expect(stored.map((r) => r.id)).toEqual([WINNER]);
  });
});
