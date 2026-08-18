// unit — the map `restoreSeededGraph` decides what NOT to delete from. An empty one is the whole
// bug: it reads as "the fixture owns nothing", the hourly reset stamps every seeded post, and no
// replay can clear a soft-delete stamp. So the assertions name the ids the fixture declares.

import { expect, test } from 'bun:test';
import { defineSeed, seedId } from '@ultimat3/entity';
import { posts, users } from './schema';
import { demo } from './seed';
import { seededIds } from './seeded-ids';

/** Every post the fixture declares, `post:deleted` included — it is soft-deleted, not absent. */
const SEEDED_POSTS = [
  'post:tenancy',
  'post:timezones',
  'post:friends-only',
  'post:blocked-author',
  'post:deleted',
  'post:own',
].map(seedId);

test('the fixture reports the post ids it declares, the soft-deleted one included', async () => {
  // The reason this map exists at all: a stamped row cannot be restored by any replay, so a post
  // missing here is a post the first reset removes for good.
  expect(posts.$softDelete).toBe(true);
  const seeded = await seededIds(demo);
  const owned = seeded.get('posts');
  expect([...(owned ?? [])].toSorted()).toEqual([...SEEDED_POSTS].toSorted());
});

test('every content table the reset purges is answered for', async () => {
  const seeded = await seededIds(demo);
  // The tables `CONTENT_TABLES` walks (apps/web/app/tasks/repo.ts). One missing means every row of
  // it is deleted on the first reset, which is the same failure one table at a time.
  for (const table of ['media', 'comments', 'messages', 'notifications', 'posts']) {
    expect(seeded.get(table)?.size ?? 0).toBeGreaterThan(0);
  }
});

test('the marker accounts a reset guards on are the fixture’s own rows', async () => {
  const seeded = await seededIds(demo);
  expect(seeded.get('users')?.has(seedId('user:user'))).toBe(true);
  expect(seeded.get('users')?.has(seedId('user:admin'))).toBe(true);
});

test('a row no seed wrote is never claimed by one', async () => {
  // Derived, never a hand-kept list: a fixture that writes one user answers with that one user and
  // no posts at all, whatever the demo graph beside it declares.
  const one = defineSeed('one-user', async ({ insert, id }) => {
    await insert(users, [
      {
        id: id('user:solo'),
        handle: 'solo',
        email: 'solo@fixture.example',
        displayName: 'Solo',
        role: 'member',
      },
    ]);
  });
  const seeded = await seededIds(one);
  expect([...(seeded.get('users') ?? [])]).toEqual([seedId('user:solo')]);
  expect(seeded.has('posts')).toBe(false);
  // And the demo's own graph is untouched by it — each call replays into a store of its own.
  expect(seeded.get('users')?.has(seedId('user:user'))).toBe(false);
});
