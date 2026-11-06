// `entity(name, { view })` end to end on the embedded PGlite: `x db gen`'s statements create the
// view, the chain reads it with the tenant predicate and the codec a table gets, every write is
// `X_ENTITY_VIEW_READ_ONLY` on both drivers before a statement exists, and the declarations a view
// cannot honour are refused where they were written.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { bigint } from './columns-data';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;
const ORG_A = '00000000-0000-7000-8000-00000000000a';
const ORG_B = '00000000-0000-7000-8000-00000000000b';
const POST = '00000000-0000-7000-8000-000000000101';

const likes = entity('ve_likes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    postId: uuid(),
    createdAt: timestamp().defaultNow(),
  },
});

const totals = entity('ve_post_totals', {
  view: {
    sql: 'select org_id, post_id, count(*) as total from ve_likes group by org_id, post_id',
    materialized: true,
  },
  columns: { orgId: uuid().tenant(), postId: uuid().unique(), total: bigint() },
  primaryKey: ['postId'],
});

const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const { up } = generateMigration({
    entities: [likes.$describe(), totals.$describe()],
    name: 'view entity',
  });
  for (const statement of statementsOf(up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

const inOrg = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u', orgId }) }), work);

describe('a view entity, read through the chain', () => {
  test(
    "Postgres derives the rows; the actor's tenant bounds them; the codec decodes them",
    async () => {
      const db = database({ likes, totals }, { driver: postgresDriver() });
      await db.likes.insertAll([
        { id: '00000000-0000-7000-8000-000000000001', orgId: ORG_A, postId: POST },
        { id: '00000000-0000-7000-8000-000000000002', orgId: ORG_A, postId: POST },
      ]);
      await client.execute(raw('refresh materialized view concurrently ve_post_totals'));
      expect(await inOrg(ORG_A, () => db.totals.all())).toEqual([
        { orgId: ORG_A, postId: POST, total: '2' },
      ]);
      expect(await inOrg(ORG_B, () => db.totals.all())).toEqual([]);
    },
    PGLITE_BOOT_MS,
  );

  test('$describe carries the view, and only a view', () => {
    expect(totals.$describe().view).toEqual({
      sql: 'select org_id, post_id, count(*) as total from ve_likes group by org_id, post_id',
      materialized: true,
    });
    expect('view' in likes.$describe()).toBe(false);
    expect(totals.$viewQuery?.materialized).toBe(true);
    expect(likes.$viewQuery).toBeNull();
  });
});

describe('every write to a view is refused, on both drivers', () => {
  const row = { orgId: ORG_A, postId: POST, total: '1' };
  const writes = [
    ['insert', (db: ReturnType<typeof open>) => db.totals.insert(row)],
    ['insertAll', (db: ReturnType<typeof open>) => db.totals.insertAll([row])],
    [
      'upsertAll',
      (db) => db.totals.upsertAll([row], { onConflict: ['postId'], onMatch: 'nothing' }),
    ],
    ['update', (db) => db.totals.update(POST, { total: '2' })],
    ['delete', (db) => db.totals.delete(POST)],
    ['deleteWhere', (db) => db.totals.deleteWhere({ postId: POST })],
    ['updateWhere', (db) => db.totals.updateWhere({ postId: POST }, { total: '2' })],
  ] as const satisfies readonly (readonly [
    string,
    (db: ReturnType<typeof open>) => Promise<unknown>,
  ])[];
  function open(driver: ReturnType<typeof memoryDriver>) {
    return database({ likes, totals }, { driver });
  }
  for (const [name, write] of writes) {
    test(name, async () => {
      for (const driver of [memoryDriver(), postgresDriver()]) {
        await expect(inOrg<unknown>(ORG_A, () => write(open(driver)))).rejects.toBeUltimateError(
          'X_ENTITY_VIEW_READ_ONLY',
        );
      }
    });
  }
});

describe('what a view declaration may not hold', () => {
  const cases = [
    ['a blank query', { sql: '  ' }, {}],
    ['two statements', { sql: 'select 1; drop table ve_likes' }, {}],
    ['an index on a plain view', { sql: 'select 1 as id' }, { unique: true }],
    ['appendOnly', { sql: 'select 1 as id' }, { appendOnly: true }],
    ['a sealed column', { sql: 'select 1 as id' }, { sealed: true }],
  ] as const;
  for (const [name, view, over] of cases) {
    test(`${name} is X_INVARIANT_VIOLATED`, () => {
      const declare = () =>
        entity(`ve_bad_${name.replaceAll(' ', '_')}`, {
          view,
          ...('appendOnly' in over ? { appendOnly: true } : {}),
          columns: {
            id: uuid().primaryKey(),
            label: 'unique' in over ? text({ max: 9 }).unique() : text({ max: 9 }),
            ...('sealed' in over ? { secret: text().sealed() } : {}),
          },
        });
      expect(declare).toThrow(expect.objectContaining({ code: 'X_INVARIANT_VIOLATED' }));
    });
  }

  test('a trailing ; is one statement, not two', () => {
    const fine = entity('ve_trailing', {
      view: { sql: 'select 1 as id;  ' },
      columns: { id: uuid().primaryKey() },
    });
    expect(fine.$viewQuery?.sql).toBe('select 1 as id');
  });
});
