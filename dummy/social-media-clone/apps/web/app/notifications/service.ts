// Business logic for the inbox, composed from the repo. A page calls this; it never calls the repo
// and it never sees `db`.

import type { Notification } from './repo';
import * as repo from './repo';

export interface Inbox {
  readonly items: readonly Notification[];
  /**
   * Derived from the rows, never stored and never incremented. `readAt === null` is the whole
   * definition of unread, in one place, so the badge and the list can never disagree — which is
   * also what makes the offline twin (`markNotificationsRead.local`) safe to replay.
   */
  readonly unread: number;
}

export const inboxFor = async (userId: string): Promise<Inbox> => ({
  items: await repo.inboxPage(userId),
  // Counted in the database rather than from `items`: the page is bounded, so counting the page
  // would report "50" forever once the fifty-first unread row arrived.
  unread: await repo.unreadCount(userId),
});

/** The badge on its own, for a surface that renders the count without the list. */
export const unreadFor = (userId: string): Promise<number> => repo.unreadCount(userId);
