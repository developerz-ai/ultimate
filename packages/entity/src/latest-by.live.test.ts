// `latestBy` against a real Postgres: the server accepts `DISTINCT ON` and the typed `LATERAL`
// source, answers the row the memory fold answers, ties broken by the key, under tenancy and soft
// delete — one statement for 20 groups. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { subscribe } from '@ultimat3/core';
import {
  type DbClient,
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { integer, text, timestamp, uuid } from './columns';
import { valueAt } from './cursor';
import { database } from './database';
import { entity } from './entity';
import type { LatestBySpec } from './latest-by';
import { postgresDriver } from './pg-driver';
import { postgresLatestBy } from './pg-latest-by';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const messages = entity('latest_live_messages', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    conversationId: uuid(),
    body: text({ max: 40 }),
    seq: integer(),
    sentAt: timestamp(),
    deletedAt: timestamp().nullable(),
  },
});

const DROP = 'drop table if exists "latest_live_messages" cascade';

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;
const ORG = idAt(1);
const OTHER = idAt(2);
const conversation = (group: number): string => idAt(10_000 + group);
const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 11, 9, minute));

const newest: LatestBySpec = {
  group: 'conversationId',
  order: [{ column: 'sentAt', direction: 'desc' }],
  perGroup: 1,
};

const ids = (rows: readonly unknown[]): readonly unknown[] => rows.map((row) => valueAt(row, 'id'));

// Top-level, so a skipped suite still empties the registry (`live-registry-cleanup.test.ts`).
afterAll(() => {
  clearRegistry();
});

describe.skipIf(!hasPostgres)('live · postgres · latestBy', () => {
  let client: PostgresClient;
  let sent = 0;
  const repo = () =>
    postgresLatestBy(messages, (): DbClient => {
      sent += 1;
      return client;
    });

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [messages.$describe()],
      name: 'live latestBy',
      now: new Date('2026-11-11T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
    const db = database({ messages }, { driver: postgresDriver() });
    // 20 conversations × 3 messages in ORG; m1 and m2 share the newest minute (the tie the key
    // breaks); one more in another tenant with a later minute than any of ours.
    const rows = Array.from({ length: 20 }, (_, group) =>
      [0, 1, 2].map((n) => ({
        id: idAt(100 + group * 10 + n),
        orgId: ORG,
        conversationId: conversation(group),
        body: `c${group} m${n}`,
        seq: n,
        sentAt: at(n === 0 ? 1 : 5),
      })),
    ).flat();
    await db.messages.insertAll(rows, { orgId: ORG });
    await db.messages.insert(
      {
        id: idAt(999),
        orgId: OTHER,
        conversationId: conversation(0),
        body: 'theirs',
        seq: 9,
        sentAt: at(30),
      },
      { orgId: OTHER },
    );
    // Group 1's newest is soft-deleted: the next one stands in.
    await db.messages.update(idAt(112), { deletedAt: at(40) }, { orgId: ORG });
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  test('20 groups: one statement, the newest row each, ties by the key, tenancy and soft delete held', async () => {
    sent = 0;
    const rows = await repo().latestBy(newest, { orgId: ORG });

    expect(sent).toBe(1);
    expect(rows).toHaveLength(20);
    expect(ids(rows).slice(0, 3)).toEqual([idAt(102), idAt(111), idAt(122)]);
    expect(rows.every((row) => valueAt(row, 'orgId') === ORG)).toBe(true);
    expect(valueAt(rows[0], 'sentAt')).toEqual(at(5));
  });

  test('keys: n rows per named parent through the typed LATERAL source, one statement', async () => {
    sent = 0;
    const rows = await repo().latestBy(
      { ...newest, perGroup: 2, keys: [conversation(3), conversation(7).toUpperCase()] },
      { orgId: ORG },
    );

    expect(sent).toBe(1);
    expect(ids(rows)).toEqual([idAt(132), idAt(131), idAt(172), idAt(171)]);
  });

  test('the chain terminal through postgresDriver(): the same rows, one statement', async () => {
    const db = database({ messages }, { driver: postgresDriver() });
    const seen: string[] = [];
    const off = subscribe('db.statement', ({ payload }) => {
      if (payload.text.includes('latest_live_messages')) seen.push(payload.text);
    });
    try {
      const rows = await db.messages
        .where({ orgId: ORG })
        .latestBy('conversationId', { order: 'sentAt' });
      expect(ids(rows).slice(0, 3)).toEqual([idAt(102), idAt(111), idAt(122)]);
    } finally {
      off();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('distinct on');
  });

  test('a projection reads its columns plus the group, the order and the key', async () => {
    const rows = await repo().latestBy(newest, { orgId: ORG, select: ['body'] });

    expect(Object.keys(rows[0] as object).sort()).toEqual(
      ['body', 'conversationId', 'id', 'sentAt'].sort(),
    );
  });
});
