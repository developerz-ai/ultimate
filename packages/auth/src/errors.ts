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

/** Codes this package declares and owns. `X_UNAUTHENTICATED` is auth's; http only borrows it. */
export const AUTH_OWNED_ERROR_CODES = [
  'X_UNAUTHENTICATED',
  'X_SESSION_EXPIRED',
  'X_MFA_REQUIRED',
  'X_MFA_SECRET_INVALID',
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
// `X_OVERLOADED` is `@ultimat3/http`'s, borrowed rather than re-declared: this package is the
// same tier and can never import http, but a refusal to start 19 MiB of argon2 work IS load
// shedding and must read as the same thing to a client (503 + Retry-After) whichever layer shed it.
export const AUTH_BORROWED_ERROR_CODES = [
  'X_FORBIDDEN',
  'X_NOT_IMPLEMENTED',
  'X_ENV_MISSING',
  'X_CONFIG_INVALID',
  'X_OVERLOADED',
] as const;

/** Every code auth can throw: the ones it owns plus the ones it borrows. */
export const AUTH_ERROR_CODES = [...AUTH_OWNED_ERROR_CODES, ...AUTH_BORROWED_ERROR_CODES] as const;

export type AuthOwnedErrorCode = (typeof AUTH_OWNED_ERROR_CODES)[number];
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const AUTH_ERROR_TITLES: Readonly<Record<AuthOwnedErrorCode, string>> = {
  X_UNAUTHENTICATED: 'no authenticated actor for this request',
  X_SESSION_EXPIRED: 'session passed its idle or absolute expiry',
  X_MFA_REQUIRED: 'a second factor is required before this session is usable',
  X_MFA_SECRET_INVALID: 'the totp secret is not base32, so it carries no key to check a code with',
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
    // No `docs:`: `UltimateError` fills it from `describeErrorCode(code).docs`. The
    // `https://ultimate.dev/errors/<code>` link this built until 9.x answered 404, host and all.
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
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

/**
 * Shed BEFORE the KDF runs, the same decision `@ultimat3/http`'s `admit` stage makes for a whole
 * request. `retryAfterSeconds` rides in `meta` because this package cannot reach an HTTP header;
 * the host reads it onto `Retry-After`.
 */
export const kdfOverloaded = (active: number, queued: number): AuthError =>
  new AuthError({
    code: 'X_OVERLOADED',
    cause: `${active} password hashes are already running and ${queued} more are queued`,
    fix: 'retry after the Retry-After header; widen the ceiling with configureKdfGate({ maxConcurrent, maxQueued }) only if the box has the memory — every argon2id hash holds ~19 MiB while it runs',
    meta: { active, queued, retryAfterSeconds: 1 },
  });

/**
 * The second leg is the APP's, and this line says so — it named `POST /auth/mfa/verify` for a
 * release while no such route, no `completeMfa()` and no pending-MFA credential existed anywhere,
 * the same dead-`fix:` defect `oauth-paths.ts` exists to stop. Shipping that route from here would
 * be worse than saying nothing: the only correlation value this error carries is a user id, so the
 * route would be unauthenticated by construction and MFA would become the ONLY factor. The design
 * constraint for the real second leg is in `packages/auth/CLAUDE.md`.
 *
 * `userId` is `meta`, never `cause`: both surfaces that render this code to an anonymous caller
 * (`oauth-route.ts`'s `publicBody`, `@ultimat3/http`'s problem document) publish `cause` and drop
 * `meta`, and a user id handed to whoever typed the URL is what feeds the attack above.
 */
export const mfaRequired = (userId: string): AuthError =>
  new AuthError({
    code: 'X_MFA_REQUIRED',
    cause: 'this account has TOTP enrolled and the second factor has not been satisfied',
    fix: 'no second-factor route ships yet — catch X_MFA_REQUIRED in your sign-in handler, check the code with verifyTotp({ secret: user.mfaSecret, code, at }), then mint the session with createSession(auth.sessions, { userId, mfaSatisfied: true })',
    meta: { userId },
  });

/**
 * A stored or imported TOTP secret the decoder cannot read. `base32Decode` answers zero bytes for
 * any character outside the alphabet AND for `''`, and an HMAC keyed with zero bytes is a valid
 * HMAC — so `totpCode` was handing out a six-digit code derived from no secret at all, one shared
 * stream every malformed row in the table verified against. A code nobody had to know a secret to
 * compute is not a second factor, so there is no code to hand back: this refuses instead.
 *
 * `verifyTotp` does NOT throw it. A login checking a broken row is the generic failure, exactly as
 * `verifyAgainst` treats a stored hash Bun cannot read — a coded throw out of the verify path is a
 * 500 where a credential refusal belongs, and it answers "this account's secret is malformed" to
 * whoever asked. The secret itself never reaches `cause:` or `fix:`: it is a credential, and both
 * are logged.
 */
export const mfaSecretInvalid = (surface: string): AuthError =>
  new AuthError({
    code: 'X_MFA_SECRET_INVALID',
    cause: `${surface} was given a totp secret that is not RFC 4648 base32, so it decodes to zero bytes`,
    fix: 'issue a fresh one and store it: const { secret } = enrolTotp(auth, { account: user.email }) — an imported secret must be base32 (A-Z and 2-7, padding, spaces and dashes ignored) and decode to at least one byte',
  });

/**
 * `defineAuth({ mfa: { required: true } })`, refused where it is declared. The option read as a
 * security guarantee — "this deployment requires a second factor" — and nothing in this package
 * could make it true: `login()` and `signInWithOAuth()` branch on `user.mfaSecret` alone, so a
 * user who never enrolled was handed a fully-privileged session under it, and `actorFromUser`
 * strips privileges only for a user who HAS a secret, so there is no half-authenticated actor to
 * hand them instead. Enforcing it inside `login()` would refuse exactly the people with nothing to
 * offer, with no enrolment route shipped to send them to — a permanent lockout, not a second
 * factor. So the declaration is refused at boot, exactly as `assertAuthLimiterPolicy` refuses a
 * per-process limiter under a fleet-wide lockout: a guarantee this package cannot show holds is
 * never assumed. `X_CONFIG_INVALID` is core's code, borrowed rather than re-declared.
 */
export const mfaRequiredUnenforceable = (): AuthError =>
  new AuthError({
    code: 'X_CONFIG_INVALID',
    cause:
      'defineAuth({ mfa: { required: true } }) declares a second factor this package does not enforce: login() mints a full session for any user whose mfaSecret is null',
    fix: 'drop required from defineAuth({ mfa }) and gate it in your own sign-in handler, which is where the enrolment route lives: if (user.mfaSecret === null) send them to enrolTotp(auth, { account: user.email }) instead of createSession(auth.sessions, ...)',
  });

/**
 * A policy NUMBER that is not one, refused where `defineAuth` still names the key.
 *
 * Every one of these arrives as `Number(process.env.SESSION_TTL_MS)` as often as a literal, and
 * that is `NaN` for an unset variable — not nullish, so the spread over the defaults keeps it, and
 * then every comparison it reaches is false. What that produces is not a short session or a weak
 * password, it is the RULE not existing: `now >= NaN` is false, so a session never expires on
 * either clock; `password.length < NaN` is false, so the empty password was accepted. Both were
 * measured. `X_CONFIG_INVALID` is core's code, borrowed rather than re-declared, beside
 * `mfaRequiredUnenforceable` above and for the same reason — a declaration this package cannot
 * honour is not a new kind of failure.
 */
export const authPolicyNumberInvalid = (
  key: string,
  value: number,
  expected: string,
  consequence: string,
): AuthError =>
  new AuthError({
    code: 'X_CONFIG_INVALID',
    cause: `defineAuth({ ${key}: ${String(value)} }) is not ${expected}; ${consequence}, so the rule is not enforced at all rather than enforced wrongly — and NaN is what Number(process.env.…) answers for an unset variable`,
    fix: `pass ${expected} for ${key} in defineAuth, and parse an environment value before you pass it — Number.parseInt(process.env.AUTH_TTL_MS ?? '', 10) is NaN when the variable is unset, so give it a default: Number.parseInt(process.env.AUTH_TTL_MS ?? '2592000000', 10)`,
    meta: { option: key, value: String(value) },
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
    // `kdfOverloaded`'s shape: `@ultimat3/http`'s `retryAfterOf` reads exactly this field. `key`
    // stays out — `cause`/`fix` escape it on purpose and `meta` is read by surfaces that do not.
    meta: { retryAfterSeconds },
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
 * A write the table's own UNIQUE constraint refuses. Same code as the write above, because it is
 * the same failure to an operator — the row is not there and the caller must not assume it is —
 * and the cause says which of the two happened.
 *
 * `MemoryAdapter` enforced neither `x_users.email` nor `x_users.external_id`, while `BuiltinAdapter`
 * leans on both: two `register()` calls at one address made TWO rows in memory, and the second was
 * unreachable forever because `findUserByEmail` returns the first. That adapter is what `x new`
 * scaffolds and what every test runs against, so the duplicate path was only exercised against the
 * permissive half of the seam.
 */
export const authUniqueViolation = (operation: string, table: string, column: string): AuthError =>
  new AuthError({
    code: 'X_AUTH_WRITE_FAILED',
    cause: `${operation} would add a second ${table} row with the same ${column}, which that column's unique constraint refuses`,
    fix: `look the row up first and update it — findUserByEmail(normaliseEmail(email)) — or write a different ${column}`,
    meta: { operation, table, column },
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
