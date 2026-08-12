// unit — the actor's graph predicates. These run inside synchronous policy predicates, once per
// subscriber per change on a live query, so they must stay pure set lookups with no I/O.
//
// Every case reads the facts off the ACTOR ARGUMENT. That is the property under test as much as
// the answers are: a predicate that reached for ambient state would pass here and deny on a sync
// node, which is exactly how this app shipped an authorization chain wired only to its own tests.

import { userId } from '@social-media-clone/domain';
import { anonymousActor, userActor } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';
import type { Actor } from './actor';
import { isAdmin, isBlocked, isFriend, isSelf, isSignedIn, viewerActor } from './actor';

const ADA = userId('00000000-0000-4000-8000-00000000000a');
const BRUNO = userId('00000000-0000-4000-8000-00000000000b');

const ada: Actor = viewerActor({ id: ADA, role: 'member', friendIds: [BRUNO] });

unitTest('an anonymous reader is signed out, is nobody, and is friends with nobody', () => {
  expect(isSignedIn(null)).toBe(false);
  expect(isSelf(null, ADA)).toBe(false);
  expect(isFriend(null, BRUNO)).toBe(false);
  // Not blocked either — "no relationship" must not read as "blocked", or a signed-out visitor
  // would be refused every public post.
  expect(isBlocked(null, BRUNO)).toBe(false);
  expect(isAdmin(null)).toBe(false);
});

unitTest('the anonymous actor is "nobody" too, not a signed-in stranger', () => {
  // The pipeline's auth stage turns a null authenticator answer into `anonymousActor()`, so a page
  // reading `ctx.actor` gets a real object where a predicate gets `null`. Both have to mean the
  // same thing, or a route would be public to whoever the anonymous actor's id happens to be.
  const nobody = anonymousActor();
  expect(isSignedIn(nobody)).toBe(false);
  expect(isSelf(nobody, nobody.id)).toBe(false);
  expect(isAdmin(nobody)).toBe(false);
});

unitTest('friendship is exactly the accepted set, and is not self-implied', () => {
  expect(isFriend(ada, BRUNO)).toBe(true);
  expect(isFriend(ada, ADA)).toBe(false);
  expect(isSelf(ada, ADA)).toBe(true);
});

unitTest('the blocked set is already symmetric, so callers never check two directions', () => {
  // The set is unioned at load time from both directions. A caller that had to remember to check
  // the reverse is a caller that will forget in exactly one policy.
  const blocked = viewerActor({ id: ADA, role: 'member', blockedIds: [BRUNO] });
  expect(isBlocked(blocked, BRUNO)).toBe(true);
  expect(isBlocked(ada, BRUNO)).toBe(false);
});

unitTest('an UNRESOLVED fact denies — an absent fact is not a satisfied one', () => {
  // A job runner, a test and an MCP token exchange all mint actors that resolved no graph. Reading
  // through `actorFact` makes that `undefined`, and every predicate here has to answer false to it
  // rather than throw or wave it through.
  const unresolved = userActor({ id: ADA, roles: ['member'] });
  expect(isSignedIn(unresolved)).toBe(true);
  expect(isFriend(unresolved, BRUNO)).toBe(false);
  expect(isBlocked(unresolved, BRUNO)).toBe(false);
});

unitTest('moderation is a role on the actor, not a permission granted per row', () => {
  expect(isAdmin(ada)).toBe(false);
  expect(isAdmin(viewerActor({ id: ADA, role: 'admin' }))).toBe(true);
  // A role nobody declared moderates nothing: `canModerate` over the closed set is the one rule.
  expect(isAdmin(userActor({ id: ADA, roles: ['superuser'] }))).toBe(false);
});
