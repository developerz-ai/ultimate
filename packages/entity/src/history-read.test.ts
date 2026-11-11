// `history(db.<x>History, id)`: one row's recorded versions, oldest first, numbered from 1, the same
// on both drivers — memory in its repository, Postgres (embedded PGlite, migrated by the migration
// `x db gen` writes) in the trigger. Ties on `at` are the norm, not the edge: every write in one
// transaction shares `now()`, and a frozen test clock is one instant for all of them.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, frozenClock, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { history } from './history-read';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;
const ORG_A = '00000000-0000-7000-8000-0000000000aa';
const ORG_B = '00000000-0000-7000-8000-0000000000bb';
const ID = '00000000-0000-7000-8000-000000000001';
const IDS = [ID, '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000003'];
const STEPS = ['b', 'c', 'd', 'e', 'f', 'g', 'h'];

const docs = entity('hist_read_docs', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text(),
    views: integer().default(0),
  },
  history: true,
});
const docsHistory = docs.$history ?? expect.unreachable('history: true declares a history entity');
const ENTITIES = { docs, docsHistory };
type Db = ReturnType<typeof database<typeof ENTITIES>>;

const client = pgliteClient();
// One frozen instant: every memory write ties on `at`, as every write of one Postgres transaction does.
const as = (orgId: string) =>
  ctxOf({
    actor: { ...userActor({ id: 'member-1' }), orgId },
    clock: frozenClock('2026-11-10T09:00:00.000Z'),
  });

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [docs.$describe(), docsHistory.$describe()],
    name: 'history read',
    now: new Date('2026-11-10T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
});

afterAll(() => {
  clearRegistry();
});

const fresh = async (driver: Driver): Promise<Db> => {
  await client.execute(raw('delete from "hist_read_docs"'));
  await client.execute(raw(`select set_config('x.purge', 'hist_read_docs_history', false)`));
  await client.execute(raw('delete from "hist_read_docs_history"'));
  await client.execute(raw(`select set_config('x.purge', '', false)`));
  return database(ENTITIES, { driver });
};

/**
 * The Postgres rows' `at`, set to 09:00 plus the minute each one's `after.title` sits at in `titles`
 * — what the memory driver's ctx clock stamps. The history guard refuses every update, so it is off
 * for this one statement: the subject here is the read, and the trigger's stamping has its own tests.
 */
const restampMinutes = async (titles: readonly string[]): Promise<void> => {
  const table = '"hist_read_docs_history"';
  const list = titles.map((title) => `'${title}'`).join(', ');
  await client.execute(raw(`alter table ${table} disable trigger "ultimate_history_guard"`));
  await client.execute(
    raw(
      `update ${table} set "at" = timestamptz '2026-11-10T09:00:00Z' + make_interval(mins => ` +
        `array_position(array[${list}], "after" ->> 'title') - 1)`,
    ),
  );
  await client.execute(raw(`alter table ${table} enable trigger "ultimate_history_guard"`));
};

/** What a version says, without its random id or the instant. */
const shape = (rows: Awaited<ReturnType<typeof history>>): unknown[][] =>
  rows.map((row) => [
    row.version,
    row.op,
    (row.before as { title?: string } | null)?.title ?? null,
    (row.after as { title?: string } | null)?.title ?? null,
  ]);

const DRIVERS: readonly (readonly [string, () => Driver])[] = [
  ['memory', memoryDriver],
  ['postgres', () => postgresDriver()],
];

describe.each(DRIVERS)('history(id) · %s', (driverName, makeDriver) => {
  test('insert, update, delete: three versions, in order', async () => {
    const driver = makeDriver();
    const db = await fresh(driver);
    const rows = await runWithContext(as(ORG_A), async () => {
      await db.docs.insert({ id: ID, orgId: ORG_A, title: 'a' });
      await db.docs.update(ID, { title: 'b' });
      await db.docs.delete(ID);
      return history(db.docsHistory, ID);
    });
    expect(shape(rows)).toEqual([
      [1, 'insert', null, 'a'],
      [2, 'update', 'a', 'b'],
      [3, 'delete', 'b', null],
    ]);
    expect(rows.every((row) => row.rowId === ID && row.actorId === null)).toBe(true);
  });

  test('every write of one transaction ties on `at`, and still reads back in order', async () => {
    const driver = makeDriver();
    const db = await fresh(driver);
    const rows = await runWithContext(as(ORG_A), async () => {
      await driver.transactor().run(async () => {
        await db.docs.insert({ id: ID, orgId: ORG_A, title: 'a' });
        for (const title of STEPS) await db.docs.update(ID, { title });
        // A change the title does not show: two versions with one title, told apart by `views`.
        await db.docs.update(ID, { views: 3 });
        await db.docs.update(ID, { title: 'z' });
        await db.docs.delete(ID);
        await db.docs.insert({ id: ID, orgId: ORG_A, title: 'again' });
      });
      return history(db.docsHistory, ID);
    });
    const titles = ['a', ...STEPS, 'z'];
    expect(shape(rows)).toEqual([
      [1, 'insert', null, 'a'],
      ...STEPS.map((title, i) => [i + 2, 'update', titles[i], title]),
      [STEPS.length + 2, 'update', 'h', 'h'],
      [STEPS.length + 3, 'update', 'h', 'z'],
      [STEPS.length + 4, 'delete', 'z', null],
      [STEPS.length + 5, 'insert', null, 'again'],
    ]);
    expect(rows.every((row) => row.actorId === 'member-1')).toBe(true);
  });

  test('{ limit }: the newest n versions, oldest first, numbered as the whole history numbers them', async () => {
    const driver = makeDriver();
    const db = await fresh(driver);
    // Each write at its own instant, so the window is narrower than the history: memory stamps the
    // ctx clock; Postgres stamps its own `now()`, so its rows are re-stamped below to the same
    // minutes, deterministically, rather than waiting on the wall clock between writes.
    const at = (minute: number) =>
      ctxOf({
        actor: { ...userActor({ id: 'member-1' }), orgId: ORG_A },
        clock: frozenClock(new Date(Date.UTC(2026, 10, 10, 9, minute)).toISOString()),
      });
    await runWithContext(at(0), () => db.docs.insert({ id: ID, orgId: ORG_A, title: 'a' }));
    for (const [i, title] of ['b', 'c', 'd', 'e'].entries()) {
      await runWithContext(at(i + 1), () => db.docs.update(ID, { title }));
    }
    if (driverName === 'postgres') await restampMinutes(['a', 'b', 'c', 'd', 'e']);
    const [window, whole, wide] = await runWithContext(as(ORG_A), async () => {
      return Promise.all([
        history(db.docsHistory, ID, { limit: 2 }),
        history(db.docsHistory, ID),
        history(db.docsHistory, ID, { limit: 50 }),
      ]);
    });
    expect(shape(window)).toEqual([
      [4, 'update', 'c', 'd'],
      [5, 'update', 'd', 'e'],
    ]);
    expect(shape(wide)).toEqual(shape(whole));
    const refused = await Promise.all(
      [0, -1, 1.5, Number.NaN].map((limit) =>
        history(db.docsHistory, ID, { limit }).then(
          () => 'read',
          (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
        ),
      ),
    );
    expect(refused).toEqual(Array(4).fill('X_INVARIANT_VIOLATED'));
  });

  test('a rolled-back write leaves no version', async () => {
    const driver = makeDriver();
    const db = await fresh(driver);
    const rows = await runWithContext(as(ORG_A), async () => {
      const outcome = await driver
        .transactor()
        .run(async () => {
          await db.docs.insert({ id: ID, orgId: ORG_A, title: 'a' });
          await db.docs.update(ID, { title: 'b' });
          // The same key twice: the transaction fails on a write of its own, and rolls back.
          await db.docs.insert({ id: ID, orgId: ORG_A, title: 'c' });
        })
        .then(() => 'committed')
        .catch((error: unknown) => (isUltimateError(error) ? 'refused' : 'uncoded'));
      expect(outcome).toBe('refused');
      return history(db.docsHistory, ID);
    });
    expect(rows).toEqual([]);
  });

  test("another tenant reads none of this tenant's history", async () => {
    const driver = makeDriver();
    const db = await fresh(driver);
    await runWithContext(as(ORG_A), async () => {
      await db.docs.insert({ id: ID, orgId: ORG_A, title: 'a' });
      await db.docs.update(ID, { title: 'b' });
    });
    const own = await runWithContext(as(ORG_A), () => history(db.docsHistory, ID));
    const other = await runWithContext(as(ORG_B), () => history(db.docsHistory, ID));
    expect(own.length).toBe(2);
    expect(other).toEqual([]);
  });

  test('insertAll then updateWhere: one version per row each changed, none for an unchanged one', async () => {
    const driver = makeDriver();
    const db = await fresh(driver);
    const counts = await runWithContext(as(ORG_A), async () => {
      await db.docs.insertAll([
        { id: IDS[0] ?? '', orgId: ORG_A, title: 'a' },
        { id: IDS[1] ?? '', orgId: ORG_A, title: 'a' },
        { id: IDS[2] ?? '', orgId: ORG_A, title: 'x' },
      ]);
      const written = await db.docs.updateWhere({ orgId: ORG_A }, { title: 'x' });
      expect(written).toBe(3);
      return Promise.all(
        IDS.map(async (id) => shape(await history(db.docsHistory, id)).map((row) => row[1])),
      );
    });
    expect(counts).toEqual([['insert', 'update'], ['insert', 'update'], ['insert']]);
  });
});

const counted = entity('hist_read_counted', {
  columns: { id: uuid().primaryKey(), title: text(), likeCount: integer().default(0) },
  history: true,
});
const countedLikes = entity('hist_read_likes', {
  columns: {
    id: uuid().primaryKey(),
    docId: uuid().references(() => counted.id, { countedIn: () => counted.likeCount }),
  },
});
const countedHistory = counted.$history ?? expect.unreachable('history: true');

describe('history(id) · a counted column', () => {
  test("a counter's move records nothing, and the versions around it still chain", async () => {
    const db = database({ counted, countedLikes, countedHistory }, { driver: memoryDriver() });
    const rows = await runWithContext(as(ORG_A), async () => {
      await db.counted.insert({ id: ID, title: 'a' });
      for (const title of STEPS) {
        await db.countedLikes.insert({ id: crypto.randomUUID(), docId: ID });
        await db.counted.update(ID, { title });
      }
      return history(db.countedHistory, ID);
    });
    expect(shape(rows).map((row) => row[3])).toEqual(['a', ...STEPS]);
  });
});
