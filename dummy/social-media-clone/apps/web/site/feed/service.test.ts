// unit — the feed's author join. The failure case first: a post whose author the lookup does not
// know is DROPPED from the feed, silently, and until 2026-08 the lookup was "the first 200 users"
// with no relation to the page being rendered. On the demo's 8 accounts that never showed; on any
// data at all it is a feed missing rows nobody can explain. Then the page itself: hidden rows newer
// than the visible ones must never shorten it, and it is two statements however many are hidden —
// for an anonymous reader and for a signed-in one, whose rule is an OR over their friend and block
// sets read as ONE predicate tree (`visibleTo`).

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { db, driver, seedDemo } from '@social-media-clone/db';
import { testStatements } from '@ultimat3/testing';
import { viewerActor } from '../../shared/actor';
import { canSeePost } from '../../shared/visibility';
import type { FeedPost } from './repo';
import { feedForPage, MAX_BLOCKS_IN_STATEMENT, visibleFeed, visibleTo } from './service';

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

test('a signed-in feed reads its exact page in one statement: mine, public, a friend’s friends-only', async () => {
  const [me, friend, stranger, blocker] = await Promise.all(
    ['feed_me', 'feed_friend', 'feed_stranger', 'feed_blocker'].map((handle) =>
      db.users.insert({
        handle,
        email: `${handle}@fixture.example`,
        displayName: handle,
        role: 'member',
      }),
    ),
  );
  if (me === undefined || friend === undefined || stranger === undefined || blocker === undefined) {
    return expect.unreachable('four users were inserted');
  }
  const viewer = viewerActor({
    id: me.id,
    role: 'member',
    friendIds: [friend.id],
    blockedIds: [blocker.id],
  });
  // Stored as the friend's request the viewer accepted: the hop reads BOTH directions.
  await db.friendships.insert({
    requesterId: friend.id,
    addresseeId: me.id,
    status: 'accepted',
    respondedAt: new Date(Date.UTC(2031, 0, 1)),
  });
  // A friendship the stranger asked for and nobody answered grants nothing.
  await db.friendships.insert({ requesterId: stranger.id, addresseeId: me.id });
  const at = (minute: number) => new Date(Date.UTC(2031, 0, 1, 0, minute));
  const write = (authorId: string, audience: 'public' | 'friends' | 'private', minute: number) =>
    db.posts.insert({ authorId, body: `${audience} ${minute}`, audience, publishedAt: at(minute) });
  // Visible to the viewer, oldest first: a friend's friends-only post, then their own private one.
  await write(friend.id, 'friends', 0);
  await write(me.id, 'private', 1);
  // Newer, and every one hidden from THIS viewer: a block beats public, a stranger's friends-only
  // post, a friend's private note. The 3x over-fetch read 6 rows for a page of 2 and served none.
  for (let minute = 10; minute < 13; minute += 1) {
    await write(blocker.id, 'public', minute);
    await write(stranger.id, 'friends', minute);
    await write(friend.id, 'private', minute);
  }

  let posts = 0;
  let items: Awaited<ReturnType<typeof feedForPage>> = [];
  {
    using statements = await testStatements();
    items = await feedForPage(viewer, 2);
    posts = statements.all().filter((each) => each.attribution?.entity === 'posts').length;
  }

  // The whole visibility rule is in the ONE posts statement — no over-fetch, no second page.
  expect(posts).toBe(1);
  const everyPost = await db.posts.orderBy('publishedAt', 'desc').orderBy('id').limit(1_000).all();
  const expected = everyPost.filter((row) => canSeePost(viewer, row)).slice(0, 2);
  expect(items.map((item) => item.post.body)).toEqual(['private 1', 'friends 0']);
  expect(items.map((item) => item.post.id)).toEqual(expected.map((row) => row.id));
});

/** Every value a tree would bind: one per leaf, one per member of an `in` list. */
const boundValues = (node: unknown): number => {
  if (Array.isArray(node)) return node.reduce((sum: number, each) => sum + boundValues(each), 0);
  if (typeof node !== 'object' || node === null) return 0;
  const record = node as Record<string, unknown>;
  if ('or' in record) return boundValues(record['or']);
  if ('and' in record) return boundValues(record['and']);
  if ('via' in record) return boundValues(record['where']);
  return Array.isArray(record['value']) ? record['value'].length : 1;
};

test('the statement binds a bounded number of values, however many friends and blocks a viewer has', () => {
  const ids = (n: number, tag: string) =>
    Array.from(
      { length: n },
      (_, i) => `00000000-0000-4000-8000-${tag}${String(i).padStart(10, '0')}`,
    );
  const viewer = (friends: number, blocked: number) =>
    viewerActor({
      id: '00000000-0000-4000-8000-0000000000f9',
      role: 'member',
      friendIds: ids(friends, 'aa'),
      blockedIds: ids(blocked, 'bb'),
    });
  // Friends are a hop into `friendships`: none of them is a parameter.
  expect(boundValues(visibleTo(viewer(70_000, 0)))).toBe(boundValues(visibleTo(viewer(1, 0))));
  // Blocks are an exclusion the tree cannot say as a hop: bounded at the documented cap.
  expect(boundValues(visibleTo(viewer(1, 70_000)))).toBeLessThanOrEqual(
    boundValues(visibleTo(viewer(1, 0))) + MAX_BLOCKS_IN_STATEMENT,
  );
});
