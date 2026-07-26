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

```bash
bun test packages/auth
bun run --filter @ultimat3/auth typecheck
```

Gotchas:
- `exactOptionalPropertyTypes` — declare optional fields as `x?: T | undefined`.
- `noUncheckedIndexedAccess` — index a `Record` into a local before narrowing it.
- `X_NOT_IMPLEMENTED` is core's, `X_FORBIDDEN` is policy's: `errors.ts` guards registration
  with `hasErrorCode()` or import order throws `X_ERROR_CODE_DUPLICATE`.
- Tests run against `MemoryAdapter`; nothing in this package needs a database.
