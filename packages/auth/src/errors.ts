// Single responsibility: this package's stable X_ codes and the factories that build them.
// Auth is the one layer where a precise error message is itself a vulnerability, so the
// factories here are deliberately coarse — `rate-limit.ts` owns the single login failure
// every credential path must throw, and nothing else describes *why* a credential failed.

import { hasErrorCode, registerErrorCodes, UltimateError } from '@ultimat3/core';

export const AUTH_ERROR_CODES = [
  'X_UNAUTHENTICATED',
  'X_SESSION_EXPIRED',
  'X_MFA_REQUIRED',
  'X_OAUTH_STATE_INVALID',
  'X_OAUTH_EXCHANGE_FAILED',
  'X_OAUTH_TOKEN_INVALID',
  'X_PASSWORD_WEAK',
  'X_ACCOUNT_LOCKED',
  'X_API_KEY_INVALID',
  'X_NOT_IMPLEMENTED',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const AUTH_ERROR_TITLES: Readonly<Record<AuthErrorCode, string>> = {
  X_UNAUTHENTICATED: 'no authenticated actor for this request',
  X_SESSION_EXPIRED: 'session passed its idle or absolute expiry',
  X_MFA_REQUIRED: 'a second factor is required before this session is usable',
  X_OAUTH_STATE_INVALID: 'oauth state, nonce or pkce verifier did not match',
  X_OAUTH_EXCHANGE_FAILED: 'the oauth provider refused the exchange or returned no usable identity',
  X_OAUTH_TOKEN_INVALID: 'id token failed its issuer, audience or expiry check',
  X_PASSWORD_WEAK: 'password does not meet the configured policy',
  X_ACCOUNT_LOCKED: 'too many failed attempts; this key is locked out',
  X_API_KEY_INVALID: 'api key is unknown, revoked, expired or wrong',
  X_NOT_IMPLEMENTED: 'this driver does not implement the requested feature',
};

/** `X_FORBIDDEN` is owned by `@ultimat3/policy`. Guards reuse the code, never redefine it. */
export const AUTH_BORROWED_ERROR_TITLES: Readonly<Record<'X_FORBIDDEN', string>> = {
  X_FORBIDDEN: 'policy denied this actor',
};

// Titles must be registered for `format()` to render the contract's first line, but
// `X_NOT_IMPLEMENTED` belongs to core and `X_UNAUTHENTICATED`/`X_FORBIDDEN` may already be
// registered by http or policy — registering a code twice throws X_ERROR_CODE_DUPLICATE.
for (const [code, title] of Object.entries({
  ...AUTH_ERROR_TITLES,
  ...AUTH_BORROWED_ERROR_TITLES,
})) {
  if (!hasErrorCode(code)) registerErrorCodes({ [code]: { title } });
}

export type AuthThrowCode = AuthErrorCode | keyof typeof AUTH_BORROWED_ERROR_TITLES;

export class AuthError extends UltimateError {
  override readonly name = 'AuthError';

  constructor(init: {
    code: AuthThrowCode;
    cause: string;
    fix: string;
    meta?: Readonly<Record<string, unknown>> | undefined;
  }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: `https://ultimate.dev/errors/${init.code}`,
      meta: init.meta,
    });
  }
}

export const unauthenticated = (surface: string): AuthError =>
  new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause: `${surface} needs an actor but ctx.actor is anonymous`,
    fix: 'x auth whoami --json   # confirm the request carries the __Host-x_session cookie',
  });

export const forbidden = (surface: string, reason: string): AuthError =>
  new AuthError({
    code: 'X_FORBIDDEN',
    cause: `${surface} denied: ${reason}`,
    fix: 'x policy explain --json   # shows which grant the actor is missing',
  });

/** `kind` names which clock ran out — the two expiries are evaluated independently. */
export const sessionExpired = (kind: 'absolute' | 'idle', sessionId: string): AuthError =>
  new AuthError({
    code: 'X_SESSION_EXPIRED',
    cause: `session ${sessionId} passed its ${kind} expiry`,
    fix: `sign in again, or raise session.${kind}TtlMs in defineAuth({ session })`,
  });

export const sessionUnknown = (): AuthError =>
  new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause: 'the session cookie does not match any live session',
    fix: 'x auth sessions list --json   # then sign in again to mint a fresh session',
  });

export const mfaRequired = (userId: string): AuthError =>
  new AuthError({
    code: 'X_MFA_REQUIRED',
    cause: `user ${userId} has TOTP enrolled and this session has not satisfied it`,
    fix: 'POST /auth/mfa/verify { code } with the 6-digit code, then retry',
  });

export const oauthStateInvalid = (provider: string, part: string): AuthError =>
  new AuthError({
    code: 'X_OAUTH_STATE_INVALID',
    cause: `${provider} callback rejected: ${part}`,
    fix: `restart the flow at GET /auth/oauth/${provider} — a callback URL is single-use`,
  });

export interface OAuthExchangeFailure {
  readonly provider: string;
  /** Which leg of the server-to-server conversation failed. */
  readonly stage: 'token' | 'userinfo';
  readonly detail: string;
  readonly status?: number | undefined;
  readonly fix: string;
}

/**
 * Deliberately specific, unlike every credential error above it. This one describes a
 * conversation between two servers — naming the stage, the provider and its own status
 * discloses nothing about any user, and is the difference between a fixable misconfiguration
 * and a shrug.
 */
export const oauthExchangeFailed = (failure: OAuthExchangeFailure): AuthError =>
  new AuthError({
    code: 'X_OAUTH_EXCHANGE_FAILED',
    cause:
      `${failure.provider} ${failure.stage} request failed` +
      `${failure.status === undefined ? '' : ` with HTTP ${failure.status}`}: ${failure.detail}`,
    fix: failure.fix,
    meta: {
      provider: failure.provider,
      stage: failure.stage,
      ...(failure.status === undefined ? {} : { status: failure.status }),
    },
  });

/**
 * The address is proven to the provider, and an account that never proved it already holds it.
 * Naming that is not account enumeration — this caller just demonstrated they own the address —
 * and staying silent would leave them with a login that fails forever and no way out.
 *
 * The address itself rides in `meta`, never in `cause`: a log pipeline can redact a field by
 * key, and cannot redact an address that was already interpolated into a sentence.
 */
export const oauthAccountNotLinked = (provider: string, email: string): AuthError =>
  new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause: `an account holds this ${provider} address but never verified it, so ${provider} may not claim it`,
    fix: `sign in with that account's password and confirm the email-verify link, then retry ${provider}`,
    meta: { provider, email },
  });

/**
 * `CreateUserInput` carries no `emailVerifiedAt`, so a provider-verified address takes a second
 * write. Falling back to the unstamped row would mint a session for a user every later login
 * reads as unverified — the exact state `resolveUser` refuses to link a provider to — so the
 * flow fails closed on an adapter that loses the stamp instead of half-succeeding.
 */
export const emailVerifiedNotStored = (provider: string, userId: string): AuthError =>
  new AuthError({
    code: 'X_NOT_IMPLEMENTED',
    cause: `the adapter returned no row for new user ${userId}, so the ${provider}-verified address was never stamped verified`,
    fix: 'return the updated row from AuthAdapter.updateUser — MemoryAdapter.updateUser is the reference implementation',
    meta: { provider, userId },
  });

/** The token arrived, and is not one this handshake can trust: wrong `iss`, `aud`, or expired. */
export const oauthTokenInvalid = (provider: string, reason: string, fix: string): AuthError =>
  new AuthError({
    code: 'X_OAUTH_TOKEN_INVALID',
    cause: `${provider} id token rejected: ${reason}`,
    fix,
    meta: { provider },
  });

export const passwordWeak = (reasons: readonly string[]): AuthError =>
  new AuthError({
    code: 'X_PASSWORD_WEAK',
    cause: `password rejected: ${reasons.join('; ')}`,
    fix: 'choose a longer, uncommon password — or relax defineAuth({ password: { minLength } })',
  });

export const accountLocked = (key: string, retryAfterSeconds: number): AuthError =>
  new AuthError({
    code: 'X_ACCOUNT_LOCKED',
    cause: `${key} is locked out for another ${retryAfterSeconds}s after repeated failures`,
    fix: `wait ${retryAfterSeconds}s, or run: x auth unlock ${key}`,
  });

/** One shape for every api-key rejection: unknown, revoked, expired and wrong all look alike. */
export const apiKeyInvalid = (): AuthError =>
  new AuthError({
    code: 'X_API_KEY_INVALID',
    cause: 'the presented api key is unknown, revoked, expired or does not match its hash',
    fix: 'x auth keys list --json   # then: x auth keys issue --scopes "<scope>"',
  });

/** For a custom `AuthAdapter` that implements part of the seam. Nothing shipped throws it. */
export const authNotImplemented = (feature: string, fix: string): AuthError =>
  new AuthError({
    code: 'X_NOT_IMPLEMENTED',
    cause: `${feature} is not implemented by the built-in driver`,
    fix,
  });
