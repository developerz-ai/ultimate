# 04 — The demo adopts `@ultimat3/auth` (decision 9)

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 2 + the demo app.

## Files to change
- `packages/auth/src/auth.ts` — `login(auth, { handle, password })` beside `{ email, password }`, resolved through `defineAuth({ handles })`, a function the app hands in: handle → user id. Same limiter buckets, same decoy KDF, same `loginFailed()`.
- `dummy/social-media-clone/apps/web/app/auth/` — `defineAuth` over `postgresAuthAdapter()`; delete `password.ts`, the session half of `service.ts`, `shared/session.ts`; the actor still resolves the friend and block sets.
- `dummy/social-media-clone/packages/db/` — migrate `credentials`/`sessions` away.

## Steps
1. Failing tests first: handle login succeeds, an unknown handle burns the KDF and counts against the bucket, an app without `handles` refuses a handle login.
2. Sign-up registers the auth user, then the app user under the same id.

## Done when
- The demo signs in and out through `login()`/`logout()`; its gate green; `DOMAIN.md` matches.
