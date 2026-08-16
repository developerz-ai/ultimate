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

`maxKeys` is not compared — it bounds one process' table, not a limit. A custom limiter therefore
does **not** own its own configuration: the policy stays the app's single statement of the limits,
and the boot check is what keeps it true. **No shared limiter ships yet, `As of 2026-08`** —
`createAuthLimiter` is the only implementation in the framework.

## Adapter seam

`AuthAdapter` (`adapter.ts`) is the only persistence interface. Better Auth binds here — it is
an adapter implementation, not a dependency of this package.

| Driver | Use |
|---|---|
| `BuiltinAdapter` | Postgres via `@ultimat3/db`; takes an injected `DbClient` |
| `MemoryAdapter` | `x new` before a database exists, and every test in this package |
| your own | implement `AuthAdapter`; DDL in `tables.ts` shows what the columns mean |

```bash
x db gen "auth tables"     # emits AUTH_TABLES into a migration
```

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
| `X_OAUTH_TOKEN_INVALID` | the id token failed its issuer, audience or expiry check |
| `X_OAUTH_PROVIDER_UNKNOWN` | the URL named a provider `defineAuth({ providers })` did not enable |
| `X_OAUTH_DENIED` | the user pressed Cancel, or the provider declined — `403`, never a `502` |
| `X_PASSWORD_WEAK` | strength check rejected the password |
| `X_ACCOUNT_LOCKED` | per-ip or per-account bucket is inside its lockout |
| `X_API_KEY_INVALID` | key unknown, revoked, expired or wrong |
| `X_ENV_MISSING` | `oauthCredentials()` found no client id or secret for an enabled provider |
| `X_NOT_IMPLEMENTED` | an `AuthAdapter` refused a method (`authNotImplemented(feature, fix)`), or lost a write it accepted — `emailVerifiedNotStored(provider, userId)` when `updateUser` drops the OAuth verified stamp |

```bash
bun test packages/auth
bun run --filter @ultimat3/auth typecheck
```
