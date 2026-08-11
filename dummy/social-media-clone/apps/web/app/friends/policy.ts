// Authorization for the social graph. Every rule is declared once here and evaluated identically by
// the friends screen, the HTTP route, the typed client, the MCP tool and admin. There is no second
// door, and there is no `WHERE` clause anywhere that repeats one of these sentences.
//
// The predicates are SYNCHRONOUS, like every other predicate in this app: a live query re-evaluates
// one per subscriber on every change. So each rule decides on the actor (which carries the resolved
// friend and block sets) plus a row the SURFACE loaded — never on something it goes and fetches.

import { can, definePermissions } from '@ultimat3/policy';
import { currentViewer, isBlocked, isSelf, isSignedIn } from '../../shared/actor';

/**
 * Declared rather than assumed, so a typo is a build error instead of a rule that silently never
 * matches. `definePermissions()` is the same set at runtime and runs before any `can()` below.
 */
declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'friend:read': true;
    'friend:request': true;
    'friend:respond': true;
    'block:create': true;
    'block:delete': true;
  }
}

export const friendPermissions = definePermissions([
  'friend:read',
  'friend:request',
  'friend:respond',
  'block:create',
  'block:delete',
]);

/** The only fact a person-level rule decides about. Loaded by the surface, never fetched in a rule. */
export interface PersonRow {
  readonly id: string;
}

/** The row facts a friendship rule decides about. `respondedAt` is not one of them — status is. */
export interface FriendshipRow {
  readonly requesterId: string;
  readonly addresseeId: string;
  readonly status: 'pending' | 'accepted' | 'declined';
}

export interface BlockRow {
  readonly blockerId: string;
  readonly blockedId: string;
}

/**
 * Who may be asked. A block is checked in BOTH directions and before anything else, for the same
 * reason it beats the audience ladder in `canSeePost`: "not you specifically" has to win over any
 * general rule, or the person who blocked you can still be pulled into your inbox.
 */
export const canRequestFriendship = (
  actor: Parameters<typeof isBlocked>[0],
  targetId: string,
): boolean => isSignedIn(actor) && !isSelf(actor, targetId) && !isBlocked(actor, targetId);

/**
 * Only the ADDRESSEE answers. Direction is the whole rule: the requester holding `friend:respond`
 * must not be able to accept their own request, which is exactly what a symmetric "either party"
 * check would wave through.
 *
 * `declined` is answerable and `accepted` is not, deliberately. The pair gets ONE row — the mirror
 * is refused at the write — so if a declined row could never be answered again, a pair whose only
 * row is a no could never become friends by any sequence of calls. Changing a no to a yes keeps the
 * requester, the direction and the invariant (`respondedAt` stays non-null); re-accepting an
 * accepted row would be a write with nothing to change.
 */
export const canRespondToRequest = (
  actor: Parameters<typeof isSelf>[0],
  row: FriendshipRow,
): boolean => isSelf(actor, row.addresseeId) && row.status !== 'accepted';

/** Only the person who placed a block may lift it. Being the blocked party is not a grant. */
export const canRemoveBlock = (actor: Parameters<typeof isSelf>[0], row: BlockRow): boolean =>
  isSelf(actor, row.blockerId);

/**
 * The screen. Input-only: it is built from the actor's own id and shows nobody else's inbox, so
 * being signed in with the grant answers the question in full and there is no row to load.
 */
export const friendRead = can('friend:read');

/**
 * `row === null` is a DENIAL on every rule below, never a pass. An absent fact is not a satisfied
 * one: treating it as one hands anyone holding the grant a way to skip the row check entirely, by
 * reaching a surface that passes no row.
 */
export const friendRequest = can<Record<string, never>, PersonRow>(
  'friend:request',
  ({ row }) => row !== null && canRequestFriendship(currentViewer(), row.id),
);

export const friendRespond = can<Record<string, never>, FriendshipRow>(
  'friend:respond',
  ({ row }) => row !== null && canRespondToRequest(currentViewer(), row),
);

/** Blocking needs no friendship and no relationship — only a real person who is not yourself. */
export const blockCreate = can<Record<string, never>, PersonRow>(
  'block:create',
  ({ row }) => row !== null && isSignedIn(currentViewer()) && !isSelf(currentViewer(), row.id),
);

export const blockDelete = can<Record<string, never>, BlockRow>(
  'block:delete',
  ({ row }) => row !== null && canRemoveBlock(currentViewer(), row),
);
