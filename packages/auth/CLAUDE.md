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

- Every credential failure throws `loginFailed()` — one code, one cause, one fix. Adding a
  parameter to it re-opens account enumeration.
- The limiter's table is **bounded**, and the eviction order is part of the guarantee. `ipKey`
  mints one entry per source address, so half the keys are attacker-chosen and a spray from an
  IPv6 /64 is a fresh key per attempt. Every bucket carries `forgetAtMs` — window emptied *and*
  lockout expired, the instant it answers exactly as a missing one — and the sweep drops those
  for free. `policy.maxKeys` (`DEFAULT_MAX_AUTH_LIMIT_KEYS`) is the backstop, and a **live
  lockout outranks its own deadline** in the comparator: without that rank a spray recorded a
  second later sorts ahead of the account it just locked, and filling the table becomes a way to
  buy attempts back. Never reduce that sort to recency.
- **`AuthLimiter` is async on every member, and it declares the policy it enforces.** A
  synchronous signature is one no shared implementation can satisfy — a lockout that holds across
  replicas is a network round trip — so the interface the comment always promised was unreachable
  by construction. `defineAuth` resolves the app's declaration and compares it against
  `limiter.policy`, once, in `assertAuthLimiterPolicy`: a per-process limiter under
  `scope: 'shared'` is `X_AUTH_LIMITER_NOT_SHARED`, and different `maxAttempts`/`windowMs`/
  `lockoutMs` is `X_AUTH_LIMITER_POLICY_MISMATCH` — both at boot, never at the first spray.
  `maxKeys` is **not** compared: it bounds one process' table, so a shared limiter has no opinion
  on it. The point is that `Auth.rateLimit` is what an operator reads as "what this deployment
  enforces", so an injected limiter may not quietly enforce something else. Nothing here reads the
  environment to guess a replica count. `defineAuth({ limiter })` is the one install point.
- **`normaliseEmail` is the ONE normalisation, it lives ABOVE the `AuthAdapter` seam, and no
  adapter may fold case** (`As of 2026-08`). `MemoryAdapter` lowercased and trimmed on both
  `findUserByEmail` and `createUser`; `BuiltinAdapter` issues `where email = $1` against a plain
  case-sensitive `text ... unique`. Two adapters, two answers to "does this account exist" — and
  `oauth-login.ts`'s `resolveUser` normalised nothing at all, carrying the provider's display
  casing straight through. So a provider sending `Ada@Example.com` linked the existing account
  under `x dev` and minted a SECOND one in production, at an address `login()` (which lowercases)
  could then never reach; a later `register()` at the lowercase spelling made a third. Every door
  now normalises before the adapter sees the address — `register`, `login`, `profileEmail` in
  `oauth-login.ts`, and `accountKey`, which must key the same way or one address buys a fresh
  lockout budget per spelling. `adapter-parity.test.ts` pins both adapters in one test, the shape
  `jobs/driver-parity.test.ts` established; `MemoryAdapter` normalising again is a failing test.
  Trim and lowercase only: stripping a `+tag` or a gmail dot MERGES two addresses a person kept
  apart, which is takeover between colleagues at one domain.
- **`json.ts` owns `isRecord` and `decodeJwtSegment`, and this package holds no second copy.**
  `isRecord` was declared six times here and the base64url-JSON-payload decode three
  (`jwks.decodeJwtHeader`, `id-token.decodeSegment`, `workload.verifyWorkloadToken`). All six
  agreed that an array is not a record, which is the fact that matters: on a decoded JWT payload
  the check is what gates every claim read after it, and `JSON.parse('[]')` narrows to
  `Record<string, unknown>` without it. One declaration means one place for that to be true.
  `decodeJwtSegment` answers `null` for all three failures — not base64url, not JSON, not an
  object — because each caller has its own coded refusal to raise.
- Absolute and idle expiry are two separate computations in `sessionExpiry()`. Do not fold them.
- PKCE is not provider-dependent. `OAuthProvider.usesPkce` is the literal `true`, not `boolean`,
  so `usesPkce: false` is a type error rather than a comment — and there is no
  `if (provider.usesPkce)` branch left anywhere for it to have been false in. It stays the literal
  now that `registerOAuthProvider` is open to any app: the mechanism has to survive the opening.
- **Providers are a registry, `OAuthProviderId` is `string`.** A closed union of three consumer
  IdPs made an enterprise OP *unrepresentable* — a type constraint has no runtime escape, so the
  only ways out were forking the package or bypassing OAuth entirely and losing PKCE, the sealed
  handshake, issuer pinning and account linking with it. The three built-ins seed the registry
  through the same `registerOAuthProvider()` an app calls, so there is still one way to do it.
  `providerFor(id)` throws `X_OAUTH_PROVIDER_UNKNOWN` and never answers `undefined`; a second claim
  on one id is `X_OAUTH_PROVIDER_DUPLICATE` at boot, never a silent replacement.
- **`oauthProviderUnknown(provider, supported)` scopes its list to its reader.** The route passes
  `BUILTIN_OAUTH_PROVIDER_IDS` — an anonymous stranger typed that URL, and the registry now holds
  whatever internal OP this deployment registered. `providerFor()` passes `oauthProviderIds()` —
  its reader is a developer with a stack trace, and the full list is what makes the fix runnable.
  Neither ever passes `defineAuth({ providers })`. One code, two audiences, one sentence that stays
  executable either way because it names `registerOAuthProvider` before it names the list.
- **`verifyIdToken({ keys })` is required, with no default.** `'token-endpoint-tls'` is the OIDC
  Core 3.1.3.7 exemption stated out loud, and `exchangeOAuthCode` is the only shipped caller
  entitled to it. Anything else — IdP-initiated login, `form_post`, back-channel logout, token
  exchange — passes a `JwksKeySource` and gets the signature checked. A default is exactly what
  would let a second door inherit "unverified" from the first. `HS256` and `alg: none` are refused
  in `decodeJwtHeader` before a key is ever looked up.
- **`resolveGrants` is a seam, never a group-to-role table.** It is called on EVERY login, not only
  at creation, or "remove them from the group in the IdP" is a no-op forever. Absent means the app
  has no opinion and the stored row is left alone; a seam returning the stored answer writes
  nothing. Creating a user with no roles and no org logs a warning — that account can do nothing.
- **`verifySession` writes at most once per `idleSlideMs`** (default `idleTtlMs / 20`). Throttling
  the SESSION write is safe; caching the USER row is not — `authenticate` re-reads it on every
  request, and that is what makes a revoked role take effect on the next one with no token-expiry
  lag. Do not cache it.
- A user's `scopes` column reaches `Actor.scopes`. Hardcoding `[]` there made a scope something no
  human could hold, so `hasScope(actor, 'tenancy:cross')` was satisfiable only by minting a
  `serviceActor` inside the handler — which discards the operator's identity and makes the sweep
  unattributable, the exact property the required reason string exists to preserve.
- Every revocation takes a `reason` and logs `auth.revocation` before it runs.
  `deleteSessionsForOrg` joins through `x_users`; `x_sessions` does **not** gain an `org_id`,
  because a denormalised membership goes stale the moment somebody moves org and the 03:00 sweep
  then leaves live exactly the sessions it was run to kill.
- The code flow carries `nonce` inside the id token, not on the redirect. `assertOAuthCallback`
  checks an echoed one when present and never requires it; `verifyIdToken` is the real gate.
- The handshake crosses two requests, so it is sealed (`sealHandshake`), never handed over in a
  variable. `openHandshake` takes the provider as an argument for the reason `decodeCursor` takes
  a scope: an optional check is one a call site forgets. Expiry is the server's clock, not `Max-Age`.
- One handshake cookie **per provider** (`handshakeCookieName`), never one shared slot. Two tabs
  are two handshakes in one jar, and a shared name makes the second redirect overwrite the first.
  `clearHandshakeCookie(provider)` for the same reason: clearing all of them cancels the other tab.
- `takeVerification(purpose, identifier, tokenHash)` consumes the row **only on a hash match**,
  in one conditional statement. The hash is an argument to the consume, not a comparison after it:
  a store that consumes first lets `{identifier:'victim@…', token:'x'}` kill the victim's live
  link, one request per address, unauthenticated. `consumeVerification` still compares in constant
  time on the row it gets back — the seam is an app's to implement, and one that ignores the
  argument would otherwise redeem any token. The Postgres statement carries `consumed_at is null`
  on the UPDATE **and** in its subselect (single-use under two racing redemptions), and
  `order by created_at desc limit 1` so it can only ever consume one row.
- **Foreign text reaching a `cause:` goes through `renderCauseValue`, and a `fix:` through
  `renderFixLiteral`.** Not for throw-safety — these values are `string` by type, so
  `bun run error-render` (which only sees `unknown`/`any`) will never catch one — but because a
  newline writes a second log line an operator reads as genuine. Three values in this package are
  foreign and all three are rendered at their source: `providerDetail()`'s return (a REMOTE
  server's bytes, rendered there rather than at `oauthExchangeFailed` so the prose details this
  package authors stay unquoted), `claims.iss` in `id-token.ts` (a field of the JWT the caller
  presented), and `accountLocked`'s `key` (built by `ipKey` from a caller-supplied address).
  `${provider}` is NOT in that set — it is registry-validated on every shipped path, so it is boot
  config like `clientIdEnv`, not request data. Swept whole `As of 2026-08`.
- `readCookie` never throws on a malformed value. The `Cookie:` header is attacker-controlled and
  `decodeURIComponent('%')` is a bare `URIError`, which would escape every coded path in this
  package — the raw value goes to the signature or hash check, which is the readable refusal.
- A token endpoint's HTTP 200 is not success — GitHub reports a dead code that way. Read `error`.
- Link by address only when the provider **and** the local account both verified it. That is
  `link: 'verified-email'`, the default; `'never'` is the only other value and there is
  deliberately no "link on any provider address" — it is account takeover at a sloppy
  provider, so it is unrepresentable rather than discouraged. An app that wants it wraps
  `signInWithOAuth`.
- **The OAuth route paths are not configurable.** `oauth-paths.ts` imports nothing and is
  read by both `errors.ts` and `oauth-route.ts`, so a `fix:` line naming
  `GET /auth/oauth/<provider>` cannot outlive the route again — which is exactly what it did
  through 1.2.0, when the library functions shipped with no route to mount them in. Every
  "start over" fix is built from `restartAt(provider)`.
- The routes are **descriptors** (`mcpHttpRoute()`'s category), never mounted handlers:
  `@ultimat3/http` is tier 2 like this package and `defineRoute` is tier 4 and renders a
  page, so neither is importable here. A bare `Request` in, a `Response` out.
- The callback answers failure as **coded JSON**, and the success hop redirects to a fixed
  `successPath` — never `?next=`. `nextAfterSignIn` in `@ultimat3/http` is the one
  implementation of the open-redirect check and a second copy is one that drifts.
- The handshake cookie is cleared on **every** callback outcome, success and failure alike:
  the code it authorised is spent either way.
- Refresh is **not implemented**. `AuthAccount` persists `refreshToken` and `expiresAt`, and
  nothing reads them yet — the session is the framework's own credential and does not depend
  on the provider token.
- The new `AuthAdapter` members are OPTIONAL (`findUserByExternalId`, `listUsersByOrg`,
  `deleteSessionsForUser`, `deleteSessionsForOrg`, `deleteSessionsCreatedBefore`). A required
  member is a breaking change to every third-party adapter; the callers throw
  `X_NOT_IMPLEMENTED` naming the method instead.
- An api key's scopes are the agent actor's scopes. Never union them with the owner's roles.
- Rotate the session id on any privilege change (`rotateSession`), never patch the row.
  `updatePrivileges` in `privileges.ts` is the caller that makes that rule exist — it had none
  until 1.3.0, and `SessionPolicy.rotateOnPrivilegeChange` was a flag nothing read.
- **Every argon2 call goes through `kdfGate()`, and that is the only thing bounding its memory.**
  19 MiB of arena per hash at the OWASP floor, and both existing gates are per-SOURCE (`ipKey(ip)`,
  5 attempts; `@ultimat3/http`'s `auth` bucket, 10 per `route|ip:`) so a spray rotating an IPv6 /64
  mints a fresh key every attempt — and both cap ATTEMPTS, not concurrent WORK. The only backstop
  left was `http.maxInflight` (1000), about 19 GB of arenas queued. `kdf-gate.ts` bounds the width
  (8) and the waiting queue (64) and refuses past it with `X_OVERLOADED`, borrowed from http and
  listed in `AUTH_BORROWED_ERROR_CODES` — this package cannot import http, and a shed is a shed
  whichever layer performs it. `configureKdfGate()` is the ONE install point and is deliberately
  not a `defineAuth` key: the ceiling is a property of the machine, not of the app's auth policy.
- **MFA has a first leg and no second one, and the second one is not a route you can just add.**
  `login()` and `completeOAuthLogin()` throw `X_MFA_REQUIRED` before any session exists; nothing is
  written, so the only value handed over is a user id in `meta`. A `POST /auth/mfa/verify
  { userId, code }` built on that is **unauthenticated by construction** — nothing binds it to a
  completed first factor, so it converts MFA from a second factor into the only factor. That is why
  the `fix:` now tells an app author to finish the flow itself (`verifyTotp` → `createSession({
  mfaSatisfied: true })`) rather than naming a route, and why no route was added under a bug fix.
  The framework's own second leg needs three things landing together, and fewer is worse than none:
  a **sealed pending-MFA credential** built like `sealHandshake` (`oauth-cookie.ts`) — server-clock
  expiry, one cookie, bound to the user id the first factor proved and to nothing the client says;
  the completion shipped as an `AuthRouteDescriptor` the way `oauthLogin()` was (`oauth-route.ts`),
  with its path declared in `oauth-paths.ts`'s style so the `fix:` and the mount cannot drift; and
  `auth.limiter` around `verifyTotp` — today it is wired only into `login`, so a six-digit code
  would be the one credential in this package with no lockout. `TotpReplayGuard` is already built
  and must be the completion's, not a second one.
- SAML is out of scope permanently: XML-DSig canonicalisation has no Bun native and would need a
  real dependency. Put an OIDC-speaking bridge in front and register that.

## Files

| File | Job |
|---|---|
| `auth.ts` | `defineAuth`, entity schemas, `login`/`register`/`authenticate`/`logout` |
| `policy-bridge.ts` | the one funnel: identity → `Actor`, all four `ActorKind`s |
| `session.ts` | two expiries, rotation, revocation, device list, the cookie |
| `adapter.ts` | the seam; `builtin-adapter.ts` (Postgres) + `memory-adapter.ts` |
| `rate-limit.ts` | per-ip, per-account and per-org buckets, lockout, scope check, `loginFailed()` |
| `oauth.ts` | `OAuthProvider`, PKCE, `beginOAuth`, the callback gate. No I/O, no env |
| `oauth-builtins.ts` | the three shipped IdPs, as data. Imports only the type, so no cycle |
| `oauth-registry.ts` | the registry: `registerOAuthProvider`, `providerFor`, `oauthProviderIds` |
| `oauth-discovery.ts` | `/.well-known/openid-configuration` → an `OAuthProvider`. One `fetch` |
| `jwks.ts` | `crypto.subtle` signature verification, cached by `kid`. No dependency |
| `workload.ts` | a workload JWT (K8s SA / SPIFFE / IMDS / RFC 8693) → a `ServiceIdentity` |
| `revocation.ts` | per-user, per-org and before-an-instant sweeps; `disableUser` |
| `directory.ts` | `describeUser` (allow-list projection), `listOrgUsers`, external-id lookup |
| `privileges.ts` | `updatePrivileges` — the grant, and the rotation it requires |
| `oauth-cookie.ts` | the handshake's home between the two legs: seal, open, the cookie |
| `oauth-exchange.ts` | `oauthCredentials` + the one POST to the token endpoint |
| `id-token.ts` | id token → claims this handshake may believe |
| `id-token-fixture.ts` | the one string-input JWT builder the OAuth tests share. Off `index.ts` |
| `oauth-profile.ts` | claims or userinfo → one `OAuthProfile` |
| `oauth-login.ts` | profile → account link → session. `completeOAuthLogin` is the entry point |
| `oauth-login-fixture.ts` | the adapter, clock and profile the three `oauth-login*` suites share. Off `index.ts` |
| `oauth-paths.ts` | the one declaration of where the two routes live. Imports nothing |
| `oauth-route.ts` | `oauthLogin(auth)` — the redirect out and the callback back |
| `kdf-gate.ts` | the one bound on concurrent argon2 work, and the `X_OVERLOADED` past it |
| `email.ts` | `normaliseEmail` — the one normalisation an address gets before it is an identity key |
| `json.ts` | reading untrusted JSON: `isRecord`, and a base64url JWT segment as an object or `null` |

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
- Tests run against `MemoryAdapter`; nothing in this package needs a database.
