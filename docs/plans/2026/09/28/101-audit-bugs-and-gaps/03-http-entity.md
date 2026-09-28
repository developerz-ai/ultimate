# 03 — http + entity

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 2.

## Files to change
| File | Defect | Verdict |
|---|---|---|
| `packages/http/src/csrf.ts:57` | `if (input.anonymous) return { ok: true }` — any cross-site anonymous POST passes. Login CSRF: attacker auto-submits `/api/sessions/create` with own creds; victim silently signed into attacker account (session issued at `auth/src/auth.ts:350`) | CONFIRMED, med (security) |
| `packages/http/src/navigation.ts:36` (`locationFor`), `:91` | non-same-origin target returned verbatim; `javascript:` counts as "another origin" → router `load`s it → XSS in app origin when an app redirect is attacker-influenced. Live since #575 (4eaa8162) | CONFIRMED, med (security) |
| `packages/http/src/cache-policy.ts:22` | `offersSharedCache` only counts `public`/`s-maxage`; `max-age=3600` on a cookie-authed response is left alone → CDN may store per-user body (RFC 9111 §3) | CONFIRMED, high |
| `packages/http/src/deadline.ts:96` | `setTimeout` delay > 2^31−1 ms clamps to 1 ms → `X_TIMEOUT` after ~11 ms. Reachable via `x-request-timeout-ms: 3000000000` with `requestTimeoutMs: 0`, or config > ~24.8 days (screen allows `MAX_SAFE_INTEGER`, `config.ts:261-264`) | CONFIRMED, med |
| `packages/entity/src/containment.ts:28` | `sameElement(null, null) === true`; Postgres `@>`, `&&`, `<@` never match NULL elements → memory ≠ pg | CONFIRMED, med |

## Steps
1. CSRF: drop the anonymous early return; anonymous non-safe requests go through `proveSameOrigin` like authenticated ones. Keep the `hasAuthorizationHeader` exemption. Refusal stays `X_CSRF_BLOCKED`. CHANGELOG + `wiki/Upgrading.md` row if it breaks header-less API clients (see overview risk).
2. `locationFor`: resolve, refuse any protocol other than `http:`/`https:` — fall back to a same-origin document load of the requested URL (not the target). Mirror the guard in render (slice 05).
3. `cache-policy.ts`: any freshness directive (`max-age`, `must-revalidate`, `proxy-revalidate`) without `private`/`no-store` is an offer → rewrite to `private, max-age=0` for an actor-bearing response; keep the `immutable` exemption.
4. `deadline.ts`: clamp `resolveTimeoutMs` and the config screen to `2_147_483_647`; above it = "no deadline". Config refusal through the existing config-screen error.
5. `containment.ts`: in `arrayContains`/`arrayOverlaps` only, a null on either side never matches. `jsonContains` unchanged (jsonb `null` is a value).

## Tests
- `packages/http/src/csrf.test.ts` — anonymous + `origin: evil.example` + `sec-fetch-site: cross-site` → refused; same-origin anonymous → ok.
- `packages/http/src/navigation.test.ts` — 303 to `javascript:alert(1)`, `data:`, `vbscript:` never surfaces in `x-ultimate-location`.
- `packages/http/src/cache-exchange.test.ts` — cookie actor + `max-age=3600` → `private`.
- `packages/http/src/deadline.test.ts` — header `3000000000` with `requestTimeoutMs: 0` → no timeout within 50 ms.
- `packages/entity/src/containment.test.ts` + a memory-vs-pg parity case in the entity memory-repo parity suite.
- `bun test packages/http packages/entity`

## Not a bug (don't reopen)
- `nextAfterSignIn` (`http/src/auth-redirect.ts:56`) — safe; `X-Forwarded-For` hop-count trust; 1 MiB body cap; session cookie flags; `forwarded`, `safe-url`, `host-rules`; entity `neq`/`in` with null.

## Done when
- All five tests fail on `fcfe31dc`, pass after; `bun run verify` `unit` green; reference-app gate still green (CSRF change must not break either app's sign-in flow).
