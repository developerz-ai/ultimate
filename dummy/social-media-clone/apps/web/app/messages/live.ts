// The thread, as a subscribable read.
//
// Ordered, bounded and TOTALLY ordered — the last sort key is unique. That is not decoration: the
// matcher decides a row's position from the `orderBy` list alone (`packages/query/src/matcher.ts`),
// so `createdAt desc` on its own is a partial order and two messages written in the same
// millisecond can swap between evaluations, which makes a bounded page silently drop or repeat one
// at its boundary. `messages` carries the matching index for exactly this reason
// (`packages/db/src/schema/messages.ts:19`).
//
// The bound is a CONSTANT, not an input: `limit` is what stops a subscription's window from
// growing without end, and a client-chosen bound is a client-chosen memory budget.
//
// `t` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.

import { from, query, t } from '@ultimat3/query';
import { threadRead } from './policy';
import type { Message } from './repo';
import * as repo from './repo';

export const liveThread = query({
  input: t.object({ conversationId: t.uuid }),
  /**
   * The same policy object the page and the action evaluate. It decides on the loaded `ThreadRow`,
   * and `row === null` denies — so this subscription FAILS CLOSED on a sync node, which passes
   * `null` at subscribe time unconditionally (`packages/realtime/src/policy-gate.ts:26`) and hands
   * the row gate a `messages` row that carries no membership.
   *
   * That is a refusal, not a hole, and it is the honest state of the seam: `authorize` on a
   * `LiveQueryDefinition` is async and could load the fact, but `authorizeWithPolicy` never gives
   * it the chance, and the node's context (`packages/cli/src/dev-roles.ts:151`) carries neither
   * the subscriber's session nor an actor. Membership is checked for real on the channel guard in
   * `topics.ts`, which IS async.
   */
  policy: threadRead,
  live: true,
  sql: ({ conversationId }) =>
    // 'messages' — the entity's table, not the feature name: `from()` quotes the identifier
    // straight into the SQL text an agent reads back.
    from<Message>('messages', () => repo.threadPage(conversationId, repo.THREAD_PAGE))
      .where({ conversationId })
      .orderBy('createdAt', 'desc')
      .orderBy('id')
      .limit(repo.THREAD_PAGE),
});
