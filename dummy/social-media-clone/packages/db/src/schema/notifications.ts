// Something that happened to you. Denormalised on purpose: a notification records what it said at
// the time, so deleting the post it points at leaves the row readable rather than dangling.

import { entity, enumerated, timestamp, uuid } from '@ultimat3/entity';
import { users } from './users';

export const NOTIFICATION_KINDS = [
  'friend-request',
  'friend-accepted',
  'post-liked',
  'post-commented',
  'message',
] as const;

export const notifications = entity('notifications', {
  columns: {
    id: uuid().primaryKey(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    kind: enumerated(NOTIFICATION_KINDS),
    actorId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    /** The post, message or friendship this is about. Untyped by design — the kind says which. */
    subjectId: uuid().nullable(),
    readAt: timestamp().nullable(),
    createdAt: timestamp().defaultNow(),
  },
  // The unread badge wants a PARTIAL index on `readAt IS NULL` — the query that runs on every
  // page load. The invariant DSL cannot express it: ColumnExpr has eq/matches/atLeast/isTrue and
  // no null predicate, so there is no way to say `IS NULL` in a `where`. Full index for now, and
  // the gap is recorded rather than worked around with raw SQL that would drift from the entity.
  indexes: [{ on: ['userId', 'createdAt'], order: 'desc' }],
});

export type Notification = typeof notifications.$row;
