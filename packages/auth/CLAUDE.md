# @ultimat3/auth — agent notes

Tier 3. Produces the `Actor`; produces nothing else. Authorization is `@ultimat3/policy`'s job.

| Rule | |
|---|---|
| Deps | `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/db`, `@ultimat3/time`. No external deps. |
| Never import | `@ultimat3/policy`, `@ultimat3/http` (tier 2 consumers), `@ultimat3/mail` (sideways) |
| Policy seam | `PolicyActorFields` in `policy-bridge.ts` mirrors policy's shape structurally |
| Http seam | `RequestLike` / `CookieJar` in `session.ts`; http binds to them, not the reverse |
| Mail seam | injected `MailSender` port in `verify.ts`; the app wires `@ultimat3/mail`'s `send` |
| Better Auth | binds through `AuthAdapter`. It is an adapter, never a dependency. |
| Errors | `AuthError` from `errors.ts`; never `throw new Error` |
| Time | take a `Clock`. No `Date.now()` anywhere in this package. |
| Secrets | compare with `timingSafeEqual`; store `sha256Hex`. Never `===` on a secret. |

## Non-negotiables

- Every credential failure throws `loginFailed()` — one code, one cause, one fix. Adding a
  parameter to it re-opens account enumeration.
- Absolute and idle expiry are two separate computations in `sessionExpiry()`. Do not fold them.
- PKCE is not provider-dependent. `usesPkce: false` is not a valid provider config.
- The code flow carries `nonce` inside the id token, not on the redirect. `assertOAuthCallback`
  checks an echoed one when present and never requires it; `verifyIdToken` is the real gate.
- The handshake crosses two requests, so it is sealed (`sealHandshake`), never handed over in a
  variable. `openHandshake` takes the provider as an argument for the reason `decodeCursor` takes
  a scope: an optional check is one a call site forgets. Expiry is the server's clock, not `Max-Age`.
- One handshake cookie **per provider** (`handshakeCookieName`), never one shared slot. Two tabs
  are two handshakes in one jar, and a shared name makes the second redirect overwrite the first.
  `clearHandshakeCookie(provider)` for the same reason: clearing all of them cancels the other tab.
- `readCookie` never throws on a malformed value. The `Cookie:` header is attacker-controlled and
  `decodeURIComponent('%')` is a bare `URIError`, which would escape every coded path in this
  package — the raw value goes to the signature or hash check, which is the readable refusal.
- A token endpoint's HTTP 200 is not success — GitHub reports a dead code that way. Read `error`.
- Link by address only when the provider **and** the local account both verified it.
- id token signatures are not checked: it is read only where it arrived over TLS straight from
  the token endpoint (OIDC Core 3.1.3.7). Never parse one that reached the browser.
- An api key's scopes are the agent actor's scopes. Never union them with the owner's roles.
- Rotate the session id on any privilege change (`rotateSession`), never patch the row.

## Files

| File | Job |
|---|---|
| `auth.ts` | `defineAuth`, entity schemas, `login`/`register`/`authenticate`/`logout` |
| `policy-bridge.ts` | the one funnel: identity → `Actor`, all four `ActorKind`s |
| `session.ts` | two expiries, rotation, revocation, device list, the cookie |
| `adapter.ts` | the seam; `builtin-adapter.ts` (Postgres) + `memory-adapter.ts` |
| `rate-limit.ts` | per-ip + per-account buckets, lockout, `loginFailed()` |
| `oauth.ts` | provider data, PKCE, `beginOAuth`, the callback gate. No I/O, no env |
| `oauth-cookie.ts` | the handshake's home between the two legs: seal, open, the cookie |
| `oauth-exchange.ts` | `oauthCredentials` + the one POST to the token endpoint |
| `id-token.ts` | id token → claims this handshake may believe |
| `id-token-fixture.ts` | the one string-input JWT builder the OAuth tests share. Off `index.ts` |
| `oauth-profile.ts` | claims or userinfo → one `OAuthProfile` |
| `oauth-login.ts` | profile → account link → session. `completeOAuthLogin` is the entry point |

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
