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

## OAuth providers

Pure data. Importing `oauth.ts` performs no network I/O and reads no env.

| Provider | PKCE | Nonce | Env |
|---|---|---|---|
| `github` | S256 | — | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` |
| `google` | S256 | required | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |
| `apple` | S256 | required | `APPLE_CLIENT_ID` / `APPLE_CLIENT_SECRET` |

`exchangeOAuthCode()` validates the callback, then throws `X_NOT_IMPLEMENTED` naming those
env vars. Mismatched `state`, a missing verifier and a bad `nonce` all throw
`X_OAUTH_STATE_INVALID`.

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
| `X_PASSWORD_WEAK` | strength check rejected the password |
| `X_ACCOUNT_LOCKED` | per-ip or per-account bucket is inside its lockout |
| `X_API_KEY_INVALID` | key unknown, revoked, expired or wrong |
| `X_NOT_IMPLEMENTED` | OAuth token exchange without client credentials |

```bash
bun test packages/auth
bun run --filter @ultimat3/auth typecheck
```
