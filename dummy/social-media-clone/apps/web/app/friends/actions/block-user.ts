// `blockUser`, the friends slice's action — one primitive per file, the layout `x g` writes.
//
// The social graph's four commands. Declarations only — every body delegates to `./service`, so the
// same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package. Each
// `row:` loader is the async half authz is not allowed to have — it runs once per invocation, and
// the predicate that reads its result stays synchronous.

import { action, t } from '@ultimat3/action';
import { blockCreate } from '../policy';
import { blockPerson } from '../service';
import { BlockView, personRow } from '../views';

export const blockUser = action({
  input: t.object({ userId: t.uuid }),
  output: BlockView,
  policy: blockCreate,
  row: personRow,
  idempotent: true,
  mcp: { expose: true, description: 'Block a user and decline any friendship between them' },
  handle: ({ input, ctx }) => blockPerson(ctx.actor.id, input.userId, ctx.now()),
});
