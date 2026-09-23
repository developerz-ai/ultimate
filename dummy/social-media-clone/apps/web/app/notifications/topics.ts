// The inbox channel: one per user, and who may join it.
//
// A notification is addressed to exactly one person, so the channel is keyed by the user id and the
// rule is an identity comparison on the params — no row to load, the fact is the params themselves.
// A committed `notifications` row reaches its owner as a record, routed by its own `userId`.

import { schema } from '@social-media-clone/db';
import { can } from '@ultimat3/policy';
import { channel } from '@ultimat3/realtime';
import { inbox } from './live';

/**
 * Your own inbox and nobody else's. An admin is not exempted: `admin:read` is a moderation grant
 * over content, not a licence to watch a person's notifications arrive in real time.
 */
export const ownInbox = can<{ readonly userId?: string }>(
  'notification:read',
  ({ actor, input }) => actor !== null && input.userId === actor.id,
);

export const inboxChannel = channel('notifications', {
  params: ['userId'],
  policy: ownInbox,
  catchUp: inbox,
  records: [schema.notifications],
});
