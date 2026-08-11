// unit — the actor's graph predicates. These run inside synchronous policy predicates, once per
// subscriber per change on a live query, so they must stay pure set lookups with no I/O.

import { userId } from '@social-media-clone/domain';
import { expect, unitTest } from '@ultimat3/testing';
import { type Actor, isAdmin, isBlocked, isFriend, isSelf, isSignedIn } from './actor';

const ADA = userId('00000000-0000-4000-8000-00000000000a');
const BRUNO = userId('00000000-0000-4000-8000-00000000000b');

const ada: Actor = {
  id: ADA,
  role: 'member',
  friendIds: new Set([BRUNO]),
  blockedIds: new Set(),
};

unitTest('an anonymous reader is signed out, is nobody, and is friends with nobody', () => {
  expect(isSignedIn(null)).toBe(false);
  expect(isSelf(null, ADA)).toBe(false);
  expect(isFriend(null, BRUNO)).toBe(false);
  // Not blocked either — "no relationship" must not read as "blocked", or a signed-out visitor
  // would be refused every public post.
  expect(isBlocked(null, BRUNO)).toBe(false);
  expect(isAdmin(null)).toBe(false);
});

unitTest('friendship is exactly the accepted set, and is not self-implied', () => {
  expect(isFriend(ada, BRUNO)).toBe(true);
  expect(isFriend(ada, ADA)).toBe(false);
  expect(isSelf(ada, ADA)).toBe(true);
});

unitTest('the blocked set is already symmetric, so callers never check two directions', () => {
  // The set is unioned at load time from both directions. A caller that had to remember to check
  // the reverse is a caller that will forget in exactly one policy.
  const blocked: Actor = { ...ada, blockedIds: new Set([BRUNO]) };
  expect(isBlocked(blocked, BRUNO)).toBe(true);
  expect(isBlocked(ada, BRUNO)).toBe(false);
});

unitTest('moderation is a role, not a permission granted per row', () => {
  expect(isAdmin(ada)).toBe(false);
  expect(isAdmin({ ...ada, role: 'admin' })).toBe(true);
});
