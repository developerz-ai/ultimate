// `requestFriend`, the friends slice's action — one primitive per file, the layout `x g` writes.
//
// The social graph's four commands. Declarations only — every body delegates to `./service`, so the
// same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package. Each
// `row:` loader is the async half authz is not allowed to have — it runs once per invocation, and
// the predicate that reads its result stays synchronous.

import { action, t } from '@ultimat3/action';
import { friendRequest } from '../policy';
import { requestFriendship } from '../service';
import { FriendshipView, personRow } from '../views';

export const requestFriend = action({
  input: t.object({ userId: t.uuid }),
  output: FriendshipView,
  policy: friendRequest,
  // `null` here means "no such person", which is a denial and not a 404 later: the rule decides
  // once, and a surface that passed no row cannot slip past it.
  row: personRow,
  idempotent: true,
  mcp: { expose: true, description: 'Ask another user to be friends' },
  handle: ({ input, ctx }) => requestFriendship(ctx.actor.id, input.userId, ctx.now()),
});
