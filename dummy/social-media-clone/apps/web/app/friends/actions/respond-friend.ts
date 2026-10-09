// `respondFriend`, the friends slice's action — one primitive per file, the layout `x g` writes.
//
// The social graph's four commands. Declarations only — every body delegates to `./service`, so the
// same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package. Each
// `row:` loader is the async half authz is not allowed to have — it runs once per invocation, and
// the predicate that reads its result stays synchronous.

import { action, t } from '@ultimat3/action';
import type { FriendshipRow } from '../policy';
import { friendRespond } from '../policy';
import { friendshipEdge } from '../repo';
import { respondToFriendship } from '../service';
import { FriendshipView } from '../views';

export const respondFriend = action({
  // `decision` is a string, not a boolean: this action is reachable from a plain HTML form (the
  // screen has no client JS), and a form sends "true", not `true`. A string the schema already
  // constrains beats a boolean that only a JSON client can spell.
  input: t.object({ requesterId: t.uuid, decision: t.enumerated('accept', 'decline') }),
  output: FriendshipView,
  policy: friendRespond,
  /**
   * Loaded by `addresseeId = the caller`, which is what makes "only the addressee may answer"
   * structural as well as declared: a request addressed to somebody else resolves to `null` here
   * and `friendRespond` denies on it, so the rule never has to trust the input's word for it.
   */
  row: async ({ input, ctx }): Promise<FriendshipRow | null> => {
    const row = await friendshipEdge(input.requesterId, ctx.actor.id);
    return row === null
      ? null
      : { requesterId: row.requesterId, addresseeId: row.addresseeId, status: row.status };
  },
  idempotent: true,
  mcp: { expose: true, description: 'Accept or decline a friend request addressed to the caller' },
  handle: ({ input, ctx }) =>
    respondToFriendship(ctx.actor.id, input.requesterId, input.decision === 'accept', ctx.now()),
});
