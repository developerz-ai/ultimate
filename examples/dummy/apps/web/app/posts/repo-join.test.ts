/**
 * unit — the posts repo against the app's migrated database, through `wiki/Testing.md`'s recipe.
 * The handle is `@postly/db`'s module constant, built over `testDriver()` before this file installs
 * a client, so the proof is that it follows: the repo's handle writes land where a raw `sql` join —
 * the one thing a `repo.ts` may write raw (`wiki/Entities-And-Migrations.md`) — reads them.
 */

import { db } from '@postly/db';
import { memberId, orgId, postId } from '@postly/domain';
import { migratedDatabase } from '@ultimat3/cli';
import { type DbClient, setDbClient, sql } from '@ultimat3/db';
import { afterAll, beforeAll, expect, reusableDatabase, unitTest } from '@ultimat3/testing';
import * as repo from './repo';

// A template restore is ~0.5 s; its first build (initdb plus every migration) is what this bounds.
const BOOT_MS = 120_000;

const workerDatabase = reusableDatabase(() => migratedDatabase({ root: import.meta.dir }));

let client: DbClient;
beforeAll(async () => {
  client = await workerDatabase();
  setDbClient(client);
}, BOOT_MS);
// Back to memory, so this file's database never reaches the next file's unit tests.
afterAll(() => setDbClient(undefined));

const ORG = orgId('00000000-0000-4000-8000-0000000000b1');
const AUTHOR = memberId('00000000-0000-4000-8000-0000000000b2');

unitTest('a draft the repo wrote through the handle is what a raw join reads back', async () => {
  await db.orgs.insert({ id: ORG, slug: 'join-proof', name: 'Join proof' });
  await db.members.insert({
    id: AUTHOR,
    orgId: ORG,
    userId: '00000000-0000-4000-8000-0000000000b3',
    email: 'grace@postly.dev',
    name: 'Grace Hopper',
  });

  const draft = await repo.insertDraft({
    orgId: ORG,
    authorId: AUTHOR,
    slug: 'joined',
    title: 'Joined',
    excerpt: 'e',
    body: 'b',
  });

  const joined = await client.query<{ title: string; author: string }>(
    sql`select p.title, m.name as author
          from posts p join members m on m.id = p.author_id
         where p.id = ${draft.id}`,
  );
  expect(joined).toEqual([{ title: 'Joined', author: 'Grace Hopper' }]);
  // And the repo's own preloaded read answers from the same database.
  expect((await repo.byId(ORG, postId(draft.id)))?.authorName).toBe('Grace Hopper');
});
