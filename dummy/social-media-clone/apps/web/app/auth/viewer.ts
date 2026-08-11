// Turning a session cookie into the `Actor` every policy predicate reads. This is the file the
// visibility rules stand on: the friend set and the block set are resolved HERE, once per request,
// because a predicate is synchronous and re-evaluated per subscriber per change on a live query.

import type { User } from '@social-media-clone/db';
import { userId } from '@social-media-clone/domain';
import type { Actor } from '../../shared/actor';
import { hashToken } from '../../shared/session';
import { acceptedFriendIds, blockedIdsBothWays, sessionByTokenHash, userById } from './repo';

/**
 * The actor for a user, with the whole graph they need already in memory.
 *
 * Two queries fan out in parallel and the result is two frozen Sets. That is the entire budget a
 * request gets for authorization data — every `isFriend` and `isBlocked` call after this point is
 * a hash lookup, whether it happens once in a page render or ten thousand times across the
 * subscribers of one live query.
 */
export const actorFor = async (user: User): Promise<Actor> => {
  const [friends, blocked] = await Promise.all([
    acceptedFriendIds(user.id),
    blockedIdsBothWays(user.id),
  ]);
  return {
    id: userId(user.id),
    role: user.role,
    friendIds: new Set(friends),
    // Already symmetric — `blockedIdsBothWays` unioned the two directions. See `shared/actor.ts`.
    blockedIds: new Set(blocked),
  };
};

/**
 * A user who may act at all. A soft-deleted or suspended account keeps its session rows — deleting
 * them would be a write on a read path — so the check happens here, at every resolve, rather than
 * once at suspension time where it could be missed.
 */
const canAct = (user: User | null): user is User =>
  user !== null && user.deletedAt === null && !user.suspended;

/**
 * The viewer a cookie names, or `null`.
 *
 * `null` for every failure, and there are four: no cookie, a token whose hash matches no row, a
 * row that has expired, and a user who may no longer act. None of them is an error — an expired
 * cookie is an ordinary anonymous visitor, and throwing would turn every stale tab into a 500.
 */
export const viewerFor = async (token: string | null, now: Date): Promise<Actor | null> => {
  if (token === null || token.length === 0) return null;
  // The lookup is on the hash, so a token that does not match its stored hash matches NO row —
  // there is no comparison to get wrong and nothing in the table to replay.
  const session = await sessionByTokenHash(hashToken(token));
  if (session === null) return null;
  // Absolute expiry, compared against the request's clock. `<=` and not `<`: a session that
  // expires exactly now is expired.
  if (session.expiresAt.getTime() <= now.getTime()) return null;
  const user = await userById(session.userId);
  return canAct(user) ? await actorFor(user) : null;
};
