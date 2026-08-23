// Every failure the friends feature can raise, one class per stable code. The `fix:` on each is a
// call or a command a caller can run verbatim — a friendship refusal that says "check the state"
// sends an agent hunting for a row it already had the id of.

import { UltimateError } from '@ultimat3/core';

// No `docs:` at any construction site in this file. `UltimateError` fills it from
// `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for
// every code, never one per code, because a code lives on that page in a TABLE ROW and a row has
// no anchor. The `https://ultimate.dev/errors/<code>` links this file built until 2026-08-23
// answered 404, host included, on every error this app has ever thrown.

/** The graph has no self-edge: a person is neither their own friend nor their own block. */
export class FriendSelfError extends UltimateError {
  static readonly code = 'X_FRIEND_SELF';
  override readonly name = 'FriendSelfError';
  constructor(verb: string) {
    super({
      code: FriendSelfError.code,
      cause: `${verb} was called with the caller's own id, and the friendship graph has no self-edge`,
      fix: `${verb}({ userId: "<another user's id, from /u/<handle>>" })`,
    });
  }
}

/**
 * The composite key `(requesterId, addresseeId)` makes a repeated request a no-op, but `(a→b)` and
 * `(b→a)` are different keys — so nothing in the schema stops the mirror row. This is the service
 * closing that hole, and the fix is the call that answers the row already there instead of adding
 * a second one for the same pair.
 */
export class FriendMirrorExistsError extends UltimateError {
  static readonly code = 'X_FRIEND_MIRROR_EXISTS';
  override readonly name = 'FriendMirrorExistsError';
  constructor(requesterId: string, status: string) {
    super({
      code: FriendMirrorExistsError.code,
      cause:
        `this pair already has a ${status} friendship in the other direction (${requesterId} asked ` +
        'first), and a second row would be the mirror the composite key cannot refuse',
      fix: `respondFriend({ requesterId: "${requesterId}", decision: "accept" })`,
      meta: { requesterId, status },
    });
  }
}

/** Answering a request that is not there, or is not pending any more. */
export class FriendRequestNotFoundError extends UltimateError {
  static readonly code = 'X_FRIEND_NOT_FOUND';
  override readonly name = 'FriendRequestNotFoundError';
  constructor(requesterId: string) {
    super({
      code: FriendRequestNotFoundError.code,
      cause: `no friend request from ${requesterId} is waiting for this actor to answer`,
      fix: 'bun run ../../packages/cli/src/bin.ts dev --json   # then open /friends to read the inbox',
      meta: { requesterId },
    });
  }
}

/**
 * A block is NOT a code here, deliberately. `canRequestFriendship` refuses a blocked pair before
 * the handler runs, from the actor's own resolved block set — so a second check in the service
 * would be a second copy of that rule, and the two would drift the first time either changed.
 *
 * Neither is LIFTING one, as of 2026-08. `X_BLOCK_REMOVE_UNSUPPORTED` lived here and said
 * "@ultimat3/entity has no delete for a composite primary key — add deleteWhere(filter) to
 * packages/entity/src/query.ts". That call had already landed (query.ts:116), so the error was
 * instructing its reader to write code that was already in the tree. `unblockPerson` calls it, and
 * removing a block that is not there is `0` rows and a successful call, not a failure code.
 */
