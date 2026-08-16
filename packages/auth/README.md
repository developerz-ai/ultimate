# @ultimat3/auth 🔐

**The output of authentication is an `Actor` from `@ultimat3/core`.** Nothing downstream
authorizes on a session row, a user row or an api key — http, actions, jobs and MCP all read
`ctx.actor` and hand it to `@ultimat3/policy`. One authz system, never two.

```ts
import { BuiltinAdapter, defineAuth, login, oauthLogin } from '@ultimat3/auth';

export const auth = defineAuth({
  adapter: new BuiltinAdapter(),          // or MemoryAdapter, or your Better Auth binding
  session: { absoluteTtlMs: 30 * 864e5, idleTtlMs: 7 * 864e5 },
  password: { minLength: 12 },
  mfa: { issuer: 'Acme' },
  providers: ['github', 'google'],
  link: 'verified-email',                 // the default; `'never'` is the only other value
});

const { actor, token, cookie } = await login(auth, { email, password, ip });

// "Log in with GitHub" is a link to /auth/oauth/github. These two routes are what serves it.
const { start, callback } = oauthLogin(auth);
```

## Rules

- Every login failure throws `loginFailed()` from `rate-limit.ts`. Never a specific message.
- Session ids are opaque random tokens; only `sha256(secret)` reaches the database.
- Absolute and idle expiry are evaluated **independently**. Activity never moves the ceiling.
- PKCE is mandatory on every provider — `OAuthProvider.usesPkce` is the literal `true`, so
  `usesPkce: false` does not typecheck and there is no branch that skips the verifier.
- Recovery codes, verification tokens and api keys are hashed at rest and single-use.
- A verification token is consumed **only when its hash matches**, in the same statement — the
  store takes `(purpose, identifier, tokenHash)`. Consuming first and comparing afterwards made an
  unauthenticated wrong guess destroy the victim's live reset link.
- Guards assert on the actor. They never evaluate a policy.
- A user's `scopes` column reaches `Actor.scopes`, so a human can hold a scope. `permissions` is a
  different field and `hasScope()` does not read it.
- `verifySession` writes at most once per `idleSlideMs`, not once per request.
- The lockout counts attempts against one identity, so it has to be **one** count. `AuthLimiter`
  is async on every member and declares the policy it enforces; `defineAuth` refuses a limiter
  that disagrees with the app's declaration.

## The lockout across replicas

`createAuthLimiter` keeps its table in the process, so `maxAttempts: 5` at `replicas: 3` lets an
account survive 15 guesses and hides each replica's lockout from the other two. An app that runs
more than one process says so and brings a limiter that says the same:

```ts
defineAuth({
  adapter,
  rateLimit: { maxAttempts: 5, scope: 'shared' },  // the whole fleet's allowance
  limiter: myLimiter,                              // whose policy says exactly the same
});
```

`Auth.rateLimit` is what an operator reads as "what this deployment enforces", so `defineAuth`
refuses any pairing that would make it a lie:

| Declared | Limiter's own `policy` | Result |
|---|---|---|
| `scope: 'process'` (default) | anything, same numbers | boots; the lockout is per replica |
| `scope: 'shared'` | `scope: 'shared'`, same numbers | boots; one count for the fleet |
| `scope: 'shared'` | `scope: 'process'` | `X_AUTH_LIMITER_NOT_SHARED` |
| `maxAttempts`/`windowMs`/`lockoutMs` | any of the three different | `X_AUTH_LIMITER_POLICY_MISMATCH` |

### The third bucket: one tenant

`account:<email>` and `ip:<addr>` were the only key shapes, so one tenant's misconfigured
integration hammering login from 400 addresses was capped by neither — each IP bucket allowed its
own quota, the account buckets protected individuals, and the shared limiter saturated behind
them. `orgKey(orgId)` is the third shape, checked in `login()` once the address resolves to an org
and still before the KDF runs.

`rateLimit.orgMaxAttempts` is its own number, defaulting to `maxAttempts * 20`: a whole tenant
sharing five attempts is a denial of service against that tenant. A success on one member's
account clears the **account** window and deliberately not the tenant one — otherwise the traffic
that proves the tenant is alive is also the traffic that resets its cap. Pass `orgLimiter` to
`defineAuth` to share those counters across replicas; unlike `limiter`, it is not required under
`scope: 'shared'`, because a tenant cap is a throughput ceiling and not a guessing allowance.

## Service-to-service

`verifyWorkloadToken` is the one function, and it reads all three shapes because they are all the
same JWT: a Kubernetes projected service-account token, a SPIFFE JWT-SVID, and a cloud IMDS token.
It is also the shape RFC 8693's `subject_token` takes.

```ts
const { identity } = await verifyWorkloadToken({
  token,
  issuers: ['https://kubernetes.default.svc'],
  audience: 'https://ledger.internal',
  keys: createJwksClient({ provider: 'k8s', jwksUri: 'https://kubernetes.default.svc/openid/v1/jwks' }),
  clock,
});
const actor = actorFromService(identity);   // kind: 'service', id: the caller's own sub
```

Signature first, then issuer, audience, `exp` and `nbf`. `scope` (space-delimited) or `scp` (an
array) become the actor's scopes; a token with neither carries none. There is no trusted-channel
exemption here — the token arrived in a header.

**mTLS is out of scope.** TLS termination is the mesh's job ([axiom
7](../../docs/idea/README.md)); the framework's part is reading a trusted
`x-forwarded-client-cert` through `@ultimat3/http`'s trusted-proxy seam, which that package owns.

`maxKeys` is not compared — it bounds one process' table, not a limit. A custom limiter therefore
does **not** own its own configuration: the policy stays the app's single statement of the limits,
and the boot check is what keeps it true. **No shared limiter ships yet, `As of 2026-08`** —
`createAuthLimiter` is the only implementation in the framework.

## Providers are a registry, not a union

`OAuthProviderId` is `string`, and `registerOAuthProvider()` is the one way a provider gets in —
the three built-ins go through the same call. Before 1.3.0 the id was `keyof typeof
OAUTH_PROVIDERS` over `github | google | apple`, so an enterprise OP was **unrepresentable**: the
constraint was a type, there was no runtime escape, and the only ways out were forking the package
or bypassing OAuth entirely and losing PKCE, the sealed handshake, issuer pinning and account
linking with it.

```ts
import { discoverOAuthProvider, registerOAuthProvider } from '@ultimat3/auth';

// By hand, when you know the four endpoints:
registerOAuthProvider({
  id: 'bigco-sso',
  authorizeUrl: 'https://sso.bigco.test/oauth2/v1/authorize',
  tokenUrl: 'https://sso.bigco.test/oauth2/v1/token',
  userInfoUrl: 'https://sso.bigco.test/oauth2/v1/userinfo',
  userEmailsUrl: null,
  issuers: ['https://sso.bigco.test'],
  jwksUri: 'https://sso.bigco.test/oauth2/v1/keys',
  scopes: ['openid', 'email', 'profile'],
  usesPkce: true,          // the literal `true`; `false` does not typecheck, for anyone
  usesNonce: true,
  clientIdEnv: 'BIGCO_SSO_CLIENT_ID',
  clientSecretEnv: 'BIGCO_SSO_CLIENT_SECRET',
});

// Or read them once at boot, from the issuer's own discovery document:
registerOAuthProvider(await discoverOAuthProvider({ id: 'bigco-sso', issuer: 'https://sso.bigco.test' }));
```

| Call | Answers |
|---|---|
| `registerOAuthProvider(provider)` | the frozen provider; `X_OAUTH_PROVIDER_DUPLICATE` on a second claim of one id |
| `providerFor(id)` | the provider, or throws `X_OAUTH_PROVIDER_UNKNOWN` — never `undefined` |
| `hasOAuthProvider(id)` | whether the id is registered |
| `BUILTIN_OAUTH_PROVIDER_IDS` | the three shipped ids — the only list an **anonymous** refusal names |
| `oauthProviderIds()` | every registered id, live — `defineAuth({ providers })` defaults to it |

`discoverOAuthProvider` refuses a document with no `jwks_uri`: without a key set there is nothing
to check an id token's signature against, and the token-endpoint TLS exemption below is a thing a
caller declares, not one a provider inherits by omission.

**SAML is out of scope and will stay out of scope.** XML-DSig canonicalisation has no Bun native
and implementing it would mean a real dependency in the primitive vocabulary, which
[`docs/idea/18-build-vs-wrap.md`](../../docs/idea/18-build-vs-wrap.md) does not permit. The honest
answer is to put an OIDC-speaking SAML bridge (Okta, Entra, Keycloak, Dex, a SAML-to-OIDC proxy) in
front and register **that** as a provider.

## Id token signatures

`verifyIdToken({ keys })` is **required** to say where its trust comes from. There is no default,
because a default is what silently makes a second door as trusting as the first.

| `keys` | Means |
|---|---|
| `'token-endpoint-tls'` | this token came off a TLS response from the provider's own token endpoint — the one case OIDC Core 3.1.3.7 exempts. `exchangeOAuthCode` passes it, and that is the only shipped call site that may |
| a `JwksKeySource` | the signature is checked. `providerJwks(providerFor(id))`, or `createJwksClient({ provider, jwksUri })` |

```ts
const keys = providerJwks(providerFor('bigco-sso'));
const claims = await verifyIdToken({ provider: 'bigco-sso', idToken, clientId, nonce, clock, keys });
```

`crypto.subtle` covers RS256 and ES256, so this costs no dependency. `HS256` and `alg: none` are
refused before a key is even looked up — a symmetric algorithm verified against a *public* key set
is the classic algorithm-confusion forgery. Keys are cached by `kid` with a TTL and one unknown
`kid` triggers exactly one refetch, so a rotation heals itself.

Wire an unsolicited token — IdP-initiated login, `response_mode=form_post`, back-channel logout,
token exchange — to anything that does **not** check the signature and an attacker posts a
self-minted JWT with the right `iss`, your `aud`, a VP's `sub` and tomorrow's `exp`, and gets a
session. That is account takeover with no credential, and it is what this exists to stop.

## What an SSO user is allowed to do

`oauthLogin(auth, { resolveGrants })`. **Omit it and a first-time SSO user is created with
`roles: []` and `orgId: null`** — an actor every `can()` denies, and a tenant-scoped read that
throws before the query is built. SSO "works" and the person can do nothing until somebody runs
SQL, so the omission logs `auth.oauth.user_created_without_grants` rather than passing silently.

```ts
oauthLogin(auth, {
  resolveGrants: async (profile) => {
    const member = await directory.lookup(profile.email);
    return { orgId: member.orgId, roles: member.groups.map(toRole), scopes: [] };
  },
});
```

It is a **seam and not a group-to-role table**: which IdP group means which role is business
convention and business convention never ships ([axiom
8](../../docs/idea/19-mechanism-not-convention.md)). What the framework owns is calling it on
**every** login — so removing somebody from a group in the IdP takes effect at their next sign-in,
rather than never. A seam that returns the stored answer writes nothing.

## Revocation, offboarding and access review

| Call | Blast radius |
|---|---|
| `revokeSession(runtime, id)` | one session |
| `revokeOtherSessions(runtime, userId, keep)` | every session but the caller's |
| `revokeUserSessions(auth, userId, reason)` | one person, their current session included |
| `revokeOrgSessions(auth, orgId, reason)` | one tenant, at 03:00, without touching another |
| `revokeSessionsCreatedBefore(auth, at, reason)` | everything minted under a rotated secret |
| `disableUser(auth, userId, reason)` | stamps `disabledAt` **and** kills the sessions |
| `listOrgUsers(auth, orgId, { role })` | the quarterly access review, as safe summaries |
| `updatePrivileges(auth, userId, patch, session?)` | the grant, plus the session rotation it requires |

`reason` is a required argument on every revocation, for the reason `crossTenant()` requires one:
an incident review asks who killed these sessions and why, and a `delete` with no line answers
neither. Each one logs `auth.revocation` before it runs.

`deleteSessionsForOrg` joins through `x_users` and `x_sessions` deliberately does **not** gain an
`org_id`: a denormalised copy of the membership goes stale the moment somebody moves org, and a
stale row means the sweep leaves live exactly the sessions it was run to kill.

`describeUser` is an allow-list, never a delete-list — a column added to `AuthUser` later must not
appear in an admin response by default. No password hash, no TOTP secret, no recovery-code hash.

## Adapter seam

`AuthAdapter` (`adapter.ts`) is the only persistence interface. Better Auth binds here — it is
an adapter implementation, not a dependency of this package.

| Driver | Use |
|---|---|
| `BuiltinAdapter` | Postgres via `@ultimat3/db`; takes an injected `DbClient` |
| `MemoryAdapter` | `x new` before a database exists, and every test in this package |
| your own | implement `AuthAdapter`; DDL in `tables.ts` shows what the columns mean |

The seam's newer members — `findUserByExternalId`, `listUsersByOrg`, `deleteSessionsForUser`,
`deleteSessionsForOrg`, `deleteSessionsCreatedBefore` — are **optional**, so a 1.2-era adapter
still satisfies the interface. Calling one an adapter has not implemented is `X_NOT_IMPLEMENTED`
with the method named, not a silent no-op.

`x_users` gained two columns in 1.3.0 — `scopes text[]` and `external_id text unique` — plus an
`org_id` index. `X_USERS_MIGRATION_1_3` is those statements for an app already on 1.2; both
columns are additive with a default, so the migration takes no table rewrite.

```bash
x db gen "auth tables"     # emits AUTH_TABLES into a migration
```

## Sessions are not a write path

`verifySession` used to `UPDATE x_sessions … RETURNING *` on **every** authenticated request: one
request was a SELECT, a write and a second SELECT before the app's own first query. At 20k rps
that is 20k writes a second on one hot table, autovacuum falls behind, and the incident reads as
"the database is slow".

`SessionPolicy.idleSlideMs` — defaulting to `idleTtlMs / 20` — is how far `lastSeenAt` may drift
before a request writes it forward. A second request inside that window issues no write at all. A
changed IP or user agent is still written immediately, because that is the row a device list and
an incident review read. The trade is bounded and explicit: idle expiry is now precise to within
one `idleSlideMs`.

**Revocation is unaffected, and deliberately so.** `authenticate` re-reads the *user* row on every
request, so a revoked role takes effect on the very next one with no token-expiry lag — a better
property than any claims-in-a-JWT design. Throttling the session write is safe; caching the user
row would not be, and nothing does.

## Cookie

`__Host-x_session`, set by `sessionCookie(token, policy)`.

| Attribute | Attack it closes |
|---|---|
| `HttpOnly` | XSS reading `document.cookie` and exfiltrating the session |
| `Secure` | a network attacker lifting it off a plaintext request |
| `SameSite=Lax` | CSRF — the cookie is not attached to cross-site POSTs |
| `__Host-` + `Path=/` + no `Domain` | a sibling subdomain overwriting it (session fixation) |
| `Max-Age` | a client keeping it past the server's absolute ceiling |

## OAuth — log in with GitHub

`oauthLogin(auth)` **is** the flow. Two route descriptors, mounted at two fixed paths, composing
`beginOAuth`, the handshake cookie and `completeOAuthLogin`. Provider configs stay pure data —
importing `oauth.ts` performs no network I/O and reads no env.

```ts
const { start, callback } = oauthLogin(auth);

Bun.serve({
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname.endsWith('/callback')) return callback.handle(request);
    if (pathname.startsWith('/auth/oauth/')) return start.handle(request);
    return new Response(null, { status: 404 });
  },
});
```

| | `start` | `callback` |
|---|---|---|
| path | `/auth/oauth/:provider` | `/auth/oauth/:provider/callback` |
| success | `302` to the provider, `Set-Cookie: __Host-x_oauth_<provider>` | `303` to `successPath`, `Set-Cookie: __Host-x_session` **and** the handshake cleared |
| failure | the coded JSON body, status per code | the same, handshake cleared either way |

A **descriptor**, never a mounted handler — the same category as `mcpHttpRoute()`. `@ultimat3/http`
is tier 2 like this package, so auth may not import it, and `defineRoute` is tier 4 and describes
a rendered page. A bare `Request` in, a `Response` out: drivable from a test, mountable by any
router that can match a `:param`.

**The `Bun.serve` above is library usage, not app usage.** An Ultimate app's server is `runRole`
(`apps/web/server.ts` is three lines that call it), and `As of 2026-08` `ServeOptions` has no
routes seam — the route list is built inside `serveApp` and closed. So a second `Bun.serve` in an
app does not extend that server, it stands beside it: on its own socket, outside the pipeline, and
therefore outside `configureAuthenticator`, the rate limiter, the security headers and the
SIGTERM drain. A login flow is the last surface that should be the one running unthrottled and
unheadered.

Until the seam exists, an app serving these descriptors serves them itself and pays for all of
that itself — a second port to publish and health-check, its own throttle in front of `callback`,
its own security headers, and a drain that does not strand a handshake mid-flight. There is no
mounting API to call today; do not write one, and do not read this section as promising one.

**The paths are not configurable.** `X_OAUTH_STATE_INVALID` has always told the caller to restart
at `GET /auth/oauth/<provider>`; it now quotes `oauthStartPath()`, the same declaration the mount
reads. A movable base path is that sentence going stale again.

**Failure is JSON, not a redirect carrying `?error=`.** The callback is the one request whose
failure a developer must read, and there is no `?next=` on the success hop either: an
attacker-supplied return target on the endpoint that hands out a session is the classic open
redirect, and `nextAfterSignIn` in `@ultimat3/http` is the one implementation of that check.

`beginOAuth` / `handshakeCookie` / `completeOAuthLogin` stay exported for a flow that needs the
seams — but they are the seams, not the path.

### Account linking

```ts
defineAuth({ adapter, providers: ['github'], link: 'verified-email' })  // the default
```

| `link` | a provider identity becomes an **existing** user when |
|---|---|
| `'verified-email'` (default) | the provider asserted the address verified **and** that account had verified it too |
| `'never'` | never — a collision is `X_UNAUTHENTICATED` and the caller uses their own credentials |

There is deliberately **no third value**. "Link on whatever address the provider sent" is not
spelled here at all: a provider that does not verify addresses turns it into account takeover —
register the victim's address there, press the button, inherit the account. Unrepresentable beats
explicit, the same way `PkcePair.method` is the literal `'S256'` and never `'plain'`. An app that
truly wants something looser wraps `signInWithOAuth` and resolves the user itself.

The handshake carries `state`, `nonce` and the PKCE verifier across two requests, so it needs a
home. `handshakeCookie` is that home — sealed with `SESSION_SECRET`, `HttpOnly; Secure;
SameSite=Lax` under a `__Host-` name, and expired against the server's clock rather than the
client's copy of `Max-Age`. `sealHandshake` / `openHandshake` are the same codec without the
cookie, for an app that would rather keep it server-side.

**One cookie per provider:** `handshakeCookieName(provider)` → `__Host-x_oauth_github`. A browser
is one cookie jar and a user is allowed two tabs, so a single shared name means the `google`
redirect overwrites a `github` handshake still in flight — and the github callback then opens
google's and fails `X_OAUTH_STATE_INVALID` for a reason no restart clears. `handshakeCookie` takes
the name off `handshake.provider`, `clearHandshakeCookie(provider)` clears only that provider's,
and `readHandshakeCookie(request, provider)` reads only that provider's. Pass `{ name }` to
override all three at once.

| Refused | Because |
|---|---|
| a handshake with no signature, or one signed with another secret | a browser that can mint a handshake can pair its own code with someone else's session |
| a `github` handshake opened on the `google` callback | `openHandshake(sealed, provider)` requires the provider, so it cannot be forgotten |
| a handshake older than `DEFAULT_HANDSHAKE_TTL_MS` (10 min) | a client may ignore `Max-Age`; the server's clock decides |
| a callback with no handshake cookie | there is nothing to check `state` against |
| a cookie value that is not valid percent-encoding | the header is the client's; the raw value reaches the signature check and fails it, never a bare `URIError` |

| Provider | PKCE | id token | Env |
|---|---|---|---|
| `github` | S256 | — profile + verified-emails call | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` |
| `google` | S256 | required, nonce-bound | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |
| `apple` | S256 | required, nonce-bound | `APPLE_CLIENT_ID` / `APPLE_CLIENT_SECRET` |

Apple alone rejects a static secret: `APPLE_CLIENT_SECRET` must hold the ES256 client-secret
JWT signed with the `.p8` key, which Apple expires every six months.

| Step | Does | Fails with |
|---|---|---|
| `oauthLogin(auth)` | the two routes: redirect out, session back | `X_OAUTH_PROVIDER_UNKNOWN`, `X_OAUTH_DENIED` |
| `handshakeCookie` / `readHandshakeCookie` | seals the handshake onto the redirect, opens it on the callback | `X_OAUTH_STATE_INVALID`, `X_ENV_MISSING` |
| `exchangeOAuthCode` | POSTs the code + PKCE verifier, verifies the id token | `X_OAUTH_EXCHANGE_FAILED`, `X_OAUTH_TOKEN_INVALID` |
| `oauthProfile` | id-token claims, else userinfo → one normalised identity | `X_OAUTH_EXCHANGE_FAILED` |
| `signInWithOAuth` | links the account, applies MFA, mints the session | `X_UNAUTHENTICATED`, `X_MFA_REQUIRED` |

- PKCE's verifier travels only in the exchange — it proves the code belongs to the browser
  that started the flow.
- `state` is checked before anything reaches the network; `nonce` is checked inside the id
  token, because that is where the code flow actually carries it.
- GitHub reports a bad, reused or expired code as **HTTP 200 with an `error` field**. Trusting
  the status alone there mints a session from a failed exchange.
- An address is only linked to an existing account when **both** sides verified it (`link:
  'verified-email'`). Otherwise whoever registered the address first inherits the login.

## API keys — how an agent authenticates

`ult_<env>_<id>_<secret>`. The plaintext is shown once; the row holds `sha256(secret)` and is
looked up by the non-secret id.

```ts
const { plaintext, record } = issueApiKey({ env: 'prod', scopes: ['post:publish'], orgId });
await auth.adapter.putApiKey(record);
const actor = apiKeyActor(await verifyApiKey(auth.adapter, plaintext));  // kind: 'agent'
```

An api key's scopes become **exactly** the agent actor's scopes — never the owning user's roles.

## Errors

| Code | When |
|---|---|
| `X_UNAUTHENTICATED` | no actor, unknown session, or any failed credential path |
| `X_SESSION_EXPIRED` | idle or absolute expiry, named in `cause` |
| `X_MFA_REQUIRED` | password proven, second factor outstanding |
| `X_OAUTH_STATE_INVALID` | state, nonce or PKCE verifier did not match |
| `X_OAUTH_EXCHANGE_FAILED` | the provider refused the exchange, or returned no usable identity |
| `X_OAUTH_TOKEN_INVALID` | the id token failed its signature, issuer, audience or expiry check, or no key in the published set matched its `kid` |
| `X_OAUTH_PROVIDER_UNKNOWN` | the URL named a provider nothing registered, or one `defineAuth({ providers })` did not enable — the route's refusal lists only the three built-ins, never your registry |
| `X_OAUTH_PROVIDER_DUPLICATE` | two `registerOAuthProvider` calls claimed one id — at boot, never at a login |
| `X_OAUTH_DENIED` | the user pressed Cancel, or the provider declined — `403`, never a `502` |
| `X_PASSWORD_WEAK` | strength check rejected the password |
| `X_ACCOUNT_LOCKED` | the per-ip, per-account or per-org bucket is inside its lockout |
| `X_API_KEY_INVALID` | key unknown, revoked, expired or wrong |
| `X_ENV_MISSING` | `oauthCredentials()` found no client id or secret for an enabled provider |
| `X_NOT_IMPLEMENTED` | an `AuthAdapter` has not implemented an optional seam member (`revokeOrgSessions`, `listOrgUsers`, …), or lost a write it accepted — `emailVerifiedNotStored(provider, userId)` when `updateUser` drops the OAuth verified stamp |

```bash
bun test packages/auth
bun run --filter @ultimat3/auth typecheck
```
