// unit — against the demo seed, which exists precisely because it carries every visibility case:
// a friends-only post, a public post by a blocked author, a soft-deleted row and a private note.
//
// Read-only on the seed's rows. These are the cases where a leak is silent: nothing throws when a
// friends-only post appears on an anonymous page, it just appears. The last test writes an author
// of its own, to show hidden posts never shorten an anonymous page.

import { afterAll, expect, test } from 'bun:test';
import { db, driver, seedDemo } from '@social-media-clone/db';
import { userId } from '@social-media-clone/domain';
import { seedId } from '@ultimat3/entity';
import { testStatements } from '@ultimat3/testing';
import type { Actor } from '../../shared/actor';
import { viewerActor } from '../../shared/actor';
import { publicProfile } from './service';

const idOf = (label: string): string => seedId(label);

const actor = (
  id: string,
  friends: readonly string[] = [],
  blocked: readonly string[] = [],
): Actor =>
  viewerActor({ id: userId(id), role: 'member', friendIds: friends, blockedIds: blocked });

await seedDemo();

// The author and posts the last test writes are this file's alone, and the store is process-wide: a
// second load of this file (`bun test --rerun-each`) would insert the same handle again.
afterAll(() => {
  driver.reset?.();
});

const bodiesOf = async (viewer: Actor | null, handle: string): Promise<readonly string[]> => {
  const profile = await publicProfile(viewer, handle);
  expect(profile).not.toBeNull();
  return (profile?.posts ?? []).map((post) => post.body);
};

test('an ANONYMOUS reader of /u/ada does not see her friends-audience post', async () => {
  const bodies = await bodiesOf(null, 'ada');

  // The audience ladder answers `public` and nothing else for a null viewer. The read asks for
  // live public rows, and `canSeePost` still decides every one of them.
  expect(bodies.some((body) => body.startsWith('Visibility here is relational'))).toBe(true);
  expect(bodies.some((body) => body.startsWith('Friends-only'))).toBe(false);
});

test("ada's friend DOES see it — the same page, the same rule, a different viewer", async () => {
  const friend = actor(idOf('user:user'), [idOf('user:ada')]);
  const bodies = await bodiesOf(friend, 'ada');
  expect(bodies.some((body) => body.startsWith('Friends-only'))).toBe(true);
});

test('a BLOCKED pair hides each other on the profile, in both directions', async () => {
  // Mara blocked the demo user. `blockedIds` is symmetric by construction, so one seeded row
  // hides Mara from the user AND the user from Mara.
  const user = actor(idOf('user:user'), [], [idOf('user:mara')]);
  expect(await bodiesOf(user, 'mara')).toEqual([]);

  const mara = actor(idOf('user:mara'), [], [idOf('user:user')]);
  expect(await bodiesOf(mara, 'user')).toEqual([]);

  // And the block beats a PUBLIC audience: an anonymous stranger still sees Mara's post, because
  // she blocked one person and not the public. If this ever flipped, the ordering in `canSeePost`
  // would have regressed from "specific rule wins" to "audience ladder wins".
  expect(await bodiesOf(null, 'mara')).toHaveLength(1);
});

test('a soft-deleted post is on nobody profile, its author included', async () => {
  const bruno = actor(idOf('user:bruno'));
  const bodies = await bodiesOf(bruno, 'bruno');
  expect(bodies.some((body) => body.startsWith('Soft-deleted'))).toBe(false);
});

test('an unknown handle is null, not an empty profile', async () => {
  expect(await publicProfile(null, 'nobody')).toBeNull();
});

test('a SUSPENDED account has no public profile — the same answer as a handle nobody holds', async () => {
  // The admin's one lever is `suspended: true`, and until 2026-08 it stopped the account acting and
  // left its profile, bio and posts served to anonymous readers. Restored in a `finally`: the seed
  // is shared with every test in this file and the next.
  await db.users.update(idOf('user:kenji'), { suspended: true });
  try {
    expect(await publicProfile(null, 'kenji')).toBeNull();
    // Not even to a friend, and not to the account itself: suspension is not a visibility rule with
    // an audience, it is the account being switched off.
    expect(await publicProfile(actor(idOf('user:user'), [idOf('user:kenji')]), 'kenji')).toBeNull();
  } finally {
    await db.users.update(idOf('user:kenji'), { suspended: false });
  }
  expect(await publicProfile(null, 'kenji')).not.toBeNull();
});

test('hidden posts newer than every public one never shorten an anonymous page — it reads exactly it', async () => {
  const author = await db.users.insert({
    handle: 'profile_hider',
    email: 'profile_hider@fixture.example',
    displayName: 'profile_hider',
    role: 'member',
  });
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
  // Two public posts, then ten the anonymous rule hides, all newer: the 3x over-fetch this replaced
  // read 6 rows for a page of 2, every one of them hidden, and served none.
  for (const minute of [0, 1]) {
    await db.posts.insert({
      authorId: author.id,
      body: `public ${minute}`,
      publishedAt: at(minute),
    });
  }
  for (let index = 0; index < 10; index += 1) {
    await db.posts.insert({
      authorId: author.id,
      body: `hidden ${index}`,
      audience: index % 2 === 0 ? 'friends' : 'private',
      publishedAt: at(10 + index),
    });
  }

  let sent = 0;
  let profile: Awaited<ReturnType<typeof publicProfile>> = null;
  {
    using statements = await testStatements();
    profile = await publicProfile(null, 'profile_hider', 2);
    sent = statements.count();
  }

  // The account and its page: two statements, whatever share of the timeline is hidden.
  expect(sent).toBe(2);
  expect(profile?.posts.map((post) => post.body)).toEqual(['public 1', 'public 0']);
});

test('a FRIEND’s page is exact too: newer private notes never shorten it, in two statements', async () => {
  const author = await db.users.insert({
    handle: 'profile_friend_of',
    email: 'profile_friend_of@fixture.example',
    displayName: 'profile_friend_of',
    role: 'member',
  });
  const at = (minute: number) => new Date(Date.UTC(2026, 1, 1, 0, minute));
  await db.posts.insert({
    authorId: author.id,
    body: 'for friends',
    audience: 'friends',
    publishedAt: at(0),
  });
  await db.posts.insert({
    authorId: author.id,
    body: 'for all',
    audience: 'public',
    publishedAt: at(1),
  });
  for (let minute = 10; minute < 20; minute += 1) {
    await db.posts.insert({
      authorId: author.id,
      body: `note ${minute}`,
      audience: 'private',
      publishedAt: at(minute),
    });
  }
  const friend = actor(idOf('user:user'), [author.id]);

  let sent = 0;
  let profile: Awaited<ReturnType<typeof publicProfile>> = null;
  {
    using statements = await testStatements();
    profile = await publicProfile(friend, 'profile_friend_of', 2);
    sent = statements.count();
  }

  expect(sent).toBe(2);
  expect(profile?.posts.map((post) => post.body)).toEqual(['for all', 'for friends']);
});
