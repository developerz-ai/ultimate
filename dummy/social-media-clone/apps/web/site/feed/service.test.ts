// unit — the feed's author join. The failure case first: a post whose author the lookup does not
// know is DROPPED from the feed, silently, and until 2026-08 the lookup was "the first 200 users"
// with no relation to the page being rendered. On the demo's 8 accounts that never showed; on any
// data at all it is a feed missing rows nobody can explain. Then the page itself: hidden rows newer
// than the visible ones must never shorten it, and it is two statements however many are hidden.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { db, driver, seedDemo } from '@social-media-clone/db';
import { testStatements } from '@ultimat3/testing';
import { canSeePost } from '../../shared/visibility';
import type { FeedPost } from './repo';
import { feedForPage, visibleFeed } from './service';

const NOW = new Date('2026-08-11T12:00:00Z');

const post = (id: string, authorId: string): FeedPost => ({
  id,
  authorId,
  body: 'a post',
  audience: 'public',
  likeCount: 0,
  commentCount: 0,
  mediaCount: 0,
  publishedAt: NOW,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const AUTHOR = '00000000-0000-4000-8000-00000000ab01';
const STRANGER = '00000000-0000-4000-8000-00000000ab02';

beforeAll(async () => {
  await seedDemo();
});

// The hidden posts below are this file's alone, and the store is process-wide: a second load of
// this file (`bun test --rerun-each`) would read them as part of the seed.
afterAll(() => {
  driver.reset?.();
});

test('a row whose author the lookup does not know is dropped — the reason the lookup must be exact', () => {
  const known = { handle: 'known', displayName: 'Known' };
  const items = visibleFeed(null, 10, (id) => (id === AUTHOR ? known : undefined), [
    post('00000000-0000-4000-8000-00000000ac01', AUTHOR),
    post('00000000-0000-4000-8000-00000000ac02', STRANGER),
  ]);

  expect(items.map((item) => item.post.authorId)).toEqual([AUTHOR]);
});

test('the page a route renders names every author it read', async () => {
  const items = await feedForPage(null, 20);

  // The seed publishes public posts from several accounts. Every one that survives the visibility
  // filter carries a real byline: an empty handle means the join answered for a row it never read.
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect(item.authorHandle.length).toBeGreaterThan(0);
    const author = await db.users.where({ id: item.post.authorId }).one();
    expect(item.authorHandle).toBe(author?.handle ?? '');
  }
});

test('hidden posts newer than every public one never shorten the page — the read asks for exactly it', async () => {
  const author = (await db.users.limit(1).all())[0];
  expect(author).toBeDefined();
  const authorId = author?.id ?? '';
  // Ten rows the anonymous rule hides, all newer than anything the seed published: the 3x
  // over-fetch this replaced read 6 rows for a page of 2, every one of them hidden, and served none.
  const future = (minute: number) => new Date(Date.UTC(2030, 0, 1, 0, minute));
  for (let index = 0; index < 10; index += 1) {
    const hidden = index % 3;
    await db.posts.insert({
      authorId,
      body: `hidden ${index}`,
      audience: hidden === 0 ? 'friends' : hidden === 1 ? 'private' : 'public',
      publishedAt: future(index),
      deletedAt: hidden === 2 ? future(index) : null,
    });
  }

  let sent = 0;
  let items: Awaited<ReturnType<typeof feedForPage>> = [];
  {
    using statements = await testStatements();
    items = await feedForPage(null, 2);
    sent = statements.count();
  }

  // The page and its authors: two statements, whatever share of the table the rule hides.
  expect(sent).toBe(2);
  expect(items).toHaveLength(2);
  // The same rows the rule over the whole table would have served first, in the same order.
  const everyPost = await db.posts.orderBy('publishedAt', 'desc').orderBy('id').limit(1_000).all();
  const expected = everyPost.filter((row) => canSeePost(null, row)).slice(0, 2);
  expect(items.map((item) => item.post.id)).toEqual(expected.map((row) => row.id));
});
