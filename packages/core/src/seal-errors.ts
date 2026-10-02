// Single responsibility: the three X_SEAL_* refusals and the errors that carry them. Three codes
// rather than one "it will not open" because each names a different fact — no key at all, a key
// this process was not given, a value that did not authenticate — and a different thing to do
// next. No error here carries a key, a plaintext or the sealed string itself. Titles live in
// `core-error-codes.ts` and the retry class in `error-retry.ts`, so this module runs nothing at
// import and stays out of every bundle that does not seal.

import { renderCauseValue } from './error-render';
import { UltimateError } from './errors';

/**
 * No key in the environment and none on disk. Never a pass-through: storing the plaintext because
 * the key was missing is the failure a sealed column exists to prevent, and it would look healthy.
 */
export class SealKeyMissingError extends UltimateError {
  constructor(input: { envVar: string; keyPath: string }) {
    super({
      code: 'X_SEAL_KEY_MISSING',
      cause: `${input.envVar} is unset and ${input.keyPath} does not exist, so there is no master key to seal or open a value with`,
      fix: 'x secrets init   # or, where the key already exists: export ULTIMATE_SECRETS_KEY="$(cat .secrets.key)"',
      meta: { keyPath: input.keyPath },
    });
  }
}

/**
 * The value names a key id the ring does not hold — a rotation whose retired key was dropped
 * before the re-seal finished, or a value copied from another environment. `keyId` is matched
 * against 16 hex characters before it gets here, so it is safe to print; `declared` is computed.
 */
export class SealKeyUnknownError extends UltimateError {
  constructor(input: { keyId: string; declared: readonly string[] }) {
    super({
      code: 'X_SEAL_KEY_UNKNOWN',
      cause: `the sealed value names master key ${input.keyId}, which is not among the declared keys: ${input.declared.join(', ')} (current first)`,
      // The variable is written out, not interpolated: `x errors explain` prints this line with no
      // instance behind it. `seal.test.ts` holds it equal to `SECRETS_RETIRED_KEYS_ENV`.
      fix: `x secrets edit   # put the retired key back in ULTIMATE_SECRETS_RETIRED_KEYS (64 hex characters, comma-separated) and keep it there until the re-seal backfill() has finished`,
      meta: { keyId: input.keyId, declared: [...input.declared] },
    });
  }
}

export type SealInvalidReason = 'malformed' | 'unauthenticated';

/**
 * Either the string is not a sealed value at all, or the tag rejected it. AEAD cannot tell a wrong
 * purpose from changed bytes — both are "the tag did not verify" — so the cause names both rather
 * than guessing one and sending the reader after the wrong thing.
 */
export class SealInvalidError extends UltimateError {
  constructor(
    input:
      | { reason: 'malformed'; purpose?: string | undefined; length: number }
      | { reason: 'unauthenticated'; purpose: string; keyId: string },
  ) {
    const purpose =
      input.purpose === undefined ? '' : ` for purpose ${renderCauseValue(input.purpose)}`;
    super({
      code: 'X_SEAL_INVALID',
      cause:
        input.reason === 'malformed'
          ? `a ${input.length}-character string read${purpose} is not a sealed value (x1.<keyId>.<iv>.<ciphertext>) — it was never sealed, or it was truncated`
          : `the value did not authenticate under master key ${input.keyId}${purpose}: it was sealed for a different purpose, or its bytes changed after it was sealed — AES-GCM cannot tell the two apart`,
      // ONE literal covering both conditions, so `x errors explain` prints it without an instance.
      // A string that was never sealed is almost always a column sealed AFTER rows were written,
      // and no key fixes that: there is no reading of an unsealed value, so the rows are migrated.
      fix: 'x secrets show --json   # a value that failed its tag: confirms the key id in force, and the value must be re-entered. A value that was never sealed — a column sealed after rows were written — is migrated: add a NEW .sealed() column, copy into it with a backfill(), drop the old one',
      meta: {
        reason: input.reason,
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        ...(input.reason === 'unauthenticated' ? { keyId: input.keyId } : {}),
      },
    });
  }
}
