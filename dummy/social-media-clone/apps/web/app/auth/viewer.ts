// Turning a session cookie into the `Actor` every policy predicate reads. `@ultimat3/auth` decides
// whether the token is a live session and whose; this file is what the visibility rules stand on:
// the friend set and the block set are resolved HERE, once per request, because a predicate is
// synchronous and re-evaluated per subscriber per change on a live query.

import type { User } from '@social-media-clone/db';
import { authenticate } from '@ultimat3/auth';
import { isUltimateError } from '@ultimat3/core';
import type { Actor } from '../../shared/actor';
import { viewerActor } from '../../shared/actor';
import { appAuth } from './auth';
import { acceptedFriendIds, blockedIdsBothWays, userById } from './repo';

/**
 * The actor for a user, with the whole graph they need already in memory.
 *
 * Two queries fan out in parallel and the result is two frozen Sets, carried as actor FACTS. That
 * is the entire budget a request gets for authorization data — every `isFriend` and `isBlocked`
 * call after this point is a hash lookup off the actor a rule was already handed, whether it
 * happens once in a page render or ten thousand times across the subscribers of one live query.
 */
export const actorFor = async (user: User): Promise<Actor> => {
  const [friends, blocked] = await Promise.all([
    acceptedFriendIds(user.id),
    blockedIdsBothWays(user.id),
  ]);
  return viewerActor({
    id: user.id,
    role: user.role,
    friendIds: friends,
    // Already symmetric — `blockedIdsBothWays` unioned the two directions. See `shared/actor.ts`.
    blockedIds: blocked,
  });
};

/**
 * A user who may act at all. A soft-deleted or suspended account keeps its session rows — deleting
 * them would be a write on a read path — so the check happens here, at every resolve, rather than
 * once at suspension time where it could be missed.
 */
const canAct = (user: User | null): user is User =>
  user !== null && user.deletedAt === null && !user.suspended;

/**
 * What `authenticate()` answers a token that names no live session with — a forged or revoked one,
 * and one past its expiry. Both are an ordinary anonymous visitor here, never an error page.
 */
const NOT_A_SESSION: ReadonlySet<string> = new Set(['X_UNAUTHENTICATED', 'X_SESSION_EXPIRED']);

/**
 * The viewer a cookie names, or `null`.
 *
 * `null` for every failure, and there are four: no cookie, a token that names no live session, one
 * past its expiry, and a user who may no longer act. None of them is an error — an expired cookie
 * is an ordinary anonymous visitor, and throwing would turn every stale tab into a 500. Anything
 * else `authenticate()` throws — a store that is down — is not an answer about this visitor and
 * propagates.
 */
export const viewerFor = async (token: string | null): Promise<Actor | null> => {
  if (token === null || token.length === 0) return null;
  let id: string;
  try {
    id = (await authenticate(appAuth(), token)).id;
  } catch (error) {
    if (isUltimateError(error) && NOT_A_SESSION.has(error.code)) return null;
    throw error;
  }
  const user = await userById(id);
  return canAct(user) ? await actorFor(user) : null;
};
