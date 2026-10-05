// Single responsibility: changing what a user may do, and ending the credentials issued under the
// old answer — the caller's session is rotated on any privilege change, and a changed password
// ends every other session the user holds.

import type { AuthUser, UserPatch } from './adapter';
import type { Auth } from './auth';
import { authWriteFailed } from './errors';
import {
  type IssuedSession,
  remainingMaxAgeSeconds,
  rotateSession,
  sessionCookie,
} from './session';

/**
 * The fields whose change invalidates whatever the current cookie was issued under. `roles`,
 * `permissions` and `scopes` are what an actor is built from; `passwordHash` is the credential
 * itself; `orgId` moves every tenant-scoped read the session can perform.
 */
const PRIVILEGE_FIELDS = ['roles', 'permissions', 'scopes', 'orgId', 'passwordHash'] as const;

export interface UpdatePrivilegesResult {
  readonly user: AuthUser;
  /**
   * The replacement session, present only when a current session was passed AND a privilege field
   * actually changed. Set `cookie` on the response — the old id is already deleted, so a caller
   * that drops this signs the user out rather than leaving a stale-privilege cookie live.
   */
  readonly session?: IssuedSession | undefined;
  readonly cookie?: string | undefined;
  /** Which of `PRIVILEGE_FIELDS` the patch actually named. Empty means nothing rotated. */
  readonly changed: readonly string[];
  /** Sessions a `passwordHash` change ended. Zero for every other patch. */
  readonly sessionsRevoked: number;
}

const changedFields = (patch: UserPatch): readonly string[] =>
  PRIVILEGE_FIELDS.filter((field) => patch[field] !== undefined);

/**
 * Apply the patch, then mint a new session id for the caller's own session when the patch touched
 * privilege. Rotation is not about propagation — `authenticate` re-reads the user row on every
 * request, so a revoked role takes effect on the very next one with no token-expiry lag, which is
 * a better property than any claims-in-a-JWT design. It is about fixation: whoever planted or
 * lifted the old cookie before the grant must not inherit the grant with it.
 *
 * `session` is optional because the common caller is an admin changing somebody ELSE's roles, and
 * there is no cookie of theirs to rotate. That case wants `revokeUserSessions()` instead, and the
 * two are deliberately separate calls — silently killing an operator's own session mid-request is
 * not something a role edit should decide on its own.
 *
 * A `passwordHash` change is the exception, and it decides for itself: the password is what every
 * OTHER session of this user was issued under, so they all end here. The caller's own session —
 * passed in, and this user's — is the one that survives (rotated, or kept when rotation is off);
 * with no session of the user's own, as in a reset or an admin's change, none survives. A changed
 * password that left a lifted cookie working would not have changed anything for whoever holds it.
 */
export async function updatePrivileges(
  auth: Auth,
  userId: string,
  patch: UserPatch,
  session?: IssuedSession['session'] | undefined,
): Promise<UpdatePrivilegesResult> {
  const changed = changedFields(patch);
  const own = session !== undefined && session.userId === userId ? session : undefined;
  const credentialChanged = changed.includes('passwordHash');
  const user = await auth.adapter.updateUser(userId, patch);
  if (user === null) throw authWriteFailed('updateUser', 'x_users');
  if (changed.length === 0) return { user, changed, sessionsRevoked: 0 };

  // Every OTHER session ends BEFORE the rotation, keyed on the caller's current id (which the
  // rotation deletes anyway). Rotation refuses a session that is already gone, and a password
  // change must not leave the lifted cookies it was made to kill alive because of that refusal.
  let sessionsRevoked = 0;
  if (credentialChanged) {
    sessionsRevoked =
      own === undefined
        ? await auth.adapter.deleteSessionsForUser(userId)
        : await auth.adapter.deleteOtherSessions(userId, own.id);
  }
  const issued =
    own !== undefined && auth.sessions.policy.rotateOnPrivilegeChange
      ? await rotateSession(auth.sessions, own)
      : undefined;
  if (issued === undefined) return { user, changed, sessionsRevoked };
  return {
    user,
    changed,
    sessionsRevoked,
    session: issued,
    // The rotated session keeps the old ceiling, so the cookie's `Max-Age` counts down to it too.
    cookie: sessionCookie(issued.token, auth.sessions.policy, {
      maxAgeSeconds: remainingMaxAgeSeconds(issued.session, auth.sessions.clock.now()),
    }),
  };
}
