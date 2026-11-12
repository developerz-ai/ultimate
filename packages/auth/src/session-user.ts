// Single responsibility: a session token to its live session AND its user, in the fewest reads the
// adapter allows — one join when it has `getSessionWithUser`, else `verifySession` then
// `findUserById`. Admission is `admitSession` either way; whether the user may act is the caller's.

import type { AuthAdapter, AuthSession, AuthUser } from './adapter';
import { sessionUnknown } from './errors';
import { admitSession, parseSessionToken, type SessionRuntime, verifySession } from './session';

export interface VerifiedSession {
  readonly session: AuthSession;
  /** `null` when the session outlived its user — the caller deletes the session and refuses. */
  readonly user: AuthUser | null;
}

/**
 * The user is read only once the session is admitted on the two-read path, and on the join it is
 * read in the same statement but handed back only after admission: a forged or expired token
 * never yields a user either way.
 */
export async function verifySessionWithUser(
  runtime: SessionRuntime,
  adapter: AuthAdapter,
  token: string,
): Promise<VerifiedSession> {
  if (adapter.getSessionWithUser === undefined) {
    const session = await verifySession(runtime, token);
    return { session, user: await adapter.findUserById(session.userId) };
  }
  const parsed = parseSessionToken(token);
  if (parsed === null) throw sessionUnknown();
  const joined = await adapter.getSessionWithUser(parsed.id);
  const session = await admitSession(runtime, parsed.secret, joined?.session ?? null);
  return { session, user: joined?.user ?? null };
}
