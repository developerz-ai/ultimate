// The social graph's four commands. Declarations only — every body delegates to `./service`, so the
// same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package. Each
// `row:` loader is the async half authz is not allowed to have — it runs once per invocation, and
// the predicate that reads its result stays synchronous.

import { FRIENDSHIP_STATUSES } from '@social-media-clone/domain';
import { action, t } from '@ultimat3/action';
import type { BlockRow, FriendshipRow, PersonRow } from './policy';
import { blockCreate, blockDelete, friendRequest, friendRespond } from './policy';
import { blockEdge, friendshipEdge, personById } from './repo';
import { blockPerson, requestFriendship, respondToFriendship, unblockPerson } from './service';

/** The row shape every friendship command answers with. Derived from the entity's own columns. */
const FriendshipView = t.object({
  requesterId: t.uuid,
  addresseeId: t.uuid,
  status: t.enumerated(...FRIENDSHIP_STATUSES),
  respondedAt: t.nullable(t.date),
  createdAt: t.date,
});

const BlockView = t.object({ blockerId: t.uuid, blockedId: t.uuid, createdAt: t.date });

/**
 * The loader narrows to exactly what the rule reads. Handing the whole `User` row to a policy would
 * put a bio and an email inside an authz decision, and a denial `reason` is allowed to name a
 * permission but never row data.
 */
const personRow = async ({ input }: { input: { userId: string } }): Promise<PersonRow | null> => {
  const person = await personById(input.userId);
  return person === null ? null : { id: person.id };
};

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

export const blockUser = action({
  input: t.object({ userId: t.uuid }),
  output: BlockView,
  policy: blockCreate,
  row: personRow,
  idempotent: true,
  mcp: { expose: true, description: 'Block a user and decline any friendship between them' },
  handle: ({ input, ctx }) => blockPerson(ctx.actor.id, input.userId, ctx.now()),
});

/**
 * Declared in full — permission, policy, row loader and all — even though its handler cannot
 * succeed: the UI decides whether to render an "Unblock" control from `blockDelete` with this same
 * row, and one decision has to both render the button and answer the call. The refusal names the
 * framework change that makes it work; see `X_BLOCK_REMOVE_UNSUPPORTED`.
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
  handle: ({ input }) => unblockPerson(input.userId),
});
