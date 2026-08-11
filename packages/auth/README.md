# @ultimat3/auth 🔐

**The output of authentication is an `Actor` from `@ultimat3/core`.** Nothing downstream
authorizes on a session row, a user row or an api key — http, actions, jobs and MCP all read
`ctx.actor` and hand it to `@ultimat3/policy`. One authz system, never two.

```ts
import { BuiltinAdapter, defineAuth, login } from '@ultimat3/auth';

export const auth = defineAuth({
  adapter: new BuiltinAdapter(),          // or MemoryAdapter, or your Better Auth binding
  session: { absoluteTtlMs: 30 * 864e5, idleTtlMs: 7 * 864e5 },
  password: { minLength: 12 },
  mfa: { issuer: 'Acme' },
  providers: ['github', 'google'],
});

const { actor, token, cookie } = await login(auth, { email, password, ip });
```

## Rules

- Every login failure throws `loginFailed()` from `rate-limit.ts`. Never a specific message.
- Session ids are opaque random tokens; only `sha256(secret)` reaches the database.
- Absolute and idle expiry are evaluated **independently**. Activity never moves the ceiling.
- PKCE is mandatory on every provider. A missing verifier fails the callback.
- Recovery codes, verification tokens and api keys are hashed at rest and single-use.
- Guards assert on the actor. They never evaluate a policy.

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

## OAuth

Two calls: one to leave, one to come back. Provider configs are pure data — importing
`oauth.ts` performs no network I/O and reads no env.

```ts
// GET /auth/oauth/:provider — redirect, keeping nothing on the server
export async function GET(request: Request): Promise<Response> {
  const handshake = beginOAuth({ provider: 'github', clientId, redirectUri });
  return new Response(null, {
    status: 302,
    headers: { location: handshake.authorizeUrl, 'set-cookie': handshakeCookie(handshake) },
  });
}
```

```ts
// GET /auth/oauth/:provider/callback — a separate request; the cookie is all that crossed
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { cookie } = await completeOAuthLogin(auth, {
    handshake: readHandshakeCookie(request, 'github'),
    callback: { state: url.searchParams.get('state') ?? '', code: url.searchParams.get('code') ?? '' },
  });
  const headers = new Headers({ location: '/' });
  // Both, always: a code is single-use, so the handshake that authorised it must not outlive it.
  headers.append('set-cookie', cookie);
  headers.append('set-cookie', clearHandshakeCookie('github'));
  return new Response(null, { status: 302, headers });
}
```

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
- An address is only linked to an existing account when **both** sides verified it. Otherwise
  whoever registered the address first inherits the login.

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
| `X_PASSWORD_WEAK` | strength check rejected the password |
| `X_ACCOUNT_LOCKED` | per-ip or per-account bucket is inside its lockout |
| `X_API_KEY_INVALID` | key unknown, revoked, expired or wrong |
| `X_ENV_MISSING` | `oauthCredentials()` found no client id or secret for an enabled provider |
| `X_NOT_IMPLEMENTED` | an `AuthAdapter` refused a method (`authNotImplemented(feature, fix)`), or lost a write it accepted — `emailVerifiedNotStored(provider, userId)` when `updateUser` drops the OAuth verified stamp |

```bash
bun test packages/auth
bun run --filter @ultimat3/auth typecheck
```
