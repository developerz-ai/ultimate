# 04 — http + auth

> Part of [`overview.md`](overview.md). Depends on: 01, 02 (row k shares `response.ts`). Tier: 2.

Rule: a signed-in response is never shareable. A header that authenticates is parsed exactly
once. A public error body never carries text the server did not write.

## Files to change

| # | Defect | File:line | Change | Semver |
|---|---|---|---|---|
| a | a declared `meta.cache` / `ctx.cache` with `mode: 'public'` is applied to a signed-in actor: `public, s-maxage=3600` on a body carrying `{"me":"u1"}`. This contradicts `http/README.md:83` | `packages/http/src/stages.ts:315-321` | In the `declared === null` branch, a `public` hint with a non-anonymous actor becomes `PRIVATE_CACHE`. `immutable` stays exempt, as at `:331-333` | patch |
| b | `?locale=` is documented (`wiki/I18n.md:123`) and never read | `packages/http/src/stages.ts:477-481` | Pass `query: ctx.url.searchParams.get('locale')` to `resolveLocale` | minor |
| c | the retry link on an error page is `ctx.url.pathname`, so a request for `//evil.com/x` renders `href="//evil.com/x"`. It is reachable on the 503 served while draining | `packages/http/src/error-page.ts:127` | Collapse a leading run of `/` to one, or link `/` when the path starts with `//` | patch |
| d | XFCC is unescaped twice: `forwardedElement(…, splitUnquoted)` strips quotes, then `pairsOf` splits the stripped text again. `Subject="O=Acme; Inc,CN=svc-one"` and `…svc-two` both become `O=Acme`, and `CN=checkout\"` becomes `CN=checkout` | `packages/http/src/peer-identity.ts:86-92` | Split elements with quotes and escapes kept (a raw splitter). Unescape each value only after `pairsOf` | patch |
| e | CSP, including a SHA-256 of `OVERLAY_STYLE`, is rebuilt on every response: 20.9 µs, 18.8% of a trivial GET | `packages/http/src/stages.ts:454`, `security-headers.ts:101,116` | Memoise `securityHeaders` per `(SecurityConfig, https)` in a `WeakMap` on the frozen config | patch |
| f | every 4xx is logged at `error` | `packages/http/src/stages.ts:367` | `status < 500` logs at `warn` (401/403/429) or `info` (404/400). Grep `docs/ops/03-observability.md` for alert rules keyed on level and update them | minor |
| g | a failing userinfo or GitHub-emails fetch puts the thrown error's text (which can hold internal DSNs) into the public 502 body | `packages/auth/src/oauth-profile.ts:82-88` → `oauth-route.ts` `publicBody` | Do what `oauth-exchange.ts:208-221` does: log `auth.oauth.userinfo_fetch_failed` with `renderThrowable`, and use fixed prose in `detail` | patch |
| h | `providerDetail(response,'coded-only')` still echoes `parsed.message`, which is not an OAuth field. A gateway echoing the request body leaks `client_secret` | `packages/auth/src/oauth-exchange.ts:136` | Under `coded-only`, read only `error` and `error_description` | patch |
| i | `issueApiKey({ env: 'live_eu' })` issues a key `parseApiKey` refuses | `packages/auth/src/api-keys.ts:35` | Refuse an empty `env` or one containing `_` at issue time: `X_CONFIG_INVALID` (exists in auth), cause `api key env "<env>" contains "_", which parseApiKey splits on`, fix `pass env matching ^[a-z0-9-]+$ to issueApiKey (e.g. 'live-eu')` | patch |
| j | `linkAccount` on an existing (provider, account) pair: Postgres keeps the old `user_id` but returns the new object, while memory replaces the row. `listApiKeys` ordering also differs (suspected) | `packages/auth/src/builtin-adapter.ts:275` vs `memory-adapter.ts:213` | Add both cases to `adapter-parity.test.ts`, then align memory to Postgres | patch |
| k | the deadline fires while the handler keeps running, and a late finish can overwrite `ctx.response` (suspected) | `packages/http/src/pipeline.ts` `execute` | Reproduce with a gated handler. If real, freeze `ctx.response` after the deadline answer | patch |

## Steps
1. Write failing tests for a, c, d, g and h first. These are the security rows.
2. e and f are perf and ops. Measure before and after with the pipeline micro-bench under `scripts/bench/`, and record the numbers in the PR.
3. Reproduce j and k before fixing.

## Tests
- `bun test packages/http/src packages/auth/src`
- h: in `oauth-route.test.ts`, drive a parsed token-endpoint answer `{"message":"…client_secret=SECRET…"}` through the route and assert the public body omits `SECRET`. A separate case asserts a normal `error_description` is still shown (it is an allowed OAuth field).
- New cases: `pipeline-cache.test.ts` (a), `locale-stage.test.ts` (b), `error-page.test.ts` (c), `peer-identity.test.ts` (d, three headers), `oauth-route.test.ts` (g, h), `api-keys.test.ts` (i).

## Done when
- No test can produce `s-maxage` on an identified request.
- The three XFCC fixtures give three distinct identities.
- No OAuth failure body contains the injected secret string.
