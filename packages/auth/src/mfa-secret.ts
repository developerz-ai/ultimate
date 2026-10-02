// Single responsibility: the second-factor secret at rest. A TOTP seed is symmetric — verifying a
// code needs the seed itself — so it is sealed under the app's master key, never hashed and never
// stored in the clear. One writer, one reader, and the one-shot that seals what predates them.

import { isSealed, openText, type SealKeySource, seal } from '@ultimat3/core';
import type { UserStore } from './adapter';
import { authWriteFailed, mfaSecretInvalid, mfaSecretUnsealed } from './errors';
import { base32Decode } from './mfa';

/** The slice of the seam this file reads and writes — what a CLI holding only a database can supply. */
export interface MfaSecretStore {
  readonly adapter: Pick<UserStore, 'listUsersWithMfaSecret' | 'replaceMfaSecret' | 'updateUser'>;
}

/** Bound into the tag: a value sealed for any other column does not open as a TOTP secret. */
export const MFA_SECRET_PURPOSE = 'auth:x_users.mfa_secret';

/**
 * Enrolment's write: the base32 secret `enrolTotp` answered, sealed, onto the user's row. The
 * ONLY way a secret should reach `x_users.mfa_secret` — a value written past this is refused by
 * every reader until `sealMfaSecrets` has sealed it.
 */
export async function saveTotpSecret(
  auth: MfaSecretStore,
  userId: string,
  secret: string,
  keys: SealKeySource = {},
): Promise<void> {
  // A secret nothing can derive a code from is refused before it is sealed: sealed, it would be
  // an opaque value nobody could tell was a lockout.
  if (typeof secret !== 'string' || base32Decode(secret).length === 0) {
    throw mfaSecretInvalid('saveTotpSecret');
  }
  const sealed = await seal(secret, { ...keys, purpose: MFA_SECRET_PURPOSE });
  const user = await auth.adapter.updateUser(userId, { mfaSecret: sealed });
  if (user === null) throw authWriteFailed('updateUser', 'x_users');
}

/**
 * The base32 secret behind a stored value. A value that is not sealed is REFUSED, never read as
 * the secret it probably is: a plaintext read kept "for now" is a plaintext column forever.
 */
export async function openTotpSecret(stored: string, keys: SealKeySource = {}): Promise<string> {
  if (!isSealed(stored)) throw mfaSecretUnsealed();
  return await openText(stored, { ...keys, purpose: MFA_SECRET_PURPOSE });
}

export interface SealMfaSecretsReport {
  /** Values that were plaintext and are now sealed. */
  readonly sealed: number;
  /** Values that were already sealed, and were left exactly as they were. */
  readonly alreadySealed: number;
  /**
   * Rows whose secret changed between the read and the write — the user re-enrolled, or
   * un-enrolled, mid-run — and were left alone. A new enrolment is already sealed.
   */
  readonly skipped: number;
}

/** How many stored secrets are still plaintext — what `x doctor` reports before a user finds out. */
export async function countUnsealedMfaSecrets(auth: MfaSecretStore): Promise<number> {
  const stored = await auth.adapter.listUsersWithMfaSecret();
  return stored.filter((row) => !isSealed(row.mfaSecret)).length;
}

/**
 * The one-shot behind `x auth seal-mfa`: every plaintext `mfa_secret` sealed in place. Idempotent
 * — a sealed value is counted and never touched — so a run that stopped half way is finished by
 * running it again. The master key is resolved by the first `seal`, before any row is written.
 *
 * Each write is a compare-and-set on the value that was read: a row that changed underneath is
 * `skipped`, never overwritten with the secret it used to hold.
 */
export async function sealMfaSecrets(
  auth: MfaSecretStore,
  keys: SealKeySource = {},
): Promise<SealMfaSecretsReport> {
  let sealed = 0;
  let alreadySealed = 0;
  let skipped = 0;
  for (const row of await auth.adapter.listUsersWithMfaSecret()) {
    if (isSealed(row.mfaSecret)) {
      alreadySealed += 1;
      continue;
    }
    const value = await seal(row.mfaSecret, { ...keys, purpose: MFA_SECRET_PURPOSE });
    if (await auth.adapter.replaceMfaSecret(row.userId, row.mfaSecret, value)) sealed += 1;
    else skipped += 1;
  }
  return { sealed, alreadySealed, skipped };
}
