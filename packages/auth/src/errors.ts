// Single responsibility: this package's stable X_ codes and the factories that build them.
// Auth is the one layer where a precise error message is itself a vulnerability, so the
// factories here are deliberately coarse — `rate-limit.ts` owns the single login failure
// every credential path must throw, and nothing else describes *why* a credential failed.

import {
  registerErrorCodes,
  renderCauseValue,
  renderFixLiteral,
  UltimateError,
} from '@ultimat3/core';
import { oauthStartPath } from './oauth-paths';

/** Codes this package declares and owns. `X_UNAUTHENTICATED` is auth's; http only borrows it. */
export const AUTH_OWNED_ERROR_CODES = [
  'X_UNAUTHENTICATED',
  'X_SESSION_EXPIRED',
  'X_MFA_REQUIRED',
  'X_OAUTH_STATE_INVALID',
  'X_OAUTH_EXCHANGE_FAILED',
  'X_OAUTH_TOKEN_INVALID',
  'X_OAUTH_PROVIDER_UNKNOWN',
  'X_OAUTH_PROVIDER_DUPLICATE',
  'X_OAUTH_DENIED',
  'X_PASSWORD_WEAK',
  'X_ACCOUNT_LOCKED',
  'X_API_KEY_INVALID',
  'X_AUTH_WRITE_FAILED',
  'X_AUTH_LIMITER_NOT_SHARED',
  'X_AUTH_LIMITER_POLICY_MISMATCH',
] as const;

/**
 * Codes another package owns that auth only throws: `X_FORBIDDEN` is `@ultimat3/policy`'s and
 * `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s. No titles here on purpose — a second copy of a title
 * is a title that drifts, and registering one of these would be `X_ERROR_CODE_DUPLICATE`.
 */
// `X_ENV_MISSING` and `X_CONFIG_INVALID` were thrown here long before they were declared here —
// oauth-cookie.ts and oauth-exchange.ts refuse on a missing secret, oauth-login.ts on a bad
// config. An undeclared borrow is a code the manifest cannot attribute to the package that throws
// it, so `x errors` could not point a reader at this file.
export const AUTH_BORROWED_ERROR_CODES = [
  'X_FORBIDDEN',
  'X_NOT_IMPLEMENTED',
  'X_ENV_MISSING',
  'X_CONFIG_INVALID',
] as const;

/** Every code auth can throw: the ones it owns plus the ones it borrows. */
export const AUTH_ERROR_CODES = [...AUTH_OWNED_ERROR_CODES, ...AUTH_BORROWED_ERROR_CODES] as const;

export type AuthOwnedErrorCode = (typeof AUTH_OWNED_ERROR_CODES)[number];
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const AUTH_ERROR_TITLES: Readonly<Record<AuthOwnedErrorCode, string>> = {
  X_UNAUTHENTICATED: 'no authenticated actor for this request',
  X_SESSION_EXPIRED: 'session passed its idle or absolute expiry',
  X_MFA_REQUIRED: 'a second factor is required before this session is usable',
  X_OAUTH_STATE_INVALID: 'oauth state, nonce or pkce verifier did not match',
  X_OAUTH_EXCHANGE_FAILED: 'the oauth provider refused the exchange or returned no usable identity',
  X_OAUTH_TOKEN_INVALID: 'id token failed its signature, issuer, audience or expiry check',
  X_OAUTH_PROVIDER_UNKNOWN: 'the URL named a provider this app has not enabled',
  X_OAUTH_PROVIDER_DUPLICATE: 'two oauth providers were registered under one id',
  X_OAUTH_DENIED: 'the user or the provider declined the authorization',
  X_PASSWORD_WEAK: 'password does not meet the configured policy',
  X_ACCOUNT_LOCKED: 'too many failed attempts; this key is locked out',
  X_API_KEY_INVALID: 'api key is unknown, revoked, expired or wrong',
  X_AUTH_WRITE_FAILED: 'an adapter write returned no row, so it cannot be confirmed',
  X_AUTH_LIMITER_NOT_SHARED: 'the lockout is declared fleet-wide and the limiter is per-process',
  X_AUTH_LIMITER_POLICY_MISMATCH: 'the limiter in use enforces other numbers than the app declared',
};

// Registered unconditionally, in one call: a second package claiming a code auth owns has to fail
// loudly as X_ERROR_CODE_DUPLICATE at import. A presence guard would turn that collision into
// whichever package loaded first deciding what the code means.
registerErrorCodes(
  Object.fromEntries(Object.entries(AUTH_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

/** Every code an `AuthError` may carry — the owned ones and the two borrowed ones alike. */
export type AuthThrowCode = AuthErrorCode;

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

/**
 * The two things that produce an anonymous actor on a surface that needs one, so the fix names
 * both: the request carried no `__Host-x_session` cookie, or it did and nothing resolved it.
 * `authenticate()` returns the anonymous actor for a missing cookie rather than throwing, which
 * is correct — and is exactly why the failure surfaces here, one layer later, instead of there.
 */
export const unauthenticated = (surface: string): AuthError =>
  new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause: `${surface} needs an actor but ctx.actor is anonymous`,
    fix: 'send the __Host-x_session cookie with this request, and resolve it once at the boundary: authenticate(auth, readSessionCookie(request, auth.sessions.policy))',
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
    // No lookup by cookie is offered, and that is deliberate: a forged id and a deleted session
    // are indistinguishable here by design. The reader signs in again; a developer holding a
    // user id can see what is still live without the cookie telling them anything.
    fix: 'sign in again to mint a fresh session — listDevices(auth.sessions, userId) lists the sessions still live for a user',
  });

export const mfaRequired = (userId: string): AuthError =>
  new AuthError({
    code: 'X_MFA_REQUIRED',
    cause: `user ${userId} has TOTP enrolled and this session has not satisfied it`,
    fix: 'POST /auth/mfa/verify { code } with the 6-digit code, then retry',
  });

/**
 * The `fix:` quotes `oauthStartPath` rather than a hand-written path. That is not tidiness: this
 * line shipped naming `GET /auth/oauth/<provider>` while `@ultimat3/auth` mounted no route at all,
 * so every caller who followed it hit a 404. One declaration, read by the mount and by the fix,
 * is what stops that recurring — `oauthLogin()` cannot move without moving this sentence.
 */
export const oauthStateInvalid = (provider: string, part: string): AuthError =>
  new AuthError({
    code: 'X_OAUTH_STATE_INVALID',
    cause: `${provider} callback rejected: ${part}`,
    fix: `${restartAt(provider)} — a callback URL is single-use`,
    meta: { provider },
  });

/** The one phrase every "start over" fix is built from, so none of them can name a dead route. */
export const restartAt = (provider: string): string =>
  `restart the flow at GET ${oauthStartPath(provider)}`;

/**
 * The provider came back with `error=` and no code — almost always the user pressing Cancel.
 * A separate code from `X_OAUTH_EXCHANGE_FAILED` on purpose: nothing was exchanged, nothing is
 * misconfigured, and folding the single commonest non-success outcome of a login into the code
 * that means "the client secret is wrong" makes both unreadable in a log and pages the wrong person.
 */
export const oauthDenied = (
  provider: string,
  reason: string,
  description: string | null,
): AuthError =>
  new AuthError({
    code: 'X_OAUTH_DENIED',
    // `reason` and `description` are query parameters off the callback URL — whatever the browser
    // was redirected with, newlines and quotes included. `renderCauseValue` renders them as JSON
    // string literals, so a forged `error_description` cannot forge a second log line or break the
    // sentence around it. Both are already `string` by type: this is escaping, not throw-safety.
    cause: `${provider} declined the authorization: ${renderCauseValue(reason)}${
      description === null ? '' : ` (${renderCauseValue(description)})`
    }`,
    fix: `${restartAt(provider)} and approve the ${provider} consent screen`,
    meta: { provider, reason },
  });

/**
 * A URL segment naming a provider no `registerOAuthProvider` call has claimed, or one that is but
 * was left out of `defineAuth({ providers })`. One refusal for both: which of the two it is
 * describes the app's configuration to an unauthenticated caller, and the fix is the same sentence
 * either way.
 *
 * **`supported` is the CALLER's to scope, because the two callers have two audiences.**
 * `oauth-route.ts` passes `BUILTIN_OAUTH_PROVIDER_IDS` — its reader is an anonymous stranger who
 * typed a URL, and the three built-ins are a framework constant already in the public docs, while
 * the live registry holds whatever internal OP this deployment registered. `providerFor()` passes
 * `oauthProviderIds()` — its reader is a developer holding a stack trace, and there the full list
 * is exactly what makes the fix runnable. Neither ever passes `defineAuth({ providers })`: naming
 * what this deployment turned on is the disclosure the shared refusal exists to prevent.
 *
 * The fix names `registerOAuthProvider` first so it stays executable for the branch the narrowed
 * list cannot cover — a segment nothing registered cannot be added to `providers` at all, so
 * "add it" alone was an instruction that could not be followed.
 *
 * The segment itself is a URL path the caller typed, so it goes through `renderCauseValue` in the
 * sentence and `renderFixLiteral` in the command — a fix has to parse after a hostile value lands
 * in it.
 */
export const oauthProviderUnknown = (provider: string, supported: readonly string[]): AuthError =>
  new AuthError({
    code: 'X_OAUTH_PROVIDER_UNKNOWN',
    cause: `no oauth provider is mounted at ${renderCauseValue(oauthStartPath(provider))}`,
    fix: `registerOAuthProvider({ id: ${renderFixLiteral(provider, '<id>')} }) if it is not built in, then add that id to defineAuth({ providers: [...] }) — known here: ${supported.map((id) => `'${id}'`).join(', ')}`,
    meta: { provider },
  });

/**
 * Two `registerOAuthProvider` calls claiming one id. A silent replacement would let whichever
 * module imported second decide where every login for that id goes — including which `issuers`
 * an id token may claim — so the second registration refuses at boot instead.
 */
export const oauthProviderDuplicate = (provider: string): AuthError =>
  new AuthError({
    code: 'X_OAUTH_PROVIDER_DUPLICATE',
    cause: `an oauth provider is already registered as ${renderCauseValue(provider)}, so the second registration would silently replace the first`,
    fix: `give one of them a different id, or delete the duplicate registerOAuthProvider({ id: ${renderFixLiteral(provider, '<id>')} }) call`,
    meta: { provider },
  });

export interface OAuthExchangeFailure {
  readonly provider: string;
  /**
   * Which leg of the server-to-server conversation failed. `discovery` and `jwks` are the two
   * boot/verification legs an enterprise OP adds: reading `/.well-known/openid-configuration`,
   * and reading the key set an id token's signature is checked against.
   */
  readonly stage: 'token' | 'userinfo' | 'discovery' | 'jwks';
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
 * `link: 'never'` and a local account already holds the address. Same code and same disclosure
 * rule as `oauthAccountNotLinked` — the caller proved to the provider that the address is theirs,
 * so naming the collision is not enumeration — and the address rides in `meta`, never in `cause`.
 */
export const oauthLinkingDisabled = (provider: string, email: string): AuthError =>
  new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause: `an account already holds this address and defineAuth({ link: 'never' }) forbids ${provider} from claiming it`,
    fix: "sign in with that account's own credentials, or set link: 'verified-email' in defineAuth to let a provider-verified address claim a locally-verified account",
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

/**
 * The escape is `recordSuccess(key)`, which is what a successful login already calls: it deletes
 * the bucket, so it clears exactly this one key and nothing else. `reset()` exists too and is the
 * wrong reach — it drops every bucket in the table, including the spray this lockout is holding.
 *
 * `key` carries an address or an email the caller chose, so it goes through `renderFixLiteral`:
 * a fix line has to still parse after a hostile value lands in it.
 */
export const accountLocked = (key: string, retryAfterSeconds: number): AuthError =>
  new AuthError({
    code: 'X_ACCOUNT_LOCKED',
    // `renderCauseValue`, matching `oauthDenied`: `ipKey(ip)` builds this key from whatever address
    // string its caller passed, so a newline in it writes a second log line an operator reads as
    // genuine. The value is `string` by type — the static scan only sees `unknown`/`any`, so this
    // one was never going to be caught for us — and rendering it as a JSON string literal is
    // escaping, not throw-safety.
    cause: `${renderCauseValue(key)} is locked out for another ${retryAfterSeconds}s after repeated failures`,
    fix: `wait ${retryAfterSeconds}s — or clear this one bucket: auth.limiter.recordSuccess(${renderFixLiteral(key, '<key>')}), auth.orgLimiter for an org: key — or raise defineAuth({ rateLimit })`,
  });

/** One shape for every api-key rejection: unknown, revoked, expired and wrong all look alike. */
export const apiKeyInvalid = (): AuthError =>
  new AuthError({
    code: 'X_API_KEY_INVALID',
    cause: 'the presented api key is unknown, revoked, expired or does not match its hash',
    // Which of the four it was is not named here and never will be — see the factory's contract
    // above — so the fix is the one action that resolves all four: issue a replacement.
    fix: 'issue a replacement: const { plaintext, record } = issueApiKey({ env, scopes }); await auth.adapter.putApiKey(record) — auth.adapter.listApiKeys(ownerId) through describeApiKey() shows which keys are still live',
  });

/**
 * A write whose `returning *` came back empty wrote nothing the caller may trust. Synthesising a
 * row from `{}` is what would let `register()` hand back a user with no id and no email — a
 * registration that reads as successful and authenticates nobody — so the adapter fails closed.
 */
export const authWriteFailed = (operation: string, table: string): AuthError =>
  new AuthError({
    code: 'X_AUTH_WRITE_FAILED',
    cause: `${operation} returned no row from ${table}, so the write cannot be confirmed`,
    fix: `x db migrate   # then, if ${table} is already there: x dev, and read it in the db panel at /_x`,
    meta: { operation, table },
  });

/**
 * At `defineAuth`, never at a login. `replicas: 3` behind one policy means each process counts
 * failures on its own, so the account survives `maxAttempts × 3` guesses and a lockout established
 * on one replica is invisible to the other two — a throttle that reads as configured and is not.
 */
export const authLimiterNotShared = (found: string): AuthError =>
  new AuthError({
    code: 'X_AUTH_LIMITER_NOT_SHARED',
    cause: `rateLimit.scope is 'shared' but the limiter in use is ${found}, so every replica would grant the full maxAttempts on its own`,
    fix: "pass a limiter whose scope is 'shared' — defineAuth({ adapter, limiter }) — or set rateLimit.scope: 'process' in defineAuth to accept per-replica lockouts",
    meta: { scope: found },
  });

/**
 * At `defineAuth`, never at a login. `Auth.rateLimit` is what an operator reads as "what this
 * deployment enforces", and an injected limiter counting to its own numbers makes that field a
 * claim nothing backs — five attempts declared, fifty granted, and every surface reporting five.
 * The policy is the app's single statement of the limits; this is what keeps it true.
 */
export const authLimiterPolicyMismatch = (
  field: string,
  declared: number,
  enforced: number,
): AuthError =>
  new AuthError({
    code: 'X_AUTH_LIMITER_POLICY_MISMATCH',
    cause: `defineAuth declares rateLimit.${field} = ${declared} but the limiter passed to it enforces ${enforced}; if ${enforced} is the number this deployment means to enforce, then the declaration is the half that is wrong`,
    fix: `construct the limiter with ${field}: ${declared} — defineAuth({ rateLimit, limiter }) compares the two, and the declaration is what Auth.rateLimit reports`,
    meta: { field, declared, enforced },
  });

/** For a custom `AuthAdapter` that implements part of the seam. Nothing shipped throws it. */
export const authNotImplemented = (feature: string, fix: string): AuthError =>
  new AuthError({
    code: 'X_NOT_IMPLEMENTED',
    cause: `${feature} is not implemented by the built-in driver`,
    fix,
  });
