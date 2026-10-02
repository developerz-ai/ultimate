// Single responsibility: the second leg of a sign-in. The first leg ends in `X_MFA_REQUIRED`
// carrying a sealed, short-lived challenge; `completeMfa` opens it, meters the code against the
// same buckets a password guess spends, and only then mints the session.

import { isUltimateError, openText, randomHex, type SealKeySource, seal } from '@ultimat3/core';
import type { Auth, LoginResult } from './auth';
import { type AuthError, mfaChallengeInvalid, mfaCodeRejected, mfaRequired } from './errors';
import { isRecord } from './json';
import { openLoginAttempt } from './login-attempt';
import { recoveryCodeHash, TOTP_DIGITS, verifyTotp } from './mfa';
import { openTotpSecret } from './mfa-secret';
import { resolveActor } from './policy-bridge';
import { accountKey } from './rate-limit';
import { createSession, sessionCookie } from './session';

/** Bound into the seal's tag: a value sealed for anything else does not open as a challenge. */
export const MFA_CHALLENGE_PURPOSE = 'auth:mfa-challenge';

/** Long enough to unlock a phone and read six digits; short enough that a lifted one is stale. */
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface MfaChallenge {
  readonly userId: string;
  /** Makes two challenges for one user at one instant different values. */
  readonly nonce: string;
  readonly expiresAtMs: number;
}

/**
 * The refusal `login()` and the OAuth path end their first leg with, carrying the challenge in
 * `meta.challenge`. Sealed under the app's master key (`x secrets init`), so it needs no table and
 * no second secret — and a deployment that enrols a second factor without one fails here, loudly,
 * with `X_SEAL_KEY_MISSING`.
 */
export async function mfaChallengeRequired(
  auth: Auth,
  userId: string,
  keys: SealKeySource = {},
): Promise<AuthError> {
  const challenge: MfaChallenge = {
    userId,
    nonce: randomHex(16),
    expiresAtMs: auth.clock.now().getTime() + MFA_CHALLENGE_TTL_MS,
  };
  return mfaRequired(
    await seal(JSON.stringify(challenge), { ...keys, purpose: MFA_CHALLENGE_PURPOSE }),
  );
}

/** A seal that would not open is a bad challenge; a missing master key is a broken deployment. */
const UNOPENABLE: ReadonlySet<string> = new Set(['X_SEAL_INVALID', 'X_SEAL_KEY_UNKNOWN']);

async function openChallenge(
  auth: Auth,
  token: unknown,
  keys: SealKeySource,
): Promise<MfaChallenge> {
  if (typeof token !== 'string' || token.length === 0) throw mfaChallengeInvalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await openText(token, { ...keys, purpose: MFA_CHALLENGE_PURPOSE }));
  } catch (thrown) {
    if (isUltimateError(thrown) && !UNOPENABLE.has(thrown.code)) throw thrown;
    throw mfaChallengeInvalid();
  }
  if (!isRecord(parsed)) throw mfaChallengeInvalid();
  const { userId, nonce, expiresAtMs } = parsed;
  if (typeof userId !== 'string' || typeof nonce !== 'string' || typeof expiresAtMs !== 'number') {
    throw mfaChallengeInvalid();
  }
  // The server's clock decides. `>=` on a number that is not one is false, so a NaN is refused
  // by asking the question the way round that fails closed.
  if (!(auth.clock.now().getTime() < expiresAtMs)) throw mfaChallengeInvalid();
  return { userId, nonce, expiresAtMs };
}

export interface CompleteMfaOptions extends SealKeySource {
  /** The caller's address: a wrong code counts against it, exactly as a wrong password does. */
  readonly ip?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
}

/** What an authenticator app shows, once the spaces a person types are gone. */
const TOTP_SHAPE = new RegExp(`^[0-9]{${TOTP_DIGITS}}$`);

/**
 * Finish a sign-in that stopped at `X_MFA_REQUIRED`: the challenge from `error.meta.challenge`
 * and either the six digits or one recovery code. Answers what `login()` answers.
 *
 * The guess is RESERVED before the code is looked at, against the account, the address and the
 * tenant — the buckets a password guess spends — so six digits are worth `maxAttempts` tries per
 * window and no more, and a wrong code is followed by `X_ACCOUNT_LOCKED`. A code is good once:
 * a TOTP step is remembered in `auth.totpReplay`, and a recovery code is consumed by the adapter
 * in one atomic step, so two requests carrying one code cannot both finish.
 */
export async function completeMfa(
  auth: Auth,
  challengeToken: string,
  code: string,
  options: CompleteMfaOptions = {},
): Promise<LoginResult> {
  const challenge = await openChallenge(auth, challengeToken, options);
  const user = await auth.adapter.findUserById(challenge.userId);
  if (user === null || user.disabledAt !== null || user.mfaSecret === null) {
    throw mfaChallengeInvalid();
  }

  // Before anything is reserved: a stored value that is not sealed is the deployment's fault,
  // not a guess, and it is refused (`X_MFA_SECRET_UNSEALED`) rather than read.
  const secret = await openTotpSecret(user.mfaSecret, options);

  const ip = options.ip ?? null;
  const attempt = await openLoginAttempt(auth, accountKey(user.email), ip);
  await attempt.reserveOrg(user.orgId);

  const presented = typeof code === 'string' ? code.replaceAll(' ', '') : '';
  if (TOTP_SHAPE.test(presented)) {
    const now = auth.clock.now();
    const verdict = verifyTotp({ secret, code: presented, at: now });
    // Checked and remembered with no `await` between them: two concurrent completions carrying
    // one code cannot both find the step unspent.
    if (!verdict.ok || verdict.step === null || auth.totpReplay.isUsed(user.id, verdict.step)) {
      throw mfaCodeRejected();
    }
    auth.totpReplay.remember(user.id, verdict.step, now);
  } else {
    let consumed: boolean;
    try {
      consumed = await auth.adapter.consumeRecoveryCode(user.id, recoveryCodeHash(presented));
    } catch (thrown) {
      // A store that is down reached no verdict, so the guess is not counted as a wrong one.
      await attempt.release();
      throw thrown;
    }
    if (!consumed) throw mfaCodeRejected();
  }
  await attempt.succeed();

  const issued = await createSession(auth.sessions, {
    userId: user.id,
    ip,
    userAgent: options.userAgent,
    mfaSatisfied: true,
  });
  return {
    actor: resolveActor({ kind: 'user', user, session: issued.session }),
    session: issued.session,
    token: issued.token,
    cookie: sessionCookie(issued.token, auth.sessions.policy),
  };
}
