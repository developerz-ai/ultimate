// unit — against the demo seed, which exists precisely because it carries every visibility case:
// a friends-only post, a public post by a blocked author, a soft-deleted row and a private note.
//
// Read-only on purpose. These are the cases where a leak is silent: nothing throws when a
// friends-only post appears on an anonymous page, it just appears.

import { expect, test } from 'bun:test';
import { seedDemo } from '@social-media-clone/db';
import { userId } from '@social-media-clone/domain';
import { seedId } from '@ultimat3/entity';
import type { Actor } from '../../shared/actor';
import { publicProfile } from './service';

const idOf = (label: string): string => seedId(label);

const actor = (
  id: string,
  friends: readonly string[] = [],
  blocked: readonly string[] = [],
): Actor => ({
  id: userId(id),
  role: 'member',
  friendIds: new Set(friends),
  blockedIds: new Set(blocked),
});

await seedDemo();

const bodiesOf = async (viewer: Actor | null, handle: string): Promise<readonly string[]> => {
  const profile = await publicProfile(viewer, handle);
  expect(profile).not.toBeNull();
  return (profile?.posts ?? []).map((post) => post.body);
};

test('an ANONYMOUS reader of /u/ada does not see her friends-audience post', async () => {
  const bodies = await bodiesOf(null, 'ada');

  // The audience ladder answers `public` and nothing else for a null viewer — and it does so
  // without a `where audience = 'public'` anywhere, which is the whole point.
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
