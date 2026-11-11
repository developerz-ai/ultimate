// `history(id)` against a real server: the trigger writes the versions in the WRITE'S transaction,
// so a transaction's versions tie on `now()` and still read back in order, a rolled-back transaction
// leaves none, and another tenant reads none. `history-read.test.ts` is the PGlite/memory half.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, frozenClock, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  sql,
  statementsOf,
  withTransaction,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { history } from './history-read';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;
const ORG_A = '00000000-0000-7000-8000-0000000000aa';
const ORG_B = '00000000-0000-7000-8000-0000000000bb';
const ID = '00000000-0000-7000-8000-000000000101';
const GONE = '00000000-0000-7000-8000-000000000102';

const docs = entity('hist_live_docs', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text() },
  history: true,
});
const docsHistory = docs.$history ?? expect.unreachable('history: true declares a history entity');
const DROP = 'drop table if exists "hist_live_docs", "hist_live_docs_history" cascade';
const as = (orgId: string) =>
  ctxOf({
    actor: { ...userActor({ id: 'member-1' }), orgId },
    clock: frozenClock('2026-11-10T09:00:00.000Z'),
  });

afterAll(() => {
  clearRegistry();
});

describe.skipIf(!hasPostgres)('live · postgres · history(id)', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [docs.$describe(), docsHistory.$describe()],
      name: 'history read live',
      now: new Date('2026-11-10T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    setDbClient(undefined);
    await client.close();
  });

  test('one transaction: in order, numbered, attributed; a rollback and another tenant see none', async () => {
    const driver = postgresDriver();
    const db = database({ docs, docsHistory }, { driver });
    const titles = ['b', 'c', 'd', 'e', 'f'];
    const result = await runWithContext(as(ORG_A), async () => {
      await driver.transactor().run(async () => {
        await db.docs.insert({ id: ID, orgId: ORG_A, title: 'a' });
        for (const title of titles) await db.docs.update(ID, { title });
        await db.docs.delete(ID);
      });
      const refused = await driver
        .transactor()
        .run(async () => {
          await db.docs.insert({ id: GONE, orgId: ORG_A, title: 'a' });
          await db.docs.insert({ id: GONE, orgId: ORG_A, title: 'b' });
        })
        .then(() => 'committed')
        .catch((error: unknown) => (isUltimateError(error) ? 'refused' : 'uncoded'));
      return {
        rows: await history(db.docsHistory, ID),
        refused,
        gone: await history(db.docsHistory, GONE),
      };
    });
    const other = await runWithContext(as(ORG_B), () => history(db.docsHistory, ID));
    expect(result.rows.map((row) => [row.version, row.op, row.actorId])).toEqual([
      [1, 'insert', 'member-1'],
      ...titles.map((_t, i) => [i + 2, 'update', 'member-1']),
      [titles.length + 2, 'delete', 'member-1'],
    ]);
    expect(
      result.rows.map((row) => (row.after as { title?: string } | null)?.title ?? null),
    ).toEqual(['a', ...titles, null]);
    expect(result.refused).toBe('refused');
    expect(result.gone).toEqual([]);
    expect(other).toEqual([]);
  });

  test('a transaction that BEGAN first and committed last reads back last', async () => {
    // `at` is each transaction's start (`now()`): T2 begins, T1 updates a→b and commits, then T2
    // updates b→c and commits — T2's `at` is the EARLIER one, while the row holds c.
    const ROW = '00000000-0000-7000-8000-000000000103';
    const second = postgresClient({ url: adminUrl ?? '' });
    const update = (title: string) =>
      sql`update "hist_live_docs" set title = ${title} where id = ${ROW}`;
    try {
      await client.execute(
        sql`insert into "hist_live_docs" (id, org_id, title) values (${ROW}, ${ORG_A}, 'a')`,
      );
      let began: () => void = () => undefined;
      const t2Began = new Promise<void>((resolve) => {
        began = resolve;
      });
      let t1Done: () => void = () => undefined;
      const t1Committed = new Promise<void>((resolve) => {
        t1Done = resolve;
      });
      const t2 = withTransaction(
        async (tx) => {
          await tx.execute(raw('select 1'));
          began();
          await t1Committed;
          await tx.execute(update('c'));
        },
        { client: second },
      );
      await t2Began;
      await withTransaction((tx) => tx.execute(update('b')), { client });
      t1Done();
      await t2;
      const db = database({ docs, docsHistory }, { driver: postgresDriver() });
      const versions = await runWithContext(as(ORG_A), () => history(db.docsHistory, ROW));
      const atOf = (title: string): number =>
        versions
          .find((v) => (v.after as { title?: string } | null)?.title === title)
          ?.at.getTime() ?? Number.NaN;
      // The interleaving happened: b→c carries an EARLIER `at` than a→b.
      expect(atOf('c') < atOf('b')).toBe(true);
      expect(
        versions.map((v) => [v.version, (v.after as { title?: string } | null)?.title ?? null]),
      ).toEqual([
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ]);
    } finally {
      await second.close();
    }
  });

  test('a delete by a transaction that began before the insert still reads after it', async () => {
    // T2 begins, T1 inserts the row and commits, T2 deletes it: the delete's `at` is the earlier.
    const ROW = '00000000-0000-7000-8000-000000000104';
    const second = postgresClient({ url: adminUrl ?? '' });
    try {
      let began: () => void = () => undefined;
      const t2Began = new Promise<void>((resolve) => {
        began = resolve;
      });
      let t1Done: () => void = () => undefined;
      const t1Committed = new Promise<void>((resolve) => {
        t1Done = resolve;
      });
      const t2 = withTransaction(
        async (tx) => {
          await tx.execute(raw('select 1'));
          began();
          await t1Committed;
          await tx.execute(sql`delete from "hist_live_docs" where id = ${ROW}`);
        },
        { client: second },
      );
      await t2Began;
      await withTransaction(
        (tx) =>
          tx.execute(
            sql`insert into "hist_live_docs" (id, org_id, title) values (${ROW}, ${ORG_A}, 'a')`,
          ),
        { client },
      );
      t1Done();
      await t2;
      const db = database({ docs, docsHistory }, { driver: postgresDriver() });
      const versions = await runWithContext(as(ORG_A), () => history(db.docsHistory, ROW));
      const atOf = (op: string): number =>
        versions.find((v) => v.op === op)?.at.getTime() ?? Number.NaN;
      expect(atOf('delete') < atOf('insert')).toBe(true);
      expect(versions.map((v) => [v.version, v.op])).toEqual([
        [1, 'insert'],
        [2, 'delete'],
      ]);
    } finally {
      await second.close();
    }
  });
});
