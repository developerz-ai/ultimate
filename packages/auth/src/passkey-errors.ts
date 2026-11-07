// The three WebAuthn refusals, as factories over `AuthError`. They live apart from `errors.ts` so
// one mechanism's refusals read together and the code registry there stays under its file ceiling.

import { renderFixLiteral } from '@ultimat3/core';
import { AuthError } from './errors';

// Every `cause` below interpolates a value the caller supplied — a credential id, an origin, a
// digest — and every one is passed to `AuthError` raw. That is the contract, not an omission:
// `UltimateError`'s constructor runs all five fields through `singleLine()`, so one newline in an
// external value cannot write a second line into a line-oriented format (issue #97). Escaping here
// too would be a second place that has to be right. `passkey-errors.test.ts` pins it.

/**
 * Every rejection of a ceremony shares this one code: replayed challenge, tampered signature,
 * foreign origin, decreasing sign count, an assertion that never verified. Naming which of them it
 * was would tell an attacker which half of the ceremony to fix, and all of them have the same
 * answer for the caller — run the ceremony again against a fresh challenge.
 */
export const passkeyInvalid = (cause: string): AuthError =>
  new AuthError({
    code: 'X_PASSKEY_INVALID',
    cause,
    fix: 'await passkeyLogin(auth).login({ assertion })   # with a challenge from a fresh passkeyLogin(auth).loginOptions({ userId }), answered from an origin defineAuth({ passkeys: { origins } }) lists',
  });

/**
 * A challenge that was honest and simply outlived its `ttlMs`. Kept apart from `passkeyInvalid`
 * because it is the one refusal a caller may answer by retrying with nothing else changed, and
 * because an operator reading it learns the clock, not the crypto.
 */
export const passkeyChallengeExpired = (input: {
  readonly purpose: string;
  readonly expiredAt: Date;
}): AuthError => {
  // Read once through a guard, not `input.expiredAt.toISOString()` inline: a caller that hands an
  // Invalid Date over a cast would make `toISOString` throw a bare `RangeError` out of the factory,
  // so the one refusal an operator most wants to read would arrive as "Invalid time value".
  const expiredAt = Number.isNaN(input.expiredAt.getTime())
    ? 'an unrecorded instant'
    : input.expiredAt.toISOString();
  return new AuthError({
    code: 'X_PASSKEY_CHALLENGE_EXPIRED',
    cause: `the ${input.purpose} challenge expired at ${expiredAt}, so the assertion proves a ceremony that is no longer open`,
    fix: `await passkeyLogin(auth).loginOptions({ userId })   # one challenge lives ttlMs: mint a fresh one and answer it before this happens again — a clock more than a minute ahead of the server is the usual cause`,
    meta: { purpose: input.purpose, expiredAt },
  });
};

/**
 * Step-up's whole point: an assertion is evidence for a digest, and a valid assertion for another
 * digest is not evidence for this one. Raised at the seam, before the caller acts, so no surface
 * runs a privileged operation on a ceremony that approved a different request.
 */
export const passkeyStepUpRequired = (input: {
  readonly surface: string;
  readonly digest: string;
}): AuthError =>
  new AuthError({
    code: 'X_PASSKEY_STEP_UP_REQUIRED',
    cause: `${input.surface} needs a passkey assertion over this request digest, and no verified assertion covers it`,
    // The digest is a hash of the caller's own request body, so it is safe to echo — and it must
    // be echoed, or a caller with two requests in flight cannot tell which one it is being asked
    // to approve. `renderFixLiteral` because the value lands in JS source, where a string literal
    // has to quote and escape: `JSON.stringify` is the whole mechanism, and it never throws on a
    // string primitive.
    fix: `passkeyStepUp(auth, { ttlMs, challenge })   # this step-up's challenge() is handed { input: { requestDigest: ${renderFixLiteral(input.digest, '<requestDigest>')} } }: sign over that digest, then retry`,
    meta: { surface: input.surface, digest: input.digest },
  });
