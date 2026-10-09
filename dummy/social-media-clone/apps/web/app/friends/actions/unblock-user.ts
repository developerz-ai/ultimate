// `unblockUser`, the friends slice's action — one primitive per file, the layout `x g` writes.
//
// The social graph's four commands. Declarations only — every body delegates to `./service`, so the
// same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package. Each
// `row:` loader is the async half authz is not allowed to have — it runs once per invocation, and
// the predicate that reads its result stays synchronous.

import { action, t } from '@ultimat3/action';
import type { BlockRow } from '../policy';
import { blockDelete } from '../policy';
import { blockEdge } from '../repo';
import { unblockPerson } from '../service';

/**
 * The mirror of `blockUser`. The UI decides whether to render an "Unblock" control from
 * `blockDelete` with this same row, and one decision both renders the button and answers the call.
 *
 * The output is the PAIR, not whether a row went: the action is idempotent, so a second submit —
 * a double click, a retry, a queued MCP call — has to answer the same document as the first.
 */
export const unblockUser = action({
  input: t.object({ userId: t.uuid }),
  output: t.object({ blockerId: t.uuid, blockedId: t.uuid }),
  policy: blockDelete,
  row: async ({ input, ctx }): Promise<BlockRow | null> => {
    const row = await blockEdge(ctx.actor.id, input.userId);
    return row === null ? null : { blockerId: row.blockerId, blockedId: row.blockedId };
  },
  mcp: { expose: true, description: 'Lift a block this user placed' },
  handle: async ({ input, ctx }) => {
    await unblockPerson(ctx.actor.id, input.userId);
    return { blockerId: ctx.actor.id, blockedId: input.userId };
  },
});
