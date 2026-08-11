// Who the request is acting as, in the shape a policy needs. Policies read this and nothing else,
// so authz cannot disagree between HTTP, live queries, jobs and MCP.
//
// The two Sets are the load-bearing part of this file. Visibility here is RELATIONAL — "a friend
// of the author", "someone who blocked me" — not a column comparison, and a policy predicate is
// synchronous because a live query re-evaluates one per subscriber per change. So the graph is
// resolved ONCE per request, into memory, and every predicate reads it for free. Resolving it
// inside a predicate would be one database round trip per row per connected client.

import { canModerate, type UserId, type UserRole } from '@social-media-clone/domain';

export interface Actor {
  readonly id: UserId;
  readonly role: UserRole;
  /** Accepted friendships only. Pending ones grant nothing. */
  readonly friendIds: ReadonlySet<UserId>;
  /**
   * Symmetric by construction: it holds everyone this actor blocked AND everyone who blocked
   * them, unioned at load time. A block is stored directionally but applied both ways, and
   * flattening it here is what stops every call site from having to remember that.
   */
  readonly blockedIds: ReadonlySet<UserId>;
}

/** Nobody is signed in. A real value, not `null` scattered through every predicate. */
export const anonymous = null;

export const isSignedIn = (actor: Actor | null): actor is Actor => actor !== null;

export const isSelf = (actor: Actor | null, userId: UserId): boolean =>
  isSignedIn(actor) && actor.id === userId;

export const isFriend = (actor: Actor | null, userId: UserId): boolean =>
  isSignedIn(actor) && actor.friendIds.has(userId);

/**
 * Either direction. Checked before every visibility decision, and first — a blocked pair must not
 * reach the audience ladder at all, or a `public` post would still be visible to someone who
 * blocked its author.
 */
export const isBlocked = (actor: Actor | null, userId: UserId): boolean =>
  isSignedIn(actor) && actor.blockedIds.has(userId);

export const isAdmin = (actor: Actor | null): boolean =>
  isSignedIn(actor) && canModerate(actor.role);
