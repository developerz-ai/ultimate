// Single responsibility: changing what a user may do, and rotating the credential that was issued
// under the old answer. `packages/auth/CLAUDE.md` has listed "rotate the session id on any
// privilege change (`rotateSession`)" as a non-negotiable since 1.0, and
// `SessionPolicy.rotateOnPrivilegeChange` has defaulted `true` — while `rotateSession` had no
// caller anywhere outside its own test and the flag was read by nothing. Per axiom 3 the rule did
// not exist. This is the caller that makes it exist.

import type { AuthUser, UserPatch } from './adapter';
import type { Auth } from './auth';
import { authWriteFailed } from './errors';
import { type IssuedSession, rotateSession, sessionCookie } from './session';

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
 */
export async function updatePrivileges(
  auth: Auth,
  userId: string,
  patch: UserPatch,
  session?: IssuedSession['session'] | undefined,
): Promise<UpdatePrivilegesResult> {
  const user = await auth.adapter.updateUser(userId, patch);
  if (user === null) throw authWriteFailed('updateUser', 'x_users');

  const changed = changedFields(patch);
  if (
    changed.length === 0 ||
    session === undefined ||
    session.userId !== userId ||
    !auth.sessions.policy.rotateOnPrivilegeChange
  ) {
    return { user, changed };
  }

  const issued = await rotateSession(auth.sessions, session);
  return {
    user,
    changed,
    session: issued,
    cookie: sessionCookie(issued.token, auth.sessions.policy),
  };
}
