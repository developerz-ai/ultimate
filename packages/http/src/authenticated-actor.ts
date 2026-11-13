// The `auth` stage's one question — who is this — asked of an authenticator that may answer "nobody"
// by THROWING. `@ultimat3/auth`'s `authenticate()` does, for a revoked, expired or forged cookie.

import { type Actor, anonymousActor, isSessionRefusal } from '@ultimat3/core';
import type { RequestContext } from './context';
import type { Authenticator } from './hooks';
import type { UltimateRequest } from './request';

/**
 * The actor `authenticate` resolves, core's anonymous actor for `null`, and the same anonymous
 * actor for a session refusal (`isSessionRefusal`, core's one list). Thrown through, a stale cookie
 * answered 401 on every route — sign-in, the OAuth callback and sign-out included — while a
 * required route already refuses anonymous with the same 401 a missing cookie gets. Any other throw
 * is a failure and propagates: a session store that is down must not serve its users as nobody.
 */
export async function authenticatedActor(
  authenticate: Authenticator,
  request: UltimateRequest,
  ctx: RequestContext,
): Promise<Actor> {
  try {
    return (await authenticate(request, ctx)) ?? anonymousActor();
  } catch (error) {
    if (!isSessionRefusal(error)) throw error;
    return anonymousActor();
  }
}
