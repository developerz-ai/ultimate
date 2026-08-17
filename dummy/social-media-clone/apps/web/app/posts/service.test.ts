// unit — the feed's author join. The failure case first: a post whose author the lookup does not
// know is DROPPED from the feed, silently, and until 2026-08 the lookup was "the first 200 users"
// with no relation to the page being rendered. On the demo's 8 accounts that never showed; on any
// data at all it is a feed missing rows nobody can explain.

import { beforeAll, expect, test } from 'bun:test';
import { db, seedDemo } from '@social-media-clone/db';
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
