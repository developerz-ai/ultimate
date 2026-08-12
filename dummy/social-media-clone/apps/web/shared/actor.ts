// Who the request is acting as, in the shape a policy needs. There is ONE actor — the framework's
// own — and every rule reads it from the argument it is handed, so authz cannot disagree between
// HTTP, live queries, jobs and MCP.
//
// The two Sets are the load-bearing part of this file. Visibility here is RELATIONAL — "a friend
// of the author", "someone who blocked me" — not a column comparison, and a policy predicate is
// synchronous because a live query re-evaluates one per subscriber per change. So the graph is
// resolved ONCE per request, into the actor, and every predicate reads it for free.

import { canModerate, USER_ROLES, type UserRole } from '@social-media-clone/domain';
import type { Actor } from '@ultimat3/core';
import { actorFact, isAnonymous, useContext, userActor } from '@ultimat3/core';

/**
 * This app's authz facts, declared once on core's extension seam.
 *
 * They ride on the same `Actor` every surface already hands the policy layer, which is what makes
 * a relational rule work identically in a page render, a live query, a job and an MCP tool without
 * a second place to ask "who is the viewer?". Reading them through `actorFact()` is what makes an
 * unresolved fact `undefined` — a denial by construction — rather than a silent `false`.
 */
declare module '@ultimat3/core' {
  interface ActorFacts {
    /** Accepted friendships only. Pending ones grant nothing. */
    readonly friendIds: ReadonlySet<string>;
    /**
     * Symmetric by construction: everyone this actor blocked AND everyone who blocked them,
     * unioned at load time. A block is stored directionally but applied both ways, and flattening
     * it here is what stops every call site from having to remember that.
     */
    readonly blockedIds: ReadonlySet<string>;
  }
}

export type { Actor };

export interface ViewerInit {
  readonly id: string;
  readonly role: UserRole;
  readonly friendIds?: Iterable<string> | undefined;
  readonly blockedIds?: Iterable<string> | undefined;
}

/**
 * The one constructor for a signed-in actor of this app — `app/auth/viewer.ts` in production and
 * every test fixture alike. A hand-built object literal would be a second answer to "what carries
 * the graph", and the first thing to drift when a fact is added.
 *
 * `roles: [role]` and not a bare `role` field: `@ultimat3/policy` expands `actor.roles` into the
 * permission set, so the column IS the grant, with no mapping table in between.
 */
export const viewerActor = (init: ViewerInit): Actor =>
  userActor({
    id: init.id,
    roles: [init.role],
    facts: {
      friendIds: new Set(init.friendIds ?? []),
      blockedIds: new Set(init.blockedIds ?? []),
    },
  });

/**
 * `null` is "nobody" everywhere in this app, because that is what a policy predicate is handed:
 * `@ultimat3/action`'s `actorOf` maps core's anonymous actor onto `null` before any rule runs. A
 * reader that gets the raw context actor has to make the same collapse, hence the second check.
 */
export const isSignedIn = (actor: Actor | null): actor is Actor =>
  actor !== null && !isAnonymous(actor);

export const isSelf = (actor: Actor | null, userId: string): boolean =>
  isSignedIn(actor) && actor.id === userId;

export const isFriend = (actor: Actor | null, userId: string): boolean =>
  actorFact(actor, 'friendIds')?.has(userId) ?? false;

/**
 * Either direction. Checked before every visibility decision, and first — a blocked pair must not
 * reach the audience ladder at all, or a `public` post would still be visible to someone who
 * blocked its author.
 */
export const isBlocked = (actor: Actor | null, userId: string): boolean =>
  actorFact(actor, 'blockedIds')?.has(userId) ?? false;

/** Derived from `canModerate` over the closed role set, so moderation has one definition. */
const MODERATOR_ROLES: readonly string[] = USER_ROLES.filter(canModerate);

export const isAdmin = (actor: Actor | null): boolean =>
  isSignedIn(actor) && actor.roles.some((role) => MODERATOR_ROLES.includes(role));

/**
 * The viewer of the request being rendered, for a PAGE — a rule reads its own `actor` argument and
 * never this. It is `@ultimat3/action`'s `actorOf` spelled against core alone: `shared/` sits in
 * `site/`'s import graph, and the static path does not pay for tier 3 to answer a question core
 * already holds the answer to.
 */
export const currentViewer = (): Actor | null => {
  const actor = useContext().actor;
  return isAnonymous(actor) ? null : actor;
};
