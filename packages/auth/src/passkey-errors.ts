// Single responsibility: the passkey refusals. Three codes, one each for the three things a caller
// does differently — retry the ceremony (`X_PASSKEY_INVALID`), fetch fresh options
// (`X_PASSKEY_CHALLENGE_EXPIRED`), or go and get a proof at all (`X_PASSKEY_STEP_UP_REQUIRED`).
// WHICH check failed is never in `cause:` — it is a log line's, the way `loginFailed()` is.

import { logger, renderCauseValue, renderFixLiteral } from '@ultimat3/core';
import { AuthError } from './errors';

/** Forged, tampered, wrong origin or rp id, no user verification, a counter that went back. */
export const passkeyInvalid = (ceremony: 'register' | 'login' | 'step-up'): AuthError =>
  new AuthError({
    code: 'X_PASSKEY_INVALID',
    cause: `the passkey ${ceremony} response did not pass verification`,
    fix:
      ceremony === 'register'
        ? 'x errors explain X_PASSKEY_INVALID --json, then run registration again: newPasskey(await passkeys.registerOptions({ userId }))'
        : 'x errors explain X_PASSKEY_INVALID --json, then sign in again: getPasskey(await passkeys.loginOptions())',
    callerFix: 'start the passkey ceremony again from fresh options',
    meta: { ceremony },
  });

/** The refusal, with the check that failed in a log line — the only place it is ever named. */
export const refusePasskey = (
  ceremony: 'register' | 'login' | 'step-up',
  check: string,
): AuthError => {
  logger.info('auth.passkey.refused', { ceremony, check });
  return passkeyInvalid(ceremony);
};

/** Unknown, already consumed, or past its TTL — replay and slowness answer the same. */
export const passkeyChallengeExpired = (ceremony: 'register' | 'login' | 'step-up'): AuthError =>
  new AuthError({
    code: 'X_PASSKEY_CHALLENGE_EXPIRED',
    cause: `the passkey ${ceremony} challenge is unknown, already used or past its ttl`,
    fix: 'x errors explain X_PASSKEY_CHALLENGE_EXPIRED --json, then fetch fresh options and run the ceremony once — every challenge is single-use',
    callerFix: 'fetch fresh options and run the passkey ceremony once',
    meta: { ceremony },
  });

export type StepUpMissing = 'no-proof' | 'other-digest' | 'no-passkey';

const STEP_UP_CAUSES: ReadonlyMap<StepUpMissing, string> = new Map([
  ['no-proof', 'the call carried no passkey assertion'],
  ['other-digest', 'the passkey assertion approved other bytes than the ones this call acts on'],
  ['no-passkey', 'this user has registered no passkey, so no step-up proof can be made'],
]);

export const passkeyStepUpRequired = (missing: StepUpMissing): AuthError =>
  new AuthError({
    code: 'X_PASSKEY_STEP_UP_REQUIRED',
    cause: STEP_UP_CAUSES.get(missing) ?? 'no fresh passkey proof',
    fix:
      missing === 'no-passkey'
        ? 'x errors explain X_PASSKEY_STEP_UP_REQUIRED --json, then register one: newPasskey(await passkeys.registerOptions({ userId }))'
        : 'x errors explain X_PASSKEY_STEP_UP_REQUIRED --json, then call stepUp.options({ userId, input }), run getPasskey(options) in the browser and resend the call with its response',
    callerFix: 'approve this action with your passkey, then send it again',
    meta: { missing },
  });

/** `defineAuth({ passkeys })` with a value the ceremonies cannot run on. */
export const passkeyConfigInvalid = (field: string, value: unknown, reason: string): AuthError =>
  new AuthError({
    code: 'X_CONFIG_INVALID',
    cause: `defineAuth({ passkeys: { ${field}: ${renderCauseValue(value)} } }) is refused: ${reason}`,
    fix: `defineAuth({ adapter, passkeys: { rpId: 'example.com', origins: ['https://example.com'] } }) — the rp id is the bare host every origin is on, never ${renderFixLiteral(value, 'that value')}`,
    meta: { option: `passkeys.${field}` },
  });

/** `passkeyLogin(auth)` / `passkeyStepUp(auth)` on an `Auth` that declared no `passkeys`. */
export const passkeysUndeclared = (factory: string): AuthError =>
  new AuthError({
    code: 'X_CONFIG_INVALID',
    cause: `${factory}(auth) was called on an Auth with no passkeys block, so there is no rp id or origin to verify against`,
    fix: "defineAuth({ adapter, passkeys: { rpId: 'example.com', origins: ['https://example.com'] } })   // in the module that builds this Auth",
    meta: { factory },
  });

/** A step-up `digest` callback that answered nothing, or a whole payload rather than a digest. */
export const stepUpDigestInvalid = (length: number): AuthError =>
  new AuthError({
    code: 'X_CONFIG_INVALID',
    cause: `passkeyStepUp's digest callback answered ${length} bytes; a digest is 1 to ${MAX_STEP_UP_DIGEST_BYTES}`,
    fix: 'passkeyStepUp(auth, { digest: ({ input }) => sha256Hex(JSON.stringify(input)) })   // hash what the person approves; never return the payload itself',
    meta: { length },
  });

/** A SHA-512 in hex is 128 bytes; this leaves room for a versioned, prefixed one. */
export const MAX_STEP_UP_DIGEST_BYTES = 1024;
