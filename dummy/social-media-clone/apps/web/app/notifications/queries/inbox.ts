// The inbox, as a declared read — what the inbox channel's client re-reads after a `replay-gap`.
// Same page `inboxFor` renders, `(createdAt desc, id)` so the order is total, and the bound is a
// constant for the reason `messages/live/` gives: a client-chosen bound is a client-chosen budget.
//
// The policy is the CHANNEL's own (`ownInbox`), not a bare grant: this read is served at
// `GET /_x/query/inbox` with the channel params as input, so with `can('notification:read')` any
// member named any `userId` and read that inbox (plan 101 R9). `channel()` now refuses a catch-up
// whose policy is not the channel's (X_CHANNEL_CATCHUP_POLICY_MISMATCH).
//
// `t` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.

import { from, query, t } from '@ultimat3/query';
import { ownInbox } from '../policy';
import type { Notification } from '../repo';
import * as repo from '../repo';

export const inbox = query({
  input: t.object({ userId: t.uuid }),
  policy: ownInbox,
  sql: ({ userId }) =>
    from<Notification>('notifications', () => repo.inboxPage(userId))
      .where({ userId })
      .orderBy('createdAt', 'desc')
      .orderBy('id')
      .limit(repo.INBOX_PAGE),
});
