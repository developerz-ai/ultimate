// The inbox, as a declared read — what the inbox channel's client re-reads after a `replay-gap`.
// Same page `inboxFor` renders, `(createdAt desc, id)` so the order is total, and the bound is a
// constant for the reason `messages/live.ts` gives: a client-chosen bound is a client-chosen budget.
//
// `t` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.

import { from, query, t } from '@ultimat3/query';
import { notificationRead } from './policy';
import type { Notification } from './repo';
import * as repo from './repo';

export const inbox = query({
  input: t.object({ userId: t.uuid }),
  policy: notificationRead,
  sql: ({ userId }) =>
    from<Notification>('notifications', () => repo.inboxPage(userId))
      .where({ userId })
      .orderBy('createdAt', 'desc')
      .orderBy('id')
      .limit(repo.INBOX_PAGE),
});
