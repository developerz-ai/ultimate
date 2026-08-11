// Who the request is acting as, in the shape a policy needs. Policies read this and nothing else,
// so authz cannot disagree between HTTP, live queries, jobs and MCP.
//
// The two Sets are the load-bearing part of this file. Visibility here is RELATIONAL — "a friend
// of the author", "someone who blocked me" — not a column comparison, and a policy predicate is
// synchronous because a live query re-evaluates one per subscriber per change. So the graph is
// resolved ONCE per request, into memory, and every predicate reads it for free. Resolving it
// inside a predicate would be one database round trip per row per connected client.

import { canModerate, type UserId, type UserRole } from '@social-media-clone/domain';
import { useContext } from '@ultimat3/core';

/**
 * The viewer rides on the request context as a service, NOT on `@ultimat3/core`'s `Actor`.
 *
 * That is a workaround, and worth naming. Core's `Actor` is closed — `{ kind, id, orgId, roles,
 * scopes }` — with no extension point, and a policy predicate receives exactly that. Roles and an
 * org id are enough when authorization is columnar ("same tenant?"). They cannot express
 * "a friend of the author", because a friend set is not derivable from a role. And a predicate is
 * synchronous by contract, so it cannot go and fetch one either.
 *
 * So the graph is resolved once per request into this service and read from memory inside the
 * predicate. The cost is that a rule reads the viewer from the context instead of from the `actor`
 * argument it was handed — the argument is real, it is just not the whole story. The framework fix
 * is a typed extension seam on `Actor`, the same module-augmentation trick `CtxServices` and
 * `PermissionRegistry` already use.
 */
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

/** What `ctx.session` is. Installed once per request, where the request is resolved. */
export interface SessionService {
  viewer(): Actor | null;
}

declare module '@ultimat3/core' {
  interface CtxServices {
    readonly session: SessionService;
  }
}

/**
 * The viewer, read synchronously from the request context. This is what a policy predicate calls;
 * see the note on `Actor` for why it does not use the predicate's own `actor` argument.
 */
export const currentViewer = (): Actor | null => useContext().session.viewer();
