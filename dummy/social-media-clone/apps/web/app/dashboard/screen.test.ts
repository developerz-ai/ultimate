// unit — the dashboard's read model over the seeded graph. The friends screen is the oracle for the
// connection counts (one partition, two screens that must agree), `canSeePost` for what the chart
// and the table may include, and the window must end on the newest post the viewer can see.

import { beforeAll, expect, test } from 'bun:test';
import { seedDemo } from '@social-media-clone/db';
import { seedId } from '@ultimat3/entity';
import type { Actor } from '../../shared/actor';
import { viewerActor } from '../../shared/actor';
import { userById } from '../auth/repo';
import { actorFor } from '../auth/viewer';
import { friendsScreen } from '../friends/screen';
import { ACTIVITY_DAYS, dashboardScreen, dayKeys, perDay, TOP_POSTS } from './screen';

const NOW = new Date('2026-10-05T12:00:00.000Z');

let viewer: Actor;

beforeAll(async () => {
  await seedDemo();
  const user = await userById(seedId('user:user'));
  if (user === null) return expect.unreachable('the seed writes user:user');
  viewer = await actorFor(user);
});

test('the connection counts are the friends screen’s own partition, counted', async () => {
  const [screen, friends] = await Promise.all([
    dashboardScreen(viewer, NOW),
    friendsScreen(viewer.id),
  ]);
  expect(screen.connections).toEqual({
    friends: friends.friends.length,
    incoming: friends.incoming.length,
    outgoing: friends.outgoing.length,
    declined: friends.declined.length,
  });
  expect(screen.stats.friends).toBe(friends.friends.length);
  expect(screen.stats.waiting).toBe(friends.incoming.length);
});

test('the viewer’s own figures: posts not deleted, and the likes those posts hold', async () => {
  const screen = await dashboardScreen(viewer, NOW);
  expect(screen.stats.posts).toBe(1);
  expect(screen.stats.likes).toBe(0);
});

test('the table holds only posts canSeePost lets this viewer read, most-liked first', async () => {
  const screen = await dashboardScreen(viewer, NOW);
  expect(screen.top.length).toBeGreaterThan(0);
  expect(screen.top.length).toBeLessThanOrEqual(TOP_POSTS);
  const ids = screen.top.map((post) => post.id);
  // Mara blocked the viewer, and a deleted post is invisible to everyone.
  expect(ids).not.toContain(seedId('post:blocked-author'));
  expect(ids).not.toContain(seedId('post:deleted'));
  const likes = screen.top.map((post) => post.likes);
  expect(likes).toEqual([...likes].sort((left, right) => right - left));
  for (const post of screen.top) expect(post.authorHandle).not.toBe('');
});

test('the window is fourteen UTC days ending on the newest visible post, quiet days included', async () => {
  const screen = await dashboardScreen(viewer, NOW);
  expect(screen.activity.keys).toHaveLength(ACTIVITY_DAYS);
  expect(screen.activity.posts).toHaveLength(ACTIVITY_DAYS);
  expect(screen.activity.likes).toHaveLength(ACTIVITY_DAYS);
  // The newest post the viewer can see was published on 03-14 (their own).
  expect(screen.activity.keys.at(-1)).toBe('03-14');
  expect(screen.activity.posts.at(-1)).toBeGreaterThan(0);
  expect(screen.activity.likes.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
});

test('a stranger with no posts and no relationships gets zeros, not an error', async () => {
  const stranger = viewerActor({ id: '00000000-0000-4000-8000-00000000f00d', role: 'member' });
  const screen = await dashboardScreen(stranger, NOW);
  expect(screen.stats).toEqual({ posts: 0, likes: 0, friends: 0, waiting: 0 });
  expect(screen.connections).toEqual({ friends: 0, incoming: 0, outgoing: 0, declined: 0 });
});

test('perDay buckets by UTC day and dayKeys names them, oldest first', () => {
  const end = new Date('2026-03-14T08:00:00.000Z');
  expect(dayKeys(end, 3)).toEqual(['03-12', '03-13', '03-14']);
  const stamps = [
    new Date('2026-03-14T23:59:00.000Z'),
    new Date('2026-03-12T00:00:00.000Z'),
    new Date('2026-03-11T23:59:59.999Z'),
    new Date('2026-03-15T00:00:00.000Z'),
  ];
  expect(perDay(stamps, end, 3)).toEqual([1, 0, 1]);
});
