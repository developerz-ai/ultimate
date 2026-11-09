// Authorization for notifications. A notification is addressed to exactly one person, so the rule
// is ownership and nothing else — no audience ladder, no friendship, no block.
//
// The read (`ownInbox`) decides on the params: the channel and its catch-up query are keyed by
// `userId`, so the rule compares it to the actor. The write decides on the actor alone, which is
// the shape of the call rather than a gap: `markNotificationsRead` takes a BATCH of ids, and a
// row-level policy decides about one row. Ownership is therefore enforced by the SCOPE of the
// write — every update in `repo.markRead` is keyed by `userId`, so an id belonging to somebody else
// is not found and not written. One decision plus a scoped write, never a second authz path.

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
 * Your own inbox and nobody else's, decided on `input.userId`: the `inbox` channel's subscribe AND
 * its catch-up read (`queries/inbox.ts`, served at `GET /_x/query/inbox` with the channel params as
 * input) — one object, so the read cannot be wider than the channel (plan 101 R9: it checked only
 * `notification:read` and served any member any user's inbox). An admin is not exempted:
 * `admin:read` is a moderation grant over content, not a licence to read a person's notifications.
 */
export const ownInbox = can<{ readonly userId?: string }>(
  'notification:read',
  ({ actor, input }) => actor !== null && input.userId === actor.id,
);

/**
 * Decides on the actor alone: the batch's effect is bounded by the actor's scoped write, not by the
 * rule (see the header).
 */
export const notificationMarkRead = can('notification:mark-read');
