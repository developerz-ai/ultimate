// The four social-graph commands, composed from the repo. An action calls this; it never calls the
// repo and it never sees `db`. Authorization is NOT repeated here — the policy decided before the
// handler ran. What lives here is the part a rule cannot express because it needs two reads.

import { FriendMirrorExistsError, FriendRequestNotFoundError, FriendSelfError } from './errors';
import type { Block, Friendship } from './repo';
import { blockEdge, friendshipEdge, removeBlock, saveBlock, saveFriendship } from './repo';

/**
 * Ask to be someone's friend.
 *
 * BOTH directions are read before anything is written, and that is not defensive coding — it is the
 * one place the schema's hole is closed. The composite key `(requesterId, addresseeId)` makes a
 * repeated request a no-op, but `(a→b)` and `(b→a)` are different keys, so nothing in the database
 * refuses the mirror row. A pair gets exactly one row, owned by whoever asked first.
 */
export const requestFriendship = async (
  viewerId: string,
  targetId: string,
  now: Date,
): Promise<Friendship> => {
  if (viewerId === targetId) throw new FriendSelfError('requestFriend');

  const [forward, reverse] = await Promise.all([
    friendshipEdge(viewerId, targetId),
    friendshipEdge(targetId, viewerId),
  ]);

  // Already friends, whichever way round the row points. Idempotent, and no write.
  if (forward?.status === 'accepted') return forward;
  if (reverse?.status === 'accepted') return reverse;

  // They asked first. Answering their row is the only move that keeps the pair on one row — and it
  // is a move this actor can make, which is what makes the refusal an instruction.
  if (reverse !== null) throw new FriendMirrorExistsError(reverse.requesterId, reverse.status);

  if (forward?.status === 'pending') return forward;

  // A declined request of our own, re-opened in place: same asker, same direction, so the fact the
  // row carries stays true. `respondedAt` returns to null because `pending` requires it.
  return saveFriendship({
    requesterId: viewerId,
    addresseeId: targetId,
    status: 'pending',
    respondedAt: null,
    createdAt: forward?.createdAt ?? now,
  });
};

/**
 * Answer a request addressed to you. The row is loaded by the ACTION (`row:`) so `friendRespond`
 * can decide about it while staying synchronous; this re-reads it because a service must be
 * callable from a job or a test that had no loader, and a missing row is a named failure rather
 * than a silent no-op.
 */
export const respondToFriendship = async (
  viewerId: string,
  requesterId: string,
  accept: boolean,
  now: Date,
): Promise<Friendship> => {
  const row = await friendshipEdge(requesterId, viewerId);
  if (row === null) throw new FriendRequestNotFoundError(requesterId);
  return saveFriendship({ ...row, status: accept ? 'accepted' : 'declined', respondedAt: now });
};

/**
 * Block someone, and settle the friendship between them.
 *
 * DECLINED, not deleted — stated because the brief asks which one. Declining keeps who asked, which
 * is the only fact the table exists to hold; a deleted row keeps nothing. A declined row also blocks
 * the mirror, so unblocking later cannot leave the pair with two rows. (`deleteWhere` exists now and
 * this is still not a delete: the reason was never that the framework could not.)
 */
export const blockPerson = async (
  viewerId: string,
  targetId: string,
  now: Date,
): Promise<Block> => {
  if (viewerId === targetId) throw new FriendSelfError('blockUser');

  const [existing, forward, reverse] = await Promise.all([
    blockEdge(viewerId, targetId),
    friendshipEdge(viewerId, targetId),
    friendshipEdge(targetId, viewerId),
  ]);

  for (const row of [forward, reverse]) {
    if (row !== null && row.status !== 'declined') {
      await saveFriendship({ ...row, status: 'declined', respondedAt: now });
    }
  }

  // The composite key is the idempotency mechanism: blocking twice replaces one row, and the
  // original `createdAt` is kept so "blocked since" does not move every time the call is retried.
  return saveBlock({
    blockerId: viewerId,
    blockedId: targetId,
    createdAt: existing?.createdAt ?? now,
  });
};

/**
 * Lift a block.
 *
 * Idempotent, and that is the answer to "what if there is no block": `deleteWhere` returns how many
 * rows went, so unblocking someone who is not blocked is `false` and not a refusal — the caller
 * asked for a state, and the state is already true. The friendship is NOT restored: blocking
 * declined it, and who wants to be friends again is a decision the pair makes, not a side effect.
 *
 * This threw `X_BLOCK_REMOVE_UNSUPPORTED` until 2026-08, on the ground that `@ultimat3/entity` had
 * no delete for a composite primary key. It has one — `deleteWhere` (packages/entity/src/query.ts:116)
 * — so the refusal was instructing its reader to add code that was already there.
 */
export const unblockPerson = async (viewerId: string, targetId: string): Promise<boolean> => {
  if (viewerId === targetId) throw new FriendSelfError('unblockUser');
  return (await removeBlock(viewerId, targetId)) > 0;
};
