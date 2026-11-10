# @ultimat3/auth — agent notes

Tier 2. Produces the `Actor`; produces nothing else. Authorization is `@ultimat3/policy`'s job.
A rule marked `†` has its full text in [`docs/history/auth-rules.md`](../../docs/history/auth-rules.md).

| Rule | |
|---|---|
| Deps | `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/db`. No external deps. |
| Never import | `@ultimat3/policy`, `@ultimat3/http` (tier 2 consumers), `@ultimat3/mail` (tier 4, upward) |
| Policy seam | `PolicyActorFields` in `policy-bridge.ts` mirrors policy's shape structurally |
| Http seam | `RequestLike` / `CookieJar` in `session.ts` and `AuthRouteDescriptor` in `oauth-route.ts`; http binds to them, not the reverse |
| Mail seam | injected `MailSender` port in `verify.ts`; the app wires `@ultimat3/mail`'s `send` |
| Better Auth | binds through `AuthAdapter`. It is an adapter, never a dependency. |
| Errors | `AuthError` from `errors.ts`; never `throw new Error` |
| Time | take a `Clock`. No `Date.now()` anywhere in this package. |
| Secrets | compare with `timingSafeEqual` (imported from `@ultimat3/core` — never re-exported here, same implementation `@ultimat3/storage` uses); store `sha256Hex`. Never `===` on a secret. |

## Non-negotiables

- **Every number this package bounds anything with is screened** (`policy-numbers.ts`,
  `assertFiniteAuthCount`); `mfa.drift` and the KDF gate HANG if unscreened. †
- **A number is screened ABOVE the write it feeds.** `issueVerification` screens its TTL before
  `putVerification` (which upserts on `(purpose, identifier)`); `verify.test.ts` asserts no row
  written, no mail sent, the earlier token still redeemable.
- **The minimum is per option; zero is often legitimate.** `assertFiniteAuthCount`'s `min` is
  `0 | 1`: `maxAgeSeconds: 0` is sign-out, `{ maxConcurrent: 0, maxQueued: 0 }` is how
  `password.test.ts` proves an unreadable hash burns the KDF. A TTL takes `min: 1`.
- Every credential failure throws `loginFailed()` — one code, one cause, one fix. Adding a
  parameter to it re-opens account enumeration.
- **`login()` takes an email or a handle** (`login-identity.ts`, `defineAuth({ handles })`).
- **A stored hash Bun cannot read is the generic failure, and it burns the same KDF**
  (`verifyAgainst`); an `X_OVERLOADED` is re-thrown. †
- **The limiter's table is bounded, and the eviction order is the guarantee.** Every bucket carries
  `forgetAtMs`; `policy.maxKeys` (`DEFAULT_MAX_AUTH_LIMIT_KEYS`) is the backstop, and a **live
  lockout outranks its own deadline** in the comparator. Never reduce that sort to recency.
- **`AuthLimiter` is a RESERVATION** (`reserve`/`refund`/`recordSuccess`), never check-then-record;
  `assertAuthLimiterPolicy` (`X_AUTH_LIMITER_NOT_SHARED`, `X_AUTH_LIMITER_POLICY_MISMATCH`). †
- **Every credential check runs through `openLoginAttempt`**: account → ip → org reserved, in that
  order, BEFORE the KDF or the TOTP compare. †
- **`postgresAuthLimiter` is the shared limiter**: ONE `x_auth_lockouts` row per key, a sliding
  window, a one-statement take; a live lockout is never rewritten. †
- **`installAuthLimiters` (`@ultimat3/auth/adapter`) is the HOST's install point and takes a
  FACTORY**: `config.limiter` → installed factory → `memoryAuthLimiter`. †
- **`normaliseEmail` is the ONE normalisation, ABOVE the `AuthAdapter` seam**: trim + lowercase,
  never a `+tag` or gmail dot; no adapter folds case. †
- **`json.ts` owns `isRecord` and `decodeJwtSegment`; no second copy.** An array is not a record.
  `decodeJwtSegment` answers `null` for all three failures; each caller raises its own refusal.
- Absolute and idle expiry are two separate computations in `sessionExpiry()`. Do not fold them.
- PKCE is not provider-dependent: `OAuthProvider.usesPkce` is the literal `true`.
- **Providers are a registry, `OAuthProviderId` is `string`.** The two built-ins seed it through
  `registerOAuthProvider()`, the call an app makes. `providerFor(id)` throws
  `X_OAUTH_PROVIDER_UNKNOWN`, never `undefined`; a second claim is `X_OAUTH_PROVIDER_DUPLICATE`.
- **`oauthProviderUnknown(provider, supported)` scopes its list to its reader**: the route passes
  `BUILTIN_OAUTH_PROVIDER_IDS` (an anonymous caller), `providerFor()` passes `oauthProviderIds()`.
- **`verifyIdToken({ keys })` is required, with no default.** `'token-endpoint-tls'` is the OIDC
  Core 3.1.3.7 exemption and `exchangeOAuthCode` is its only entitled caller; it defaults to
  `providerJwks` whenever there is a `jwksUri`. `HS256` and
  `alg: none` are refused in `decodeJwtHeader`. It checks `nbf` and `azp` too.
- **`resolveGrants` is a seam, never a group-to-role table**, called on EVERY login. Absent leaves
  the row alone. A user created with no roles and no org logs a warning. Its second argument is
  `OAuthGrantContext`; never a second userinfo reader. Full rule: `docs/history/auth.md`.
- **`verifySession` writes at most once per `idleSlideMs`** (default `idleTtlMs / 20`). Never cache
  the USER row — `authenticate` re-reads it every request so a revoked role bites on the next one.
  In `observed`, `null` is an ANSWER (clears the stored value) and `undefined` is silence.
- A user's `scopes` column reaches `Actor.scopes`.
- Every revocation takes a `reason` and logs `auth.revocation` before it runs.
  `deleteSessionsForOrg` joins through `x_users`; `x_sessions` does **not** gain an `org_id`.
- The code flow carries `nonce` inside the id token. `assertOAuthCallback` checks an echoed one when
  present and never requires it; `verifyIdToken` is the real gate.
- `sealHandshake`/`openHandshake` (a hand-built flow's server-side store): the provider is an
  argument, expiry the server's clock. **The handshake COOKIE is `oauthLogin`'s own**:
  `handshakeCookieName` IS `identityStateCookieName` (`__Host-x_sso_<p>`) and `handshakeCookie`
  seals `encodeOidcState`, so a built-in leg and a hand-built one read each other
  (`oauth-handshake-cookie.test.ts`). The read-only `__Host-x_oauth_<p>` fallback goes in 32.0.0.
- **`oauthLogin({ callbackPath })` is the one movable path** (`sign-in-callback-path.ts`): mount,
  `redirect_uri` and the checked URL from one pattern; the start path never moves.
- `takeVerification(purpose, identifier, tokenHash)` consumes **only on a hash match**, in one
  conditional statement (`consumed_at is null` on the UPDATE and its subselect,
  `order by created_at desc limit 1`); `consumeVerification` still compares in constant time.
  `consumed_at` is the adapter's `Clock`, bound, never `now()`.
- **Foreign text in a `cause:` goes through `renderCauseValue`, in a `fix:` through
  `renderFixLiteral`, and in a shell `fix:` through `renderFixShellArg`.** A line that would
  not run degrades to prose (core's `isFixShellSafe`); `oauth-discovery.ts` still owes it. Full rule: `docs/history/auth.md`.
- Cookies are read through `@ultimat3/core`'s `readCookie` (`readSessionCookie`, the oauth
  handshake), which never throws on a malformed value (`decodeURIComponent('%')`).
  They are WRITTEN through its `serializeSetCookie`, never a literal (`bun run set-cookie-literals`,
  `X_SET_COOKIE_HAND_BUILT`); `cookie-golden.test.ts` pins the bytes.
- A token endpoint's HTTP 200 is not success — read `error`.
- Link by address only when the provider **and** the local account both verified it
  (`link: 'verified-email'`, default; `'never'` is the only other value).
- **One sign-in route implementation** (`identity-provider-route-core.ts`) at
  `/auth/sso/:provider[/callback]`; failure is coded JSON, success a 303 to `successPath`. †
- Refresh is **not implemented**, so the framework **stores no provider token**: `accountFor`
  (`oauth-login.ts`) writes `accessToken: null, refreshToken: null`. The columns and `AuthAccount`
  fields stay; an app that stores tokens implements `linkAccount` itself.
- **`defineAuth({ providers })` defaults to `[]`** — name what you enabled.
- **A provider with no credentials answers the SAME 404 an unknown one does**: `credentialsFor`
  (`oauth-route.ts`) logs `auth.oauth.credentials_missing` and re-throws `oauthProviderUnknown`.
- **Nothing this package does not own reaches a published `cause:`** on the anonymous OAuth legs:
  an uncoded adapter throw logs `auth.oauth.uncoded_failure`, a rejecting `OAuthFetch` logs
  `auth.oauth.token_fetch_failed`, and the `POST /token` body is read as
  `providerDetail(response, 'coded-only')` (that request carries `client_secret`).
- **`x_users.mfa_secret` is SEALED** (`mfa-secret.ts`); an unsealed value is
  `X_MFA_SECRET_UNSEALED`. No plaintext fallback. †
- **`providerJwks` memoises only the DEFAULT client**; a caller supplying options gets its own.
- **A JWKS refresh is single-flighted through core's `singleFlight` with
  `deadlineMs = timeoutMs * 2`**; eviction frees the key, never the work, and a `generationFence`
  generation check (read, never `guard`) stops a superseded refresh overwriting the cache.
  `schedule` is injectable.
- **A failed JWKS refresh is rated and survivable, in `keyFor`, above the transport** (`JWKS_FAILURE_COOLDOWN_MS`,
  `JWKS_STALE_IF_ERROR_MS`; constants, no option). Full rule: `docs/history/auth.md`.
- **A success clears the ACCOUNT bucket and nothing else** — clearing the address bucket made the
  limiter inert against stuffing. A password proven with a second factor still owed clears
  NOTHING: `completeMfa` is what clears, or a repeat of the first leg wipes the wrong codes.
- **`MemoryAuthAdapter` enforces `x_users` uniqueness like Postgres and takes a `Clock`**
  (`authAdapterConformance` pins both adapters). †
- **`listUsersByOrg` orders by byte**: `collate "C"` in Postgres, a code-point compare in memory —
  never `localeCompare`, never UTF-16 `<` (`list-users-order.live.test.ts`, on an `en_US` db).
- Every `AuthAdapter` member is REQUIRED — a missing one is a compile error at `defineAuth`, and
  no caller in this package refuses at runtime with `X_NOT_IMPLEMENTED`.
- **An api key is its owner's credential**: `verifyApiKey` re-reads the owner after the secret
  matched; `disableUser` revokes their keys. †
- **`verifyApiKey` refuses an `env` segment that is not the stored prefix's, and touches
  `lastUsedAt` at most once per `API_KEY_TOUCH_MS`** — above the seam, so both adapters agree.
- **An authorization code is checked on `getCode`, spent by `takeCode` only after client, PKCE,
  redirect and resource held**; replay revocation needs the verifier. `pollDevice` takes the
  `clientId` and stamps nothing for another client's poll.
- **A key's scopes only ever shrink** (`apiKeyScopes`): wildcards refused, an owned key keeps only
  what its owner's grants cover. Never union with the owner's roles. †
- **`apiKeyResolver(() => store)` is the ONE token → caller mapping**; `X_API_KEY_INVALID` →
  `null`, all else rethrown. No second in-memory key store. †
- **`jwtBearerResolver` is its twin for an external JWT**: `checkWorkloadToken`'s checks, then
  scope, then `accept(raw)`. Every refusal — a throwing key source too — is `null` plus one
  `auth.jwt_bearer.refused` line naming the check, never a claim. `keys` is a thunk.
- Rotate the session id on any privilege change (`rotateSession`); **a new id, never a new
  lifetime**. A `passwordHash` change ends every other session. †
- **Every argon2 call goes through `kdfGate()`** (width 8, queue 64, `X_OVERLOADED`);
  `installKdfGate()` on `./adapter` is the ONE install point. †
- **MFA's second leg is `completeMfa(auth, challenge, code)`**; `X_MFA_REQUIRED`'s challenge is a
  `seal()` value. †
- **`mfa.required` is the literal `false`, and `defineAuth` refuses a `true`** (`X_CONFIG_INVALID`).
  `mfa.issuer` is read by `enrolTotp(auth, { account })`.
- **A TOTP secret that decodes to zero bytes is NO key**: `verifyTotp` returns the generic failure
  (`{ ok: false, step: null }`), `totpCode` and `enrolTotp` throw `X_MFA_SECRET_INVALID`. The secret
  never reaches `cause:`/`fix:`. No length floor beyond one byte.
- **`TotpReplayGuard` is one atomic `claim(subject, step, at): Promise<boolean>`**; a rejection is no verdict. Full rule: `docs/history/auth.md`.
- **`memoryTotpReplayGuard`'s table is bounded and the eviction ORDER is the guarantee.** Full rule: `docs/history/auth.md`.
- **Passkeys are verified by hand** (`passkey-*.ts`, `cbor.ts`, `cose-key.ts`): UV required, exact
  origin, compare-and-set counter, single-use challenges. †
- **SAML = `samlIdentityProvider`**, no dependency: assertion signature required, one assertion,
  metadata keys only, replay via `auth.totpReplay`, `trustEmail: true` needs `emailDomains`.

## Files

| File | Job |
|---|---|
| `auth.ts` | `defineAuth`, entity schemas, `login`/`register`/`authenticate`/`logout`. Suites: `auth.test.ts` (credential flow), `auth-config.test.ts` (defaults, refusals), `auth-lockout.test.ts` (tenant and address buckets) |
| `policy-bridge.ts` | the one funnel: identity → `Actor`, all four `ActorKind`s |
| `session.ts` | two expiries, rotation, revocation, device list, the cookie |
| `adapter.ts` | the seam; `builtin-adapter.ts` (Postgres) + `memory-adapter.ts` |
| `adapter-subpath.ts` | `@ultimat3/auth/adapter`: the `authLimiter`/`totpReplay`/`authServerStore` port types, their installers and resets, and `installKdfGate` |
| `authorization-server-installed.ts` | the `authServerStore` slot: `authorizationServer()` with no `store` reads it per CALL (never captured: `runtime.ts` may build the server first); empty, Postgres over the ambient pool |
| `builtin-adapter-violation.ts` | a Postgres unique violation on an auth table → `authUniqueViolation` |
| `rate-limit.ts` | per-ip, per-account and per-org buckets as reservations, lockout, scope check, `loginFailed()` |
| `login-attempt.ts` | one attempt's reservations across the three buckets, taken before the check and settled after it |
| `rate-limit-postgres.ts` | the SHARED limiter: one table, one row per key, a one-statement take, over a structural `PgExecutor` |
| `limiter-install.ts` | the host's one install point for that limiter — the factory, what it built, and the purge over it, and the TOTP guard's |
| `oauth.ts` | `OAuthProvider`, PKCE, `beginOAuth`, the callback gate. No I/O, no env |
| `oauth-builtins.ts` | the two shipped IdPs (`github`, `google`), as data. Imports only the type, so no cycle |
| `oauth-registry.ts` | the registry: `registerOAuthProvider`, `providerFor`, `oauthProviderIds` |
| `oauth-discovery.ts` | `/.well-known/openid-configuration` → an `OAuthProvider`. One `fetch` |
| `jwks.ts` | `crypto.subtle` signature verification, cached by `kid`, one shared in-flight refresh. No dependency |
| `workload.ts` | a workload JWT (K8s SA / SPIFFE / IMDS / RFC 8693) → a `ServiceIdentity`; `checkWorkloadToken`, the verdict form |
| `jwt-bearer-resolver.ts` | an external bearer JWT → `{ actor, scopes } \| null` |
| `revocation.ts` | per-user, per-org and before-an-instant sweeps; `disableUser` (sessions and api keys) |
| `mfa-challenge.ts` | the sealed challenge `X_MFA_REQUIRED` carries, and `completeMfa` |
| `mfa-replay-postgres.ts` | the shared replay guard: one table, the claim, the sweep |
| `mfa-secret.ts` | the TOTP secret at rest: seal on write, open on read, the one-shot that seals older rows |
| `directory.ts` | `describeUser` (allow-list projection), `listOrgUsers`, external-id lookup |
| `privileges.ts` | `updatePrivileges` — the grant, the rotation it requires, and the sessions a changed password ends |
| `oauth-cookie.ts` | the handshake's server-side codec: seal, open, secret, TTL |
| `oauth-handshake-cookie.ts` | the handshake as a cookie — the sign-in routes' own name and seal, plus the one-release legacy read |
| `sign-in-callback-path.ts` | the callback pattern: default or `callbackPath`, validated; mount, `redirect_uri`, provider segment |
| `oauth-exchange.ts` | `oauthCredentials` + the one POST to the token endpoint |
| `id-token.ts` | id token → claims this handshake may believe |
| `*-fixture.ts` | test-only, off `index.ts`: `id-token-` (the string-input JWT builder), `auth-` (KDF params, password, `AuthError` catcher for `auth*.test.ts`), `oauth-login-` (adapter, clock, profile) |
| `oauth-profile.ts` | claims or userinfo → one `OAuthProfile`; `userinfoBody`, the one userinfo reader |
| `oauth-grant-context.ts` | `resolveGrants`' second argument: tokens, every id-token claim, a lazy subject-checked `userinfo()` |
| `oauth-login.ts` | profile → account link → session. `completeOAuthLogin` is the entry point |
| `errors.ts` | the codes this package owns and borrows, their titles, the one `registerErrorCodes()` call, `AuthError`, and every non-OAuth factory |
| `oauth-errors.ts` | the OAuth refusals more than one OAuth module raises, and `restartAt`. A refusal with one thrower lives beside it; declares no code and registers nothing |
| `oauth-route.ts` | `oauthLogin(auth)`, the OAuth policy over the sign-in route core |
| `kdf-gate.ts` | the one bound on concurrent argon2 work: core's `flightGate`, auth's `X_OVERLOADED` |
| `email.ts` | `normaliseEmail` — the one normalisation an address gets before it is an identity key |
| `json.ts` | reading untrusted JSON: `isRecord`, and a base64url JWT segment as an object or `null` |
| `sign-out.ts` | `signOutHeaders({ session? })` — the expired session cookie plus `Clear-Site-Data: "cache", "storage"` (`SIGN_OUT_CLEAR_SITE_DATA`), never `"cookies"`. Secure contexts only |
| `subject-target.ts` | `authSubjectTarget({ executor, user })`: the identity tables as a `defineSubject({ targets })` entry, structural (`@ultimat3/jobs` imports nothing from here). Export = `AUTH_SUBJECT_COLUMNS` (never `password_hash`, `mfa_secret`, a recovery digest); erase = api keys, pending verifications, then the user (sessions, accounts cascade). Three idempotent statements, no transaction of its own |
| `passkey-login.ts` / `passkey-step-up.ts` / `passkey-evidence.ts` | the factories; the offline re-check. `passkey-verify.ts` + `passkey-assertion.ts` are every check; `*-postgres`/`*-memory` the store; `soft-authenticator.ts` (`./soft-authenticator`) the WebCrypto authenticator tests sign with |
| `client-scope.ts` | `clientScopeOf(actor)`, the OPAQUE id for `<meta name="ultimate-scope">`: keyed SHA-256 (`SESSION_SECRET`, else a per-process key and one warning) over kind, id, impersonator; `''` anonymous |
| `identity-provider*.ts` | SSO port, `signInWithIdentity`, OIDC adapter, route core, state cookie, status table |
| `saml-*.ts` | SAML adapter: strict XML reader, exc-c14n, XML-DSig, response checks, metadata, AuthnRequest |

```bash
bun test ./packages/auth/
bun run --filter @ultimat3/auth typecheck
```

Gotchas:
- `exactOptionalPropertyTypes` — declare optional fields as `x?: T | undefined`.
- `noUncheckedIndexedAccess` — index a `Record` into a local before narrowing it.
- `errors.ts` registers only the codes this package **owns**, unconditionally; borrowed ones
  (`X_FORBIDDEN`, `X_NOT_IMPLEMENTED`, …) sit untitled in `AUTH_BORROWED_ERROR_CODES`. Never a
  `hasErrorCode()` guard.
- Tests run against `MemoryAuthAdapter`; `authAdapterConformance` and `authServerStoreConformance`
  (`@ultimat3/testing/conformance`) run memory and Postgres through one suite each. The two
  Postgres guards pair a scripted twin with a `*.live.test.ts` (skips without `TEST_DATABASE_URL`).

Why each rule above is shaped the way it is: [`docs/history/auth.md`](../../docs/history/auth.md).
