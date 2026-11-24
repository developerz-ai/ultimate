// Single responsibility: taking a credential away, at the three blast radii an incident actually
// has — one person, one tenant, everything issued before an instant.
//
// `deleteOtherSessions` was the only one of the three the seam could express, so "kill every
// session in this org, now" was a per-user loop over an enumeration the adapter could not do, or a
// `TRUNCATE` that killed every other tenant with it. Doing nothing meant thirty days, which is the
// absolute TTL.

import { ConfigInvalidError, logger } from '@ultimat3/core';
import type { AuthUser } from './adapter';
import type { Auth } from './auth';
import { AuthError, authWriteFailed } from './errors';

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
 * The `disabledAt` a reclaim shuts an account with: a state of its own, never an instant a clock
 * stamps, so the reopening write can require that the disable is still the reclaim's. An
 * operator's `disableUser` mid-reclaim overwrites it with a real instant, and nothing is lifted.
 */
const RECLAIMING = new Date(0);

const reclaimUnsupported = (adapter: string): ConfigInvalidError =>
  new ConfigInvalidError({
    cause: `the auth adapter '${adapter}' has no updateUserWhere, so reclaimAccount cannot make its writes conditional, and a plain write would undo a concurrent disable or verification`,
    fix: 'updateUserWhere(id, expected, patch)   // on the adapter: the updateUser patch, written only while the row still holds expected, in one atomic step — both built-in adapters have it',
    meta: { adapter },
  });

const ALREADY_VERIFIED =
  'the account already verified its address, so it has an owner and nothing of a registrant is left to reclaim';
const CHANGED =
  'the account changed while it was being reclaimed — an operator disabled or enabled it, or another reset verified it — so this reclaim left it as that write did';

const reclaimRefused = (cause: string): AuthError =>
  new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause,
    fix: "await auth.adapter.findUserById(userId)   // read the account as it is now: a verified one takes an ordinary password reset, a disabled one stays the operator's. Never reclaim it again blind",
  });

/**
 * An account handed to the owner of its inbox, once a reset link proved the address: every
 * authenticator the registrant set is taken, then the address is marked proven.
 *
 * Revoking them one by one while the account still opens races the registrant — a live session
 * enrols a passkey after the sweep listed them — and a stamp written before a sweep that then fails
 * publishes the account as verified with the registrant still inside. So both writes are
 * conditional (`updateUserWhere`) and the account is shut between them:
 *
 * 1. Only while the row is still unverified and its `disabledAt` is what was read: shut it
 *    (`disabledAt` = the reclaim's own state) and clear the password and second factor. `login`,
 *    `authenticate`, `verifyApiKey`, passkey register and sign-in, the OAuth path and
 *    `completeMfa` all re-read `disabledAt`, so a request racing the sweep can enrol nothing. A
 *    second reset arriving after the first verified the account is refused here, and touches
 *    nothing.
 * 2. Sessions, API keys and passkeys go while it is shut.
 * 3. Only while the row still holds the reclaim's shut state: stamp `emailVerifiedAt` and lift it.
 *    An operator who disabled the account meanwhile wins, and the call is refused.
 *
 * A failure before step 3 leaves the account shut and unverified; running the reclaim again
 * finishes and reopens it. An account an operator had disabled is swept and verified and stays
 * disabled: a reset link is not how an operator's disable ends.
 */
export async function reclaimAccount(
  auth: Auth,
  userId: string,
  reason: string,
): Promise<ReclaimedAccount> {
  record('reclaimAccount', userId, reason);
  const adapter = auth.adapter;
  if (adapter.updateUserWhere === undefined) throw reclaimUnsupported(adapter.name);
  const found = await adapter.findUserById(userId);
  if (found === null) throw authWriteFailed('findUserById', 'x_users');
  if (found.emailVerifiedAt !== null) throw reclaimRefused(ALREADY_VERIFIED);
  const ours = found.disabledAt === null || found.disabledAt.getTime() === RECLAIMING.getTime();
  const shutAt = ours ? RECLAIMING : found.disabledAt;
  const shut = await adapter.updateUserWhere(
    userId,
    { emailVerifiedAt: null, disabledAt: found.disabledAt },
    { disabledAt: shutAt, passwordHash: null, mfaSecret: null, recoveryCodeHashes: [] },
  );
  if (shut === null) throw reclaimRefused(CHANGED);
  const now = auth.clock.now();
  const sessionsRevoked = await adapter.deleteSessionsForUser(userId);
  const apiKeysRevoked = await revokeOwnedApiKeys(auth, userId, now);
  let passkeysDeleted = 0;
  for (const passkey of await adapter.listPasskeys(userId)) {
    if (await adapter.deletePasskey(userId, passkey.id)) passkeysDeleted += 1;
  }
  const user = await adapter.updateUserWhere(
    userId,
    { emailVerifiedAt: null, disabledAt: shutAt },
    { emailVerifiedAt: now, ...(ours ? { disabledAt: null } : {}) },
  );
  if (user === null) throw reclaimRefused(CHANGED);
  return { user, sessionsRevoked, apiKeysRevoked, passkeysDeleted };
}
