// Issue #702 against a real server, under real concurrency: a decision read `authorId`, and a
// reassignment of that column is IN FLIGHT — uncommitted, holding the row's lock — when the move is
// issued. The move waits on that lock, Postgres re-checks the predicate against the row the
// reassignment left behind, and the move is refused. PGlite has one connection and cannot hold two
// transactions open at once, which is why this half is live (`transition-observed.test.ts` is the
// parity half).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
  withTransaction,
} from '@ultimat3/db';
import { enumerated, text, uuid } from './columns';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import { transitionRow } from './transition';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const posts = entity('pg_to_posts', {
  columns: {
    id: uuid().primaryKey(),
    authorId: text({ max: 40 }),
    status: enumerated(['draft', 'published'] as const)
      .transitions({ draft: ['published'], published: [] })
      .default('draft'),
  },
});

type Post = typeof posts.$row;
const DROP = 'drop table if exists "pg_to_posts" cascade';
const id = (n: number): string => `00000000-0000-7000-8000-0000000702${String(n).padStart(2, '0')}`;

afterAll(() => {
  clearRegistry();
});

/** The repo call `Table.transition` makes, carrying what the decision read. */
const publish = (rowId: string, read: Post, consulted: readonly string[]): Promise<Post> =>
  transitionRow(
    posts,
    postgresRepo(posts),
    'status',
    rowId,
    { from: 'draft', to: 'published', observed: { row: read, read: consulted } },
    (patch) => patch,
    undefined,
  );

const settled = (run: Promise<Post>): Promise<string> =>
  run.then(
    (row) => row.status,
    (error: unknown) => (error instanceof UltimateError ? error.code : 'other'),
  );

describe.skipIf(!hasPostgres)(
  'live · postgres · a transition pinned to what its decision read',
  () => {
    let client: PostgresClient;

    beforeAll(async () => {
      client = postgresClient({ url: adminUrl ?? '' });
      setDbClient(client);
      await client.execute(raw(DROP));
      const migration = generateMigration({
        entities: [posts.$describe()],
        name: 'live transition observed',
        now: new Date('2026-10-07T00:00:00.000Z'),
      });
      for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
    });

    afterAll(async () => {
      await client.execute(raw(DROP));
      await client.close();
      setDbClient(undefined);
    });

    const seeded = (rowId: string): Promise<Post> =>
      postgresRepo(posts).insert({ id: rowId, authorId: 'u-author', status: 'draft' });

    test('a reassignment in flight is waited on, and the move it invalidated is refused', async () => {
      const read = await seeded(id(1));
      let reassigned: () => void = () => undefined;
      let release: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        reassigned = resolve;
      });
      const commit = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = withTransaction(async () => {
        await postgresRepo(posts).update(id(1), { authorId: 'u-thief' });
        reassigned();
        await commit;
      });
      await locked;
      // Issued while the reassignment holds the row: the statement blocks on its lock.
      const move = settled(publish(id(1), read, ['authorId']));
      const early = await Promise.race([move, Bun.sleep(150).then(() => 'blocked')]);
      expect(early).toBe('blocked');
      release();
      await writer;
      expect(await move).toBe('X_STATE_CONFLICT');
      expect((await postgresRepo(posts).findById(id(1)))?.status).toBe('draft');
    });

    test('a write that leaves the value the decision read as it was lets the move land', async () => {
      const read = await seeded(id(2));
      await postgresRepo(posts).update(id(2), { authorId: 'u-author' });
      const moved = await settled(publish(id(2), read, ['authorId']));
      expect(moved).toBe('published');
    });

    test('a reassignment committed before the move refuses it', async () => {
      const read = await seeded(id(3));
      await postgresRepo(posts).update(id(3), { authorId: 'u-thief' });
      expect(await settled(publish(id(3), read, ['authorId']))).toBe('X_STATE_CONFLICT');
    });
  },
);
