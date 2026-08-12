// unit — no DB, no I/O, which is the whole point: these predicates are synchronous so a live query
// can re-evaluate one per subscriber per change. Every surface runs exactly what is tested here.
//
// The cases that matter are the denials. An allow that passes proves the happy path; a denial that
// passes proves the rule is the thing standing in the way, and each case below is built so that
// exactly one fact is wrong.

import { expect, test } from 'bun:test';
import { userId } from '@social-media-clone/domain';
import type { Actor } from '../../shared/actor';
import { viewerActor } from '../../shared/actor';
import { canSeePost, type PostRow } from './policy';

const ADA = userId('00000000-0000-4000-8000-00000000000a');
const BRUNO = userId('00000000-0000-4000-8000-00000000000b');
const MARA = userId('00000000-0000-4000-8000-00000000000c');

// Built by the app's ONE actor constructor, so a fact this rule reads is a fact production puts
// there — a literal would keep passing after the seam moved underneath it.
const actor = (
  id = ADA,
  friends: readonly ReturnType<typeof userId>[] = [],
  blocked: readonly ReturnType<typeof userId>[] = [],
): Actor => viewerActor({ id, role: 'member', friendIds: friends, blockedIds: blocked });

const post = (over: Partial<PostRow> = {}): PostRow => ({
  authorId: BRUNO,
  audience: 'public',
  deletedAt: null,
  ...over,
});

test('a public post is visible to anyone, including a signed-out reader', () => {
  expect(canSeePost(actor(), post())).toBe(true);
  expect(canSeePost(null, post())).toBe(true);
});

test('a friends-only post needs an ACCEPTED friendship, not merely a known name', () => {
  expect(canSeePost(actor(ADA, [BRUNO]), post({ audience: 'friends' }))).toBe(true);
  expect(canSeePost(actor(ADA, [MARA]), post({ audience: 'friends' }))).toBe(false);
  expect(canSeePost(null, post({ audience: 'friends' }))).toBe(false);
});

test('a private post is visible to its author and to nobody else', () => {
  expect(canSeePost(actor(BRUNO), post({ audience: 'private' }))).toBe(true);
  // A friend is still not the author — this is the case a `friends`-shaped rule would wave through.
  expect(canSeePost(actor(ADA, [BRUNO]), post({ audience: 'private' }))).toBe(false);
});

test('a block beats a PUBLIC audience — the specific rule wins over the general one', () => {
  // The regression this ordering exists to prevent: check the audience ladder first and a blocked
  // reader still sees every public post, because `public` answers "yes" before anyone asks about
  // the block. Both directions, because a block is stored one way and applied both.
  expect(canSeePost(actor(ADA, [], [BRUNO]), post())).toBe(false);
  expect(canSeePost(actor(ADA, [BRUNO], [BRUNO]), post({ audience: 'friends' }))).toBe(false);
});

test('a soft-deleted post is invisible to everyone, its author included', () => {
  const deleted = post({ deletedAt: new Date('2026-08-11T00:00:00Z') });
  expect(canSeePost(actor(BRUNO), deleted)).toBe(false);
  expect(canSeePost(actor(), deleted)).toBe(false);
});

test('the author always sees their own post, whatever its audience', () => {
  for (const audience of ['public', 'friends', 'private'] as const) {
    expect(canSeePost(actor(BRUNO), post({ audience }))).toBe(true);
  }
});
