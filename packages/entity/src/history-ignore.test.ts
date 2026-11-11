// `entity({ history: { ignore } })`: columns that churn stay out of history. An update that changes
// only ignored columns records nothing — memory in its repository, Postgres (PGlite, migrated by
// the migration `x db gen` writes) in the trigger — and the read's chain still holds across them.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { integer, text, timestamp, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { history } from './history-read';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;
const ORG = '00000000-0000-7000-8000-0000000000aa';
const ID = '00000000-0000-7000-8000-000000000001';

const posts = entity('hist_ignore_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text(),
    likeCount: integer().default(0),
    seenAt: timestamp().column('seen_on').nullable(),
  },
  history: { ignore: ['likeCount', 'seenAt'] },
});
const postsHistory = posts.$history ?? expect.unreachable('history declares a history entity');
const ENTITIES = { posts, postsHistory };
const client = pgliteClient();
const as = () => ctxOf({ actor: { ...userActor({ id: 'member-1' }), orgId: ORG } });

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [posts.$describe(), postsHistory.$describe()],
    name: 'history ignore',
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

describe('history: { ignore } · the declaration', () => {
  test('the physical names reach $describe().history.ignore, which the trigger takes', () => {
    expect(posts.$describe().history?.ignore).toEqual(['like_count', 'seen_on']);
  });

  test('a name that is no column is refused where it is written', () => {
    const code = (() => {
      try {
        entity('hist_ignore_bad', {
          columns: { id: uuid().primaryKey(), title: text() },
          // @ts-expect-error — only the entity's own columns can be ignored
          history: { ignore: ['titel'] },
        });
      } catch (error) {
        return isUltimateError(error) ? error.code : 'uncoded';
      }
      return 'accepted';
    })();
    expect(code).toBe('X_INVARIANT_VIOLATED');
  });
});

const run = async (driver: Driver) => {
  await client.execute(raw('delete from "hist_ignore_posts"'));
  await client.execute(raw(`select set_config('x.purge', 'hist_ignore_posts_history', false)`));
  await client.execute(raw('delete from "hist_ignore_posts_history"'));
  await client.execute(raw(`select set_config('x.purge', '', false)`));
  const db = database(ENTITIES, { driver });
  return runWithContext(as(), async () => {
    await db.posts.insert({ id: ID, orgId: ORG, title: 'a' });
    await db.posts.update(ID, { likeCount: 3 });
    await db.posts.update(ID, { seenAt: new Date('2026-11-10T09:00:00.000Z') });
    await db.posts.update(ID, { title: 'b', likeCount: 4 });
    await db.posts.updateWhere({ orgId: ORG }, { likeCount: 9 });
    const versions = await history(db.postsHistory, ID);
    return versions.map((v) => [v.version, v.op, (v.after as { title?: string } | null)?.title]);
  });
};

describe('history: { ignore } · both drivers, one answer', () => {
  test('an update of ignored columns only records nothing; one that also changes another does', async () => {
    const memory = await run(memoryDriver());
    const postgres = await run(postgresDriver());
    expect(postgres).toEqual([
      [1, 'insert', 'a'],
      [2, 'update', 'b'],
    ]);
    expect(memory).toEqual(postgres);
  });
});
