// The inbox channel: one per user, and who may join it.
//
// A notification is addressed to exactly one person, so the channel is keyed by the user id and the
// rule is an identity comparison on the params — no row to load, the fact is the params themselves.
// A committed `notifications` row reaches its owner as a record, routed by its own `userId`.

import { schema } from '@social-media-clone/db';
import { channel } from '@ultimat3/realtime';
import { ownInbox } from './policy';
import { inbox } from './queries/inbox';

export const inboxChannel = channel('notifications', {
  params: ['userId'],
  policy: ownInbox,
  catchUp: inbox,
  records: [schema.notifications],
});
