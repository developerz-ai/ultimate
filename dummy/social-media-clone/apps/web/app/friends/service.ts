// The four social-graph commands, composed from the repo. An action calls this; it never calls the
// repo and it never sees `db`. Authorization is NOT repeated here — the policy decided before the
// handler ran. What lives here is the part a rule cannot express because it needs two reads.

import {
  BlockRemoveUnsupportedError,
  FriendMirrorExistsError,
  FriendRequestNotFoundError,
  FriendSelfError,
} from './errors';
import type { Block, Friendship } from './repo';
import { blockEdge, friendshipEdge, saveBlock, saveFriendship } from './repo';

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
 * DECLINED, not deleted — stated because the brief asks which one. Two reasons, and the second is
 * the one that would decide it on its own: declining keeps who asked, which is the only fact the
 * table exists to hold, and `@ultimat3/entity` cannot delete a composite-key row at all
 * (`X_BLOCK_REMOVE_UNSUPPORTED` says the rest). A declined row also blocks the mirror, so unblocking
 * later cannot leave the pair with two rows.
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
 * Lift a block. Unimplementable today, and loudly so rather than quietly wrong: removing the row
 * needs a delete addressed by a composite key, which no driver in `@ultimat3/entity` has. The error
 * names the framework change; `repo.test.ts` pins the limitation so this stops being true the
 * moment that change lands.
 */
export const unblockPerson = (targetId: string): never => {
  throw new BlockRemoveUnsupportedError(targetId);
};
