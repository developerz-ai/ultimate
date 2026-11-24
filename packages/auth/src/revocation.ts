// Single responsibility: taking a credential away, at the three blast radii an incident actually
// has — one person, one tenant, everything issued before an instant.
//
// `deleteOtherSessions` was the only one of the three the seam could express, so "kill every
// session in this org, now" was a per-user loop over an enumeration the adapter could not do, or a
// `TRUNCATE` that killed every other tenant with it. Doing nothing meant thirty days, which is the
// absolute TTL.

import { logger } from '@ultimat3/core';
import type { AuthUser } from './adapter';
import type { Auth } from './auth';
import { authWriteFailed } from './errors';

/**
 * Every revocation is logged before it runs, with the reason the caller gave. An incident review
 * asks "who killed these sessions and why" and a `delete` with no line answers neither; the reason
 * is a required argument for the same rule `crossTenant()` requires one.
 */
const record = (operation: string, scope: string, reason: string): void => {
  logger.warn('auth.revocation', { operation, scope, reason });
};

/** Every session this user holds, their current one included. Returns how many died. */
export async function revokeUserSessions(
  auth: Auth,
  userId: string,
  reason: string,
): Promise<number> {
  record('revokeUserSessions', userId, reason);
  return await auth.adapter.deleteSessionsForUser(userId);
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
  record('revokeOrgSessions', orgId, reason);
  return await auth.adapter.deleteSessionsForOrg(orgId);
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
  record('revokeSessionsCreatedBefore', before.toISOString(), reason);
  return await auth.adapter.deleteSessionsCreatedBefore(before);
}

export interface DisabledUser {
  readonly user: AuthUser;
  readonly sessionsRevoked: number;
  /** Live api keys this user owned, now revoked. A key is the owner's credential too. */
  readonly apiKeysRevoked: number;
}

/**
 * `disabledAt` is read by `login`, by `authenticate`, by `verifyApiKey` and by the OAuth path.
 *
 * Stamping the column is not enough on its own: every one of those readers re-reads the user row,
 * so a disabled account stops working on its next request, but the live session rows are still
 * there and still slide, and the api keys still read as live in every listing. Both go in the
 * same call, in that order — stamp first, so a request racing the revocation finds the row
 * already disabled. Re-enabling restores neither.
 *
 * The log line is written before the first write, as every revocation's is: an incident review
 * must find the reason even when the write that followed it failed.
 */
export async function disableUser(
  auth: Auth,
  userId: string,
  reason: string,
): Promise<DisabledUser> {
  record('disableUser', userId, reason);
  const now = auth.clock.now();
  const user = await auth.adapter.updateUser(userId, { disabledAt: now });
  // No row came back: either there is no such user, or the adapter did not return the update.
  // Both mean the account is not known to be disabled, and reporting success would be a lie.
  if (user === null) throw authWriteFailed('updateUser', 'x_users');
  const sessionsRevoked = await auth.adapter.deleteSessionsForUser(userId);
  const apiKeysRevoked = await revokeOwnedApiKeys(auth, userId, now);
  return { user, sessionsRevoked, apiKeysRevoked };
}

/** Every live key the user owns, revoked at `now`. Returns how many were. */
async function revokeOwnedApiKeys(auth: Auth, userId: string, now: Date): Promise<number> {
  let revoked = 0;
  for (const key of await auth.adapter.listApiKeys(userId)) {
    if (key.revokedAt !== null) continue;
    if (await auth.adapter.revokeApiKey(key.id, now)) revoked += 1;
  }
  return revoked;
}

/** The inverse. No sessions are restored — a re-enabled account signs in again, deliberately. */
export async function enableUser(auth: Auth, userId: string): Promise<AuthUser | null> {
  return await auth.adapter.updateUser(userId, { disabledAt: null });
}

export interface ReclaimedAccount extends DisabledUser {
  readonly passkeysDeleted: number;
}

/**
 * An account handed to the owner of its inbox, once a reset link proved the address: every
 * authenticator the registrant set is taken, then the address is marked proven.
 *
 * Revoking them one by one while the account still opens races the registrant — a live session
 * enrols a passkey after the sweep listed them — and a stamp written before a sweep that then fails
 * publishes the account as verified with the registrant still inside. So:
 *
 * 1. ONE write stamps `disabledAt` and clears the password and the second factor. `login`,
 *    `authenticate`, `verifyApiKey`, passkey register and sign-in, the OAuth path and `completeMfa`
 *    all re-read `disabledAt`, so a request racing the sweep finds the account shut and can enrol
 *    nothing.
 * 2. Sessions, API keys and passkeys go while it is shut.
 * 3. ONE write stamps `emailVerifiedAt` and lifts the `disabledAt` this call set. Verification is
 *    never published apart from the reopening: a call that fails before it leaves the account
 *    disabled and unverified.
 *
 * Only a disable this call set is lifted. An account found disabled — an operator's, or a
 * reclaim that failed part-way — is swept and verified and stays disabled: a reset link is not
 * how a disable ends. Once this returns nothing of the registrant's remains, so `enableUser` is
 * then safe.
 */
export async function reclaimAccount(
  auth: Auth,
  userId: string,
  reason: string,
): Promise<ReclaimedAccount> {
  record('reclaimAccount', userId, reason);
  const found = await auth.adapter.findUserById(userId);
  if (found === null) throw authWriteFailed('findUserById', 'x_users');
  const now = auth.clock.now();
  const shut = await auth.adapter.updateUser(userId, {
    disabledAt: found.disabledAt ?? now,
    passwordHash: null,
    mfaSecret: null,
    recoveryCodeHashes: [],
  });
  if (shut === null) throw authWriteFailed('updateUser', 'x_users');
  const sessionsRevoked = await auth.adapter.deleteSessionsForUser(userId);
  const apiKeysRevoked = await revokeOwnedApiKeys(auth, userId, now);
  let passkeysDeleted = 0;
  for (const passkey of await auth.adapter.listPasskeys(userId)) {
    if (await auth.adapter.deletePasskey(userId, passkey.id)) passkeysDeleted += 1;
  }
  const user = await auth.adapter.updateUser(userId, {
    emailVerifiedAt: now,
    disabledAt: found.disabledAt,
  });
  if (user === null) throw authWriteFailed('updateUser', 'x_users');
  return { user, sessionsRevoked, apiKeysRevoked, passkeysDeleted };
}
