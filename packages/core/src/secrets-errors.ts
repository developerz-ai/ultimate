// Single responsibility: the seven X_SECRETS_* conditions and the errors that carry them. Split
// from `secrets.ts` so the crypto module reads as crypto — and there are seven codes rather than
// one "secrets are broken" because each names a different thing an operator did and a different
// command that undoes it. No error here ever carries a key, a ciphertext or a decrypted value.

import { registerErrorCodes } from './error-codes';
import { UltimateError } from './errors';

/** Codes `@ultimat3/core` owns for the encrypted-secrets file. */
export const SECRETS_ERROR_CODES = [
  'X_SECRETS_KEY_MISSING',
  'X_SECRETS_KEY_INVALID',
  'X_SECRETS_KEY_MISMATCH',
  'X_SECRETS_FILE_MISSING',
  'X_SECRETS_FILE_INVALID',
  'X_SECRETS_TAMPERED',
  'X_SECRETS_PLAINTEXT_INVALID',
] as const;

export type SecretsErrorCode = (typeof SECRETS_ERROR_CODES)[number];

const SECRETS_ERROR_TITLES: Readonly<Record<SecretsErrorCode, string>> = {
  X_SECRETS_KEY_MISSING: 'no master key for the encrypted secrets file',
  X_SECRETS_KEY_INVALID: 'the master key is not 32 bytes of hex',
  X_SECRETS_KEY_MISMATCH: 'the secrets file was sealed with a different master key',
  X_SECRETS_FILE_MISSING: 'the encrypted secrets file does not exist',
  X_SECRETS_FILE_INVALID: 'the encrypted secrets file is not a readable envelope',
  X_SECRETS_TAMPERED: 'the secrets file failed its authentication tag',
  X_SECRETS_PLAINTEXT_INVALID: 'the decrypted secrets are not a flat map of env values',
};

// Registered here rather than in `error-codes.ts`'s `CORE_CODE_TITLES` because these codes and the
// module that throws them ship together: `registerErrorCodes` is the documented way a set of codes
// joins the registry, and it raises `X_ERROR_CODE_DUPLICATE` if anything else ever claims one.
registerErrorCodes(
  Object.fromEntries(
    Object.entries(SECRETS_ERROR_TITLES).map(([code, title]) => [code, { title }]),
  ),
);

/**
 * No key in the environment and none on disk, while an encrypted file exists. Deliberately fatal
 * rather than a warning: booting without the secrets a deploy was configured with produces an app
 * that authenticates against nothing and reports itself healthy.
 */
export class SecretsKeyMissingError extends UltimateError {
  constructor(input: { envVar: string; keyPath: string }) {
    super({
      code: 'X_SECRETS_KEY_MISSING',
      cause: `${input.envVar} is unset and ${input.keyPath} does not exist, so nothing can open the encrypted secrets`,
      fix: `export ${input.envVar}="$(cat ${input.keyPath})"   # in a repo that has no key yet: x secrets init`,
      meta: { keyPath: input.keyPath },
    });
  }
}

/** Key material that is not 64 lowercase hex characters. A truncated paste is the usual cause. */
export class SecretsKeyInvalidError extends UltimateError {
  constructor(input: { at: string; found: number; expected: number }) {
    super({
      code: 'X_SECRETS_KEY_INVALID',
      cause: `the master key in ${input.at} is ${input.found} character(s); an AES-256 key is ${input.expected} lowercase hex characters`,
      fix: `export ULTIMATE_SECRETS_KEY="$(cat .secrets.key)"   # the key file holds the ${input.expected} characters verbatim, no newline of its own`,
      meta: { at: input.at },
    });
  }
}

/**
 * A well-formed key that is not the one this file was sealed with. Distinguishable from tampering
 * only because the envelope carries a key id — a domain-separated SHA-256 of the key, which is
 * safe to commit and is what turns "it will not decrypt" into two different instructions.
 */
export class SecretsKeyMismatchError extends UltimateError {
  constructor(input: { at: string; keyAt: string; sealedWith: string; found: string }) {
    super({
      code: 'X_SECRETS_KEY_MISMATCH',
      cause: `${input.at} was sealed with master key ${input.sealedWith} and ${input.keyAt} holds ${input.found}`,
      fix: `git checkout -- ${input.at}   # or point ULTIMATE_SECRETS_KEY at the key whose id is ${input.sealedWith}`,
      meta: { at: input.at, sealedWith: input.sealedWith, found: input.found },
    });
  }
}

/** No encrypted file at all — this repo has never run `x secrets init`. */
export class SecretsFileMissingError extends UltimateError {
  constructor(input: { at: string }) {
    super({
      code: 'X_SECRETS_FILE_MISSING',
      cause: `${input.at} does not exist, so this app declares no encrypted secrets`,
      fix: 'x secrets init',
      meta: { at: input.at },
    });
  }
}

/**
 * The envelope itself will not parse: not JSON, an unknown version or algorithm, a header field
 * that is not base64, or a body too short to hold a 16-byte tag. Separate from `X_SECRETS_TAMPERED`
 * because nothing here got as far as authentication — this is a file a merge or an editor mangled.
 */
export class SecretsFileInvalidError extends UltimateError {
  constructor(input: { at: string; reason: string }) {
    super({
      code: 'X_SECRETS_FILE_INVALID',
      cause: `${input.at} ${input.reason}`,
      fix: `git checkout -- ${input.at}   # this file is written only by x secrets, never by hand`,
      meta: { at: input.at },
    });
  }
}

/**
 * The AES-256-GCM tag rejected the ciphertext or the header bound into it as AAD. Under a key whose
 * id already matched, that means the committed bytes changed after they were sealed — a bad merge,
 * a partial write, or an edit. Silent garbage is the alternative this code exists to prevent.
 */
export class SecretsTamperedError extends UltimateError {
  constructor(input: { at: string }) {
    super({
      code: 'X_SECRETS_TAMPERED',
      cause: `the AES-256-GCM authentication tag rejected ${input.at}: the ciphertext or its header changed after it was sealed`,
      fix: `git checkout -- ${input.at}   # then confirm the restored file opens: x secrets show --json`,
      meta: { at: input.at },
    });
  }
}

/**
 * Decryption succeeded and the payload is not what a secrets file holds. Reachable two ways: an
 * `x secrets edit` buffer saved as something other than a flat object, and a value that is not a
 * non-empty string. Both are refused BEFORE sealing, so a file that opens always installs.
 */
export class SecretsPlaintextInvalidError extends UltimateError {
  constructor(input: { at: string; reason: string }) {
    super({
      code: 'X_SECRETS_PLAINTEXT_INVALID',
      cause: `the secrets for ${input.at} ${input.reason}`,
      fix: 'x secrets edit   # the buffer is one flat JSON object: {"SESSION_SECRET": "s3cr3t"} — env var names to non-empty strings',
      meta: { at: input.at },
    });
  }
}
