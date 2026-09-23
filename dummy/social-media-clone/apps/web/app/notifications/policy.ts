// Authorization for notifications. A notification is addressed to exactly one person, so the rule
// is ownership and nothing else — no audience ladder, no friendship, no block.
//
// Both rules decide on the actor alone, and for the write that is the shape of the call rather than
// a gap: `markNotificationsRead` takes a BATCH of ids, and a row-level policy decides about one row
// (a mutator can carry `row` since 2026-09-23, as an action always could). Ownership is therefore
// enforced by the SCOPE of the write — every update in `repo.markRead` is keyed by `userId`, so an
// id belonging to somebody else is not found and not written. One decision plus a scoped write,
// never a second authz path.

import { can, definePermissions } from '@ultimat3/policy';

declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'notification:read': true;
    'notification:mark-read': true;
  }
}

export const notificationPermissions = definePermissions([
  'notification:read',
  'notification:mark-read',
]);

/**
 * Your own inbox. There is no surface that takes a notification id and reads it back, so there is
 * no row for a rule to decide about — the page reads `inboxFor(actor.id)` and the scope IS the
 * actor. A row-level predicate here would be a rule with nothing to run on.
 */
export const notificationRead = can('notification:read');

/** Same shape, same reason. The batch's effect is bounded by the actor, not by the rule. */
export const notificationMarkRead = can('notification:mark-read');
