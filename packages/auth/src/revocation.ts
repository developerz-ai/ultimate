// Single responsibility: taking a credential away, at the three blast radii an incident actually
// has — one person, one tenant, everything issued before an instant. `deleteOtherSessions` was the
// only one of the three the seam could express, so "kill every session in this org, now" was a
// per-user loop over an enumeration the adapter could not do, or a `TRUNCATE` that killed every
// other tenant with it. Doing nothing meant thirty days, which is the absolute TTL.

import { logger } from '@ultimat3/core';
import type { AuthUser } from './adapter';
import type { Auth } from './auth';
import { authNotImplemented, authWriteFailed } from './errors';

/**
 * Every revocation is logged before it runs, with the reason the caller gave. An incident review
 * asks "who killed these sessions and why" and a `delete` with no line answers neither; the reason
 * is a required argument for the same rule `crossTenant()` requires one.
 */
const record = (operation: string, scope: string, reason: string): void => {
  logger.warn('auth.revocation', { operation, scope, reason });
};

const unsupported = (method: string, adapterName: string) =>
  authNotImplemented(
    `${adapterName}.${method}()`,
    `implement ${method}() on your AuthAdapter — BuiltinAdapter (Postgres) and MemoryAdapter are the two reference implementations, in packages/auth/src`,
  );

/** Every session this user holds, their current one included. Returns how many died. */
export async function revokeUserSessions(
  auth: Auth,
  userId: string,
  reason: string,
): Promise<number> {
  const remove = auth.adapter.deleteSessionsForUser?.bind(auth.adapter);
  if (remove === undefined) throw unsupported('deleteSessionsForUser', auth.adapter.name);
  record('revokeUserSessions', userId, reason);
  return await remove(userId);
}

/**
 * Every session held by every member of one org. The 03:00 answer to a confirmed credential
 * compromise in one tenant, and the one thing the seam could not express at all.
 */
export async function revokeOrgSessions(
  auth: Auth,
  orgId: string,
  reason: string,
): Promise<number> {
  const remove = auth.adapter.deleteSessionsForOrg?.bind(auth.adapter);
  if (remove === undefined) throw unsupported('deleteSessionsForOrg', auth.adapter.name);
  record('revokeOrgSessions', orgId, reason);
  return await remove(orgId);
}

/**
 * Everything minted before an instant. The sweep that follows a rotated `SESSION_SECRET` or a
 * suspected dump: it needs no enumeration of users, so it is the one that works when the list of
 * affected accounts is exactly what is not known yet.
 */
export async function revokeSessionsCreatedBefore(
  auth: Auth,
  before: Date,
  reason: string,
): Promise<number> {
  const remove = auth.adapter.deleteSessionsCreatedBefore?.bind(auth.adapter);
  if (remove === undefined) throw unsupported('deleteSessionsCreatedBefore', auth.adapter.name);
  record('revokeSessionsCreatedBefore', before.toISOString(), reason);
  return await remove(before);
}

export interface DisabledUser {
  readonly user: AuthUser;
  readonly sessionsRevoked: number;
}

/**
 * `disabledAt` is read by `login`, by `authenticate` and by the OAuth path — and until this
 * function existed, no code path anywhere ever SET it. Offboarding was an UPDATE somebody typed.
 *
 * Stamping the column is not enough on its own: `authenticate` re-reads the user row on every
 * request, so a disabled account stops working on its next request, but the live session row is
 * still there and still slides. The sessions go in the same call, in that order — stamp first, so
 * a request racing the revocation finds the row already disabled.
 */
export async function disableUser(
  auth: Auth,
  userId: string,
  reason: string,
): Promise<DisabledUser> {
  const user = await auth.adapter.updateUser(userId, { disabledAt: auth.clock.now() });
  // No row came back: either there is no such user, or the adapter did not return the update.
  // Both mean the account is not known to be disabled, and reporting success would be a lie.
  if (user === null) throw authWriteFailed('updateUser', 'x_users');
  record('disableUser', userId, reason);
  return { user, sessionsRevoked: await revokeUserSessions(auth, userId, reason) };
}

/** The inverse. No sessions are restored — a re-enabled account signs in again, deliberately. */
export async function enableUser(auth: Auth, userId: string): Promise<AuthUser | null> {
  return await auth.adapter.updateUser(userId, { disabledAt: null });
}
