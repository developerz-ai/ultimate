// Every read and write the notifications feature makes. No business rules here. Only this file and
// a query's `sql` may touch `db`.

import { db, type schema } from '@social-media-clone/db';

// Derived from the entity, never re-declared — see the note in app/messages/repo.ts for why this
// goes through `schema` rather than through the package's own type re-exports.
export type Notification = typeof schema.notifications.$row;

/** Bounded everywhere: the inbox is a page, never "everything since you signed up". */
export const INBOX_PAGE = 50;
/** One `markRead` call addresses at most a screenful — a batch is not a migration. */
export const MARK_READ_MAX = 50;

export type NotificationKind = Notification['kind'];

/**
 * One page of the inbox, newest first, `(createdAt desc, id)`. The tail key is unique, so the
 * order is total and a bounded page cannot drop or repeat a row at its boundary when two
 * notifications land in the same millisecond.
 */
export const inboxPage = (
  userId: string,
  limit: number = INBOX_PAGE,
): Promise<readonly Notification[]> =>
  db.notifications.where({ userId }).orderBy('createdAt', 'desc').orderBy('id').limit(limit).all();

/**
 * `where({ readAt: null })` is `readAt is null` in SQL — the entity layer maps an `eq` against
 * `null` to the null predicate (`packages/entity/src/pg-sql.ts:31`), so this counts the same rows
 * in memory and in Postgres.
 */
export const unreadCount = (userId: string): Promise<number> =>
  db.notifications.where({ userId, readAt: null }).count();

/**
 * The named rows that belong to `userId`. The `where` is the scope, not an optimisation: it is what
 * makes an id somebody else named simply absent, so no write can reach a row that is not the
 * caller's own.
 */
export const ownRows = (
  userId: string,
  ids: readonly string[],
): Promise<readonly Notification[]> =>
  ids.length === 0
    ? Promise.resolve([])
    : db.notifications
        .where({ userId })
        .andWhere('id', 'in', [...ids])
        .orderBy('id')
        .limit(MARK_READ_MAX)
        .all();

/**
 * Convergent on the server exactly as `local` is on the client: a row that already carries a
 * `readAt` is left alone, so replaying the same mutation never moves the timestamp and applying it
 * three times equals applying it once.
 */
export const markRead = async (
  userId: string,
  ids: readonly string[],
  at: Date,
): Promise<readonly Notification[]> => {
  const updated: Notification[] = [];
  for (const row of await ownRows(userId, ids)) {
    updated.push(row.readAt === null ? await db.notifications.update(row.id, { readAt: at }) : row);
  }
  return updated;
};

export interface NewNotification {
  readonly userId: string;
  readonly kind: NotificationKind;
  readonly actorId: string;
  readonly subjectId?: string | null;
}

export const insertNotification = (notification: NewNotification): Promise<Notification> =>
  db.notifications.insert(notification);
