// Authorization for posts. Every rule is defined once here and evaluated identically by the HTTP
// route, the typed client, the live subscription, the job runner, the MCP tool and admin. There is
// no second door.
//
// Predicates are SYNCHRONOUS, and that constraint is what everything else follows from: a live
// query re-evaluates one per subscriber on every change, so an `await` here would be a database
// round trip per row per connected client. A rule therefore decides on two things only — the actor
// (which carries the resolved friend and block sets) and facts the caller already had.

import { type Audience, isVisibleAudience } from '@social-media-clone/domain';
import { can, definePermissions } from '@ultimat3/policy';
import { currentViewer, isAdmin, isBlocked, isFriend, isSelf } from '../../shared/actor';

/**
 * Declared rather than assumed. The augmentation narrows `can()` to these strings, so a typo is a
 * build error instead of a rule that silently never matches; `definePermissions()` is the same set
 * at runtime and runs before any `can()` below.
 */
declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'post:create': true;
    'post:read': true;
    'post:delete': true;
    'post:like': true;
    'post:comment': true;
    'feed:read': true;
  }
}

export const postPermissions = definePermissions([
  'post:create',
  'post:read',
  'post:delete',
  'post:like',
  'post:comment',
  'feed:read',
]);

/** The row facts every post rule decides about. Loaded by the surface, never fetched in a rule. */
export interface PostRow {
  readonly authorId: string;
  readonly audience: Audience;
  readonly deletedAt: Date | null;
}

/**
 * The one rule everything else is built on, in the order the checks must happen.
 *
 * Blocks come FIRST and are checked in both directions. Putting the audience ladder first would
 * make a `public` post visible to someone who blocked its author — the ladder answers "is this
 * post for people like you", and a block says "not you specifically", so the specific rule has to
 * win. A deleted post is invisible to everyone including its author; the author reads it back
 * through the moderation path, not this one.
 */
export const canSeePost = (actor: Parameters<typeof isBlocked>[0], post: PostRow): boolean => {
  if (post.deletedAt !== null) return false;
  if (isBlocked(actor, post.authorId)) return false;
  if (isSelf(actor, post.authorId)) return true;
  return isVisibleAudience(post.audience, isFriend(actor, post.authorId));
};

/**
 * `row === null` is a DENIAL, never a pass. An absent fact is not a satisfied one: treating it as
 * one hands anyone holding `post:read` a way to skip the visibility check entirely, by reaching a
 * surface that passes no row.
 */
export const postRead = can<Record<string, never>, PostRow>(
  'post:read',
  ({ row }) => row !== null && canSeePost(currentViewer(), row),
);

/** Anyone signed in may post. There is no per-audience grant — the audience is on the row. */
export const postCreate = can('post:create');

/** Your own post, or a moderator's. Checked against the loaded row, never against an id alone. */
export const postDelete = can<Record<string, never>, PostRow>(
  'post:delete',
  ({ row }) => row !== null && (isSelf(currentViewer(), row.authorId) || isAdmin(currentViewer())),
);

/** You can only like or comment on what you could read. One rule, reused, so they cannot drift. */
export const postLike = can<Record<string, never>, PostRow>(
  'post:like',
  ({ row }) => row !== null && canSeePost(currentViewer(), row),
);

export const postComment = can<Record<string, never>, PostRow>(
  'post:comment',
  ({ row }) => row !== null && canSeePost(currentViewer(), row),
);

/**
 * The feed. `row === null` ALLOWS here, and unlike `postRead` that is deliberate rather than a
 * hole: the framework evaluates this once at subscribe time with no row, and again per delivered
 * row. At subscribe the question is only "may this actor read a feed at all", which being signed
 * in answers in full. The null branch grants nothing the per-row branch would not.
 */
export const feedRead = can<Record<string, never>, PostRow>('feed:read', ({ actor, row }) =>
  row === null ? actor !== null : canSeePost(currentViewer(), row),
);
