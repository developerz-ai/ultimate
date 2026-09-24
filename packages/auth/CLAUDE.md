# @ultimat3/auth — agent notes

Tier 2. Produces the `Actor`; produces nothing else. Authorization is `@ultimat3/policy`'s job.

| Rule | |
|---|---|
| Deps | `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/db`. No external deps. |
| Never import | `@ultimat3/policy`, `@ultimat3/http` (tier 2 consumers), `@ultimat3/mail` (sideways) |
| Policy seam | `PolicyActorFields` in `policy-bridge.ts` mirrors policy's shape structurally |
| Http seam | `RequestLike` / `CookieJar` in `session.ts` and `AuthRouteDescriptor` in `oauth-route.ts`; http binds to them, not the reverse |
| Mail seam | injected `MailSender` port in `verify.ts`; the app wires `@ultimat3/mail`'s `send` |
| Better Auth | binds through `AuthAdapter`. It is an adapter, never a dependency. |
| Errors | `AuthError` from `errors.ts`; never `throw new Error` |
| Time | take a `Clock`. No `Date.now()` anywhere in this package. |
| Secrets | compare with `timingSafeEqual` (from `@ultimat3/core`, re-exported off `tokens.ts` — same implementation `@ultimat3/storage` uses); store `sha256Hex`. Never `===` on a secret. |

## Non-negotiables

- **Every number this package bounds anything with is screened** (`policy-numbers.ts`): policy
  numbers at `defineAuth` (`X_CONFIG_INVALID` — `session.absoluteTtlMs`, `idleTtlMs`,
  `idleSlideMs`, `password.minLength`, the two argon2 costs, every `rateLimit` number), and every
  runtime one through `assertFiniteAuthCount` — `jwks.ttlMs`, the three OAuth legs' `timeoutMs`
  (screened OUTSIDE each leg's `try`), the limiter's `maxKeys`, `mfa.drift`,
  `oauth.handshake.ttlMs`, `session.cookie.maxAgeSeconds`, `kdf.maxConcurrent`/`maxQueued`. A `NaN`
  makes every comparison false: no expiry, the empty password accepted, a year-old handshake
  opened. **`mfa.drift` and the KDF gate are the two that HANG** — mutate `verifyTotp` with the
  `NaN` case, never by deleting the screen (that wedges `mfa.test.ts`).
- **A number is screened ABOVE the write it feeds.** `issueVerification` screens its TTL before
  `putVerification` (which upserts on `(purpose, identifier)`); `verify.test.ts` asserts no row
  written, no mail sent, the earlier token still redeemable.
- **The minimum is per option; zero is often legitimate.** `assertFiniteAuthCount`'s `min` is
  `0 | 1`: `maxAgeSeconds: 0` is sign-out, `{ maxConcurrent: 0, maxQueued: 0 }` is how
  `password.test.ts` proves an unreadable hash burns the KDF. A TTL takes `min: 1`.
- Every credential failure throws `loginFailed()` — one code, one cause, one fix. Adding a
  parameter to it re-opens account enumeration.
- **A stored hash Bun cannot read is the generic failure, and it burns the same KDF.**
  `verifyAgainst` (`password.ts`) answers `null` for `Bun.password.verify`'s throw (unsupported
  algorithm, malformed PHC) and `''`, joining the no-user branch; nothing is logged. An
  `X_OVERLOADED` from the gate is RE-THROWN (a shed is load, not a verdict). Supported-but-old
  (bcrypt) stays a verdict and `needsRehash` flags it. `password.test.ts` pins both halves.
- **The limiter's table is bounded, and the eviction order is the guarantee.** Every bucket carries
  `forgetAtMs`; `policy.maxKeys` (`DEFAULT_MAX_AUTH_LIMIT_KEYS`) is the backstop, and a **live
  lockout outranks its own deadline** in the comparator. Never reduce that sort to recency.
- **`AuthLimiter` is async on every member and declares the policy it enforces.**
  `assertAuthLimiterPolicy` (once, in `defineAuth`) refuses a per-process limiter under
  `scope: 'shared'` (`X_AUTH_LIMITER_NOT_SHARED`) and different `maxAttempts`/`windowMs`/
  `lockoutMs` (`X_AUTH_LIMITER_POLICY_MISMATCH`). `maxKeys` is not compared. Nothing here reads the
  environment to guess a replica count.
- **`postgresAuthLimiter` is the shared limiter, a row per FAILURE** (sliding window: the count is
  `at_ms > now - windowMs`). The insert and the count are two statements, never one CTE, and the
  insert takes `pg_advisory_xact_lock` on the key so two outer transactions cannot both read one
  short (guarantee is READ COMMITTED). `auth.ts` records account → ip → org in that fixed order.
  `greatest` on the lockout upsert only extends. `PgExecutor` is structural: the pool is the host's.
- **`configureAuthLimiters` is the HOST's install point and takes a FACTORY**, called with the
  RESOLVED policy once per bucket; the comparison still runs on what comes back. Precedence:
  `config.limiter` → the installed factory → `createAuthLimiter`. `installedAuthLimiter` and
  `installedLimiterCount()` are NOT in `src/index.ts`. `purgeAuthLimits()` sweeps only the
  **widest** window among the built limiters (retained one per `windowMs` in a `Map`), on the
  limiter's own clock. `AuthLimiter.purgeExpired` is optional.
- **`normaliseEmail` is the ONE normalisation, it lives ABOVE the `AuthAdapter` seam, and no adapter
  may fold case.** Every door now normalises before the adapter sees the address — `register`,
  `login`, `profileEmail` in `oauth-login.ts`, `accountKey`, and `issueVerification`/
  `consumeVerification`. Trim and lowercase only; never strip a `+tag` or a gmail dot.
  `adapter-parity.test.ts` pins both adapters in one test.
- **`json.ts` owns `isRecord` and `decodeJwtSegment`; no second copy.** An array is not a record.
  `decodeJwtSegment` answers `null` for all three failures; each caller raises its own refusal.
- Absolute and idle expiry are two separate computations in `sessionExpiry()`. Do not fold them.
- PKCE is not provider-dependent: `OAuthProvider.usesPkce` is the literal `true`.
- **Providers are a registry, `OAuthProviderId` is `string`.** The three built-ins seed it through
  `registerOAuthProvider()`, the call an app makes. `providerFor(id)` throws
  `X_OAUTH_PROVIDER_UNKNOWN`, never `undefined`; a second claim is `X_OAUTH_PROVIDER_DUPLICATE`.
- **`oauthProviderUnknown(provider, supported)` scopes its list to its reader**: the route passes
  `BUILTIN_OAUTH_PROVIDER_IDS` (an anonymous caller), `providerFor()` passes `oauthProviderIds()`.
- **`verifyIdToken({ keys })` is required, with no default.** `'token-endpoint-tls'` is the OIDC
  Core 3.1.3.7 exemption and `exchangeOAuthCode` is its only entitled caller. `HS256` and
  `alg: none` are refused in `decodeJwtHeader`. It checks `nbf` and `azp` too.
- **`resolveGrants` is a seam, never a group-to-role table**, called on EVERY login. Absent leaves
  the row alone. A user created with no roles and no org logs a warning.
- **`verifySession` writes at most once per `idleSlideMs`** (default `idleTtlMs / 20`). Never cache
  the USER row — `authenticate` re-reads it every request so a revoked role bites on the next one.
  In `observed`, `null` is an ANSWER (clears the stored value) and `undefined` is silence.
- A user's `scopes` column reaches `Actor.scopes`.
- Every revocation takes a `reason` and logs `auth.revocation` before it runs.
  `deleteSessionsForOrg` joins through `x_users`; `x_sessions` does **not** gain an `org_id`.
- The code flow carries `nonce` inside the id token. `assertOAuthCallback` checks an echoed one when
  present and never requires it; `verifyIdToken` is the real gate.
- The handshake is sealed (`sealHandshake`); `openHandshake` takes the provider as an argument.
  Expiry is the server's clock, not `Max-Age`. One handshake cookie **per provider**
  (`handshakeCookieName`), and `clearHandshakeCookie(provider)`.
- `takeVerification(purpose, identifier, tokenHash)` consumes **only on a hash match**, in one
  conditional statement (`consumed_at is null` on the UPDATE and its subselect,
  `order by created_at desc limit 1`); `consumeVerification` still compares in constant time.
- **Foreign text in a `cause:` goes through `renderCauseValue`, in a `fix:` through
  `renderFixLiteral`, and in a shell `fix:` through `renderFixShellArg`.** Foreign here:
  `providerDetail()`'s return, `claims.iss`, `accountLocked`'s `key`, and every OAuth endpoint URL
  in a command position (`jwks.ts`, `oauth-profile.ts`, `oauth-exchange.ts`,
  `oauth-discovery.ts`) — the registry is filled by an issuer's own discovery document. A LINE
  that would not run degrades to prose: `jwks.ts`'s `readTheKeySet(tail)` decides with core's
  `isFixShellSafe`. `oauth-discovery.ts` still owes that repair (it keeps `auth` on
  `FIX_SHELL_ARG_PINS`). `${provider}` is registry-validated boot config, not foreign.
- `readCookie` never throws on a malformed value (`decodeURIComponent('%')`).
- A token endpoint's HTTP 200 is not success — read `error`.
- Link by address only when the provider **and** the local account both verified it
  (`link: 'verified-email'`, default; `'never'` is the only other value).
- **The OAuth route paths are not configurable.** `oauth-paths.ts` imports nothing and is read by
  both `oauth-errors.ts` and `oauth-route.ts`; every "start over" fix is `restartAt(provider)`.
- The routes are **descriptors** (`AuthRouteDescriptor`), never mounted handlers.
- The callback answers failure as **coded JSON**, and success redirects to a fixed `successPath` —
  never `?next=` (`nextAfterSignIn` in `@ultimat3/http` is the one open-redirect check).
- The handshake cookie is cleared on **every** callback outcome.
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
- **`x_users.mfa_secret` is a PLAINTEXT secret** and `tables.ts` says so; encrypting it needs a
  key-management seam this package does not have. Deferred deliberately.
- **`providerJwks` memoises only the DEFAULT client**; a caller supplying options gets its own.
- **A JWKS refresh is single-flighted through core's `createSingleFlight` with
  `deadlineMs = timeoutMs * 2`**; eviction frees the key, never the work, and a `createFence`
  generation check (read, never `guard`) stops a superseded refresh overwriting the cache.
  `schedule` is injectable.
- **A success clears the ACCOUNT bucket and nothing else** — clearing the address bucket made the
  limiter inert against stuffing.
- **`MemoryAdapter.createUser` enforces `x_users.email` and `x_users.external_id` uniqueness**
  (`authUniqueViolation`, `X_AUTH_WRITE_FAILED`), NULLS DISTINCT like Postgres.
  **`MemoryAdapter` takes a `Clock`** (default `systemClock`) and stamps every instant from it.
  `adapter-parity.test.ts` pins both.
- The newer `AuthAdapter` members are OPTIONAL (`findUserByExternalId`, `listUsersByOrg`,
  `deleteSessionsForUser`, `deleteSessionsForOrg`, `deleteSessionsCreatedBefore`); callers throw
  `X_NOT_IMPLEMENTED` naming the method.
- An api key's scopes are the agent actor's scopes. Never union them with the owner's roles.
- Rotate the session id on any privilege change (`rotateSession`, called by `updatePrivileges` in
  `privileges.ts`), never patch the row.
- **Every argon2 call goes through `kdfGate()`** — width 8, queue 64, `X_OVERLOADED` past it
  (borrowed from http, in `AUTH_BORROWED_ERROR_CODES`). The pool is core's `createFlightGate`, the
  refusal auth's own through core's `overflow:` seam. `configureKdfGate()` is the ONE install point
  and deliberately not a `defineAuth` key.
- **MFA has a first leg and no second one, and the second is not a route you can just add.**
  `login()` / `completeOAuthLogin()` throw `X_MFA_REQUIRED` before any session exists. A
  `POST /auth/mfa/verify { userId, code }` would be unauthenticated by construction. The follow-up
  needs three things together: a **sealed pending-MFA credential** built like `sealHandshake`, the
  completion as an `AuthRouteDescriptor` with its path in `oauth-paths.ts`'s style, and
  `auth.limiter` around `verifyTotp`. `TotpReplayGuard` is the completion's.
- **`mfa.required` is the literal `false`, and `defineAuth` refuses a `true`** (`X_CONFIG_INVALID`):
  enforcing it would lock out every un-enrolled user. `mfa.issuer` is read by
  `enrolTotp(auth, { account })`.
- **A TOTP secret that decodes to zero bytes is NO key**: `verifyTotp` returns the generic failure
  (`{ ok: false, step: null }`), `totpCode` and `enrolTotp` throw `X_MFA_SECRET_INVALID`. The secret
  never reaches `cause:`/`fix:`. No length floor beyond one byte.
- **`createTotpReplayGuard`'s table is bounded and the eviction ORDER is the guarantee**: subjects
  whose steps are all below the drift floor are forgotten first; past `DEFAULT_MAX_TOTP_SUBJECTS`,
  evict by newest spent step ascending, least-recently-seen tie-break. `maxSubjects` is normalised
  first (`boundedSubjects`): anything not a positive finite integer takes the default.
- SAML is out of scope permanently (XML-DSig canonicalisation has no Bun native). Put an
  OIDC-speaking bridge in front and register that.

## Files

| File | Job |
|---|---|
| `auth.ts` | `defineAuth`, entity schemas, `login`/`register`/`authenticate`/`logout`. Three suites, split at the line ceiling along the three subjects: `auth.test.ts` (the credential flow), `auth-config.test.ts` (`defineAuth`'s defaults and refusals) and `auth-lockout.test.ts` (the tenant and address buckets) |
| `policy-bridge.ts` | the one funnel: identity → `Actor`, all four `ActorKind`s |
| `session.ts` | two expiries, rotation, revocation, device list, the cookie |
| `adapter.ts` | the seam; `builtin-adapter.ts` (Postgres) + `memory-adapter.ts` |
| `rate-limit.ts` | per-ip, per-account and per-org buckets, lockout, scope check, `loginFailed()` |
| `rate-limit-postgres.ts` | the SHARED limiter: two tables, a row per failure, over a structural `PgExecutor` |
| `limiter-install.ts` | the host's one install point for that limiter — the factory, what it built, and the purge over it |
| `oauth.ts` | `OAuthProvider`, PKCE, `beginOAuth`, the callback gate. No I/O, no env |
| `oauth-builtins.ts` | the three shipped IdPs, as data. Imports only the type, so no cycle |
| `oauth-registry.ts` | the registry: `registerOAuthProvider`, `providerFor`, `oauthProviderIds` |
| `oauth-discovery.ts` | `/.well-known/openid-configuration` → an `OAuthProvider`. One `fetch` |
| `jwks.ts` | `crypto.subtle` signature verification, cached by `kid`, one shared in-flight refresh. No dependency |
| `workload.ts` | a workload JWT (K8s SA / SPIFFE / IMDS / RFC 8693) → a `ServiceIdentity` |
| `revocation.ts` | per-user, per-org and before-an-instant sweeps; `disableUser` |
| `directory.ts` | `describeUser` (allow-list projection), `listOrgUsers`, external-id lookup |
| `privileges.ts` | `updatePrivileges` — the grant, and the rotation it requires |
| `oauth-cookie.ts` | the handshake's home between the two legs: seal, open, the cookie |
| `oauth-exchange.ts` | `oauthCredentials` + the one POST to the token endpoint |
| `id-token.ts` | id token → claims this handshake may believe |
| `id-token-fixture.ts` | the one string-input JWT builder the OAuth tests share. Off `index.ts` |
| `auth-fixture.ts` | the KDF parameters, the password and the `AuthError` catcher the three `auth*.test.ts` suites share. Off `index.ts` |
| `oauth-profile.ts` | claims or userinfo → one `OAuthProfile` |
| `oauth-login.ts` | profile → account link → session. `completeOAuthLogin` is the entry point |
| `oauth-login-fixture.ts` | the adapter, clock and profile the three `oauth-login*` suites share. Off `index.ts` |
| `oauth-paths.ts` | the one declaration of where the two routes live. Imports nothing |
| `errors.ts` | the codes this package owns and borrows, their titles, the one `registerErrorCodes()` call, `AuthError`, and every non-OAuth factory |
| `oauth-errors.ts` | the OAuth half of those factories, and `restartAt`. Split off at the 500-line ceiling; declares no code and registers nothing |
| `oauth-route.ts` | `oauthLogin(auth)` — the redirect out and the callback back |
| `kdf-gate.ts` | the one bound on concurrent argon2 work, and the `X_OVERLOADED` past it — core's `createFlightGate` with auth's own refusal injected |
| `email.ts` | `normaliseEmail` — the one normalisation an address gets before it is an identity key |
| `json.ts` | reading untrusted JSON: `isRecord`, and a base64url JWT segment as an object or `null` |
| `sign-out.ts` | `signOutHeaders({ session? })` — the expired session cookie plus `Clear-Site-Data: "cache", "storage"` (`SIGN_OUT_CLEAR_SITE_DATA`), never `"cookies"`. A PWA's offline cache does not survive a sign-out, by decision (a cached private page IS the previous principal's data); the page boot's rescope wipe is the second line. Secure contexts only |
| `client-scope.ts` | `clientScopeOf(actor)` — the OPAQUE per-principal id for `<meta name="ultimate-scope">`: keyed SHA-256 (`SESSION_SECRET`) over kind, id and impersonator, 32 hex; `''` for anonymous. Without `SESSION_SECRET`, a random per-process key and one `auth.client_scope.process_key` warning (rescopes, never leaks) |

```bash
bun test packages/auth
bun run --filter @ultimat3/auth typecheck
```

Gotchas:
- `exactOptionalPropertyTypes` — declare optional fields as `x?: T | undefined`.
- `noUncheckedIndexedAccess` — index a `Record` into a local before narrowing it.
- `X_NOT_IMPLEMENTED` is core's, `X_FORBIDDEN` is policy's. `errors.ts` registers only the codes
  this package **owns**, unconditionally, and lists the borrowed two in `AUTH_BORROWED_ERROR_CODES`
  without a title. A `hasErrorCode()` guard would suppress the `X_ERROR_CODE_DUPLICATE` that is
  supposed to fire when two packages claim one code.
- Tests run against `MemoryAdapter`; no ADAPTER test needs a database. The two exceptions are
  `postgresAuthLimiter`'s, and they are exceptions in the shape the repo already has: the
  scripted-executor twin (`rate-limit-postgres.test.ts`) proves the protocol with no server,
  and `rate-limit-postgres.live.test.ts` is `describe.skip` without `TEST_DATABASE_URL` — the
  same pairing `@ultimat3/http`'s rate-limit store and `@ultimat3/realtime`'s Postgres files
  use. A limiter whose statements were never executed is a credential control nobody has run.

Why each rule above is shaped the way it is: [`docs/history/auth.md`](../../docs/history/auth.md).
