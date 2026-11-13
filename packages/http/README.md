# @ultimat3/http 🌐

A thin, **owned** layer over `Bun.serve`. Not a framework-agnostic HTTP kit — the
lifecycle belongs to us so ALS context, tracing, locale/tz and authz are impossible
to skip.

`bun add @ultimat3/http` · guide: [Routes And Render Modes](https://github.com/developerz-ai/ultimate/wiki/Routes-And-Render-Modes)

```ts
import { configureHttp } from '@ultimat3/http';

configureHttp({ bodyLimitBytes: 8 * 1024 * 1024, requestTimeoutMs: 300_000 });
```

## What it owns

| Concern | Module |
|---|---|
| server lifecycle, drain, `/healthz` + `/readyz` | `server.ts`; `health-disclosure.ts` owns the `healthDetailPeers` key, its screen and the proxy half — the body rule is `@ultimat3/core`'s |
| route table, matcher, `describeRoutes()` | `router.ts` |
| a pathname's segments, their decoding, and its ONE spelling (`canonicalPath`) — shared by the matcher and by every store keyed on an address; `ctx.routePath` and `requestAddress(ctx)` say where a request was matched | `route-path.ts`, `locale-prefix.ts` |
| the ordered request lifecycle | `pipeline.ts` |
| typed request (params, query, body) | `request.ts` |
| response constructors + `problem()` | `response.ts` |
| code → status, closed table | `error-map.ts`, composing `error-map-http.ts` + `error-map-tier-<n>.ts` |
| `factsOf()`, the problem document, the terminal lines | `error-facts.ts` |
| token-bucket limiting, `toBucket` | `rate-limit.ts` |
| the app's own HTTP declaration, and the boot's facts over it | `app-config.ts` |
| CORS, CSP/HSTS | `cors.ts`, `security-headers.ts` |
| CSRF (origin proof for an unsafe request a browser sent) | `csrf.ts` |
| the request deadline and `ctx.signal` | `deadline.ts` |
| the caller's real address behind a proxy | `forwarded.ts` |
| the inbound request id and trace, read before the span | `correlation.ts` |
| the `server` span (OpenTelemetry's stable `http.*`/`url.*`/`server.*` names, `ultimate.request_id`) and `http.request` on core's instrumentation bus, once per request | `pipeline.ts` |
| dev error overlay | `overlay.ts` |

## What an app declares: `configureHttp()`

```ts
// apps/web/app/http.ts — module scope, imported by the app like any other module
import { configureHttp } from '@ultimat3/http';

configureHttp({
  cors: { origins: ['https://app.example.com'], credentials: true },
  bodyLimitBytes: 8 * 1024 * 1024,   // this API takes a 4 MB CSV
  requestTimeoutMs: 300_000,          // and an export that really does take five minutes
  rateLimit: {
    tenantBucket: 'tenant',
    buckets: { tenant: { capacity: 5_000, refillPerSecond: 100 } },
  },
});
```

One registration, read once by whatever process starts the web role — the same seam
`configureAuthenticator(authenticate, { credentialTtlMs? })` is. `credentialTtlMs` is what a
resolved identity is worth on a connection that carries no further request (the `sync` node's
websocket re-asks after it; omitted, five minutes) — the credential's lifetime is the
authenticator's fact, so it is declared beside the function, never as a second authenticator. **Breaking, `As of 2026-08-24`**: before it, the only `HttpConfig`
any shipped process built was a fixed literal inside `@ultimat3/cli`, so none of the four values
above could be set from an app at all — `cors.origins` was `[]` in every deployment, which refuses
every cross-origin browser call, permanently. `AppConfig` has never carried an `http` key and does
not gain one: `@ultimat3/core` is tier 0 and cannot hold this package's types.

`cors.allowHeaders` and `cors.exposeHeaders` default to what the typed clients send and read, off
core's constants (`idempotency-key`, `x-request-timeout-ms`, `traceparent`; `x-ultimate-records`,
`x-ultimate-dates`, `x-ultimate-replayed`, `ratelimit-*`, `deprecation`, `sunset`, `link`), so
listing an origin is the whole declaration. A list of the app's own replaces the default whole.

`AppHttpConfig` is `Omit<HttpConfigInput, BootOwnedHttpKey>` — `port`, `hostname`, `dev`,
`buildId`, `signInPath`, `trustProxy`, `trustedProxyHops` and `rateLimit.scope` are the boot's, and
writing one here is a **type error** rather than a value silently overwritten at the next boot.
`mergeHttpConfig(configuredHttp(), boot)` is the layering, and it merges `security.csp.extend` per
directive: the app's CDN source and the boot's inline-script hash are each the whole answer for
something.

## The pipeline is the guarantee

```
request-id → admit → trace → context → locale → auth → rate-limit → csrf → body → authz
           → handler → cache-headers → (error-map) → response → compress
```

Exported as `PIPELINE_STAGES`, each entry carrying a `why`. `pipeline.test.ts`
asserts the order. Ordering rules worth restating:

| Rule | Reason |
|---|---|
| admit second | a stopped or saturated process refuses before any work — no route match, no auth, no body; a DRAINING one serves and closes the connection |
| auth before rate-limit | limiter keys per actor/tenant, not per NAT address. A request that FAILS `auth: 'required'` leaves here, so this stage spends `rateLimit.defaultBucket` for it under `unauthenticated\|ip:<address>` — one key per address across every route, the bearer mount's bad tokens included; a signed-in caller behind that address spends nothing from it |
| csrf after auth | it has to know who is calling: a bearer caller is exempt (not ambient); an anonymous write is judged like a signed-in one once it carries `Origin` or `sec-fetch-site`, because a forged sign-in lands the visitor in the attacker's account. Anonymous with neither header — a webhook, a server-to-server call — passes. A route declaring `meta.csrf: 'cookieless'` (an RFC 6749 token endpoint) passes an anonymous caller; it needs its own `meta.authenticate`, or `httpRouter` refuses it `X_CONFIG_INVALID` |
| csrf before body | a forged write never makes the server allocate its payload |
| rate-limit before body | a limited request never allocates its payload |
| body before authz | policies take parsed input as their subject |
| cache-headers before response | a directive can never drop a security header |

What the lifecycle refuses on the caller's behalf, `As of 2026-08`:

| Guard | Answer |
|---|---|
| a body past `bodyLimitBytes` | read through the stream and abandoned the instant the running total crosses the limit — `content-length` or not, multipart included — as `X_BODY_INVALID` |
| a request carrying an identity on an `auth: 'public'` route | `cache-control: private`, never `s-maxage`; an anonymous one is shared-cacheable and keyed `vary: accept-language, cookie, x-timezone`. **Whatever the handler wrote**, `As of 2026-08-23`: the `cache-headers` stage REVIEWS a declared `cache-control` instead of standing down, because `@ultimat3/render`'s `ssrHeaders` offers every page without a `policy` to a CDN for 30s. An `immutable` answer is left alone — a content-addressed body is a function of its URL. **A declared hint too**, `As of 2026-09-23`: `meta.cache` / `ctx.cache` with `mode: 'public'` becomes `private` for a signed-in actor (`reviewedHint`) |
| any 5xx whose code did not opt in with `registerProblemMeta({ CODE: { publicCause: true } })` | `As of 2026-09-23`, not only an undeclared one — `X_DB_STATEMENT_FAILED` has a status row and served the Postgres message and the SQL. The framework opts in `X_DRAINING`, `X_OVERLOADED`, `X_FLIGHT_GATE_OVERLOADED` and `X_TIMEOUT`, whose cause is the instruction. The rest: |
| a 5xx nobody declared a status for | the code, the request id and a `fix:`; never the exception's own text. `error-page.ts` locked the browser out of it, and the problem document handed the same string to an agent — a driver's DSN, the row Postgres rejected. The real text goes to the log and the error report. `dev: true` renders it in full |
| a `security.csp.extend` key that is not a CSP token, or a source carrying `;`, `,` or a space | `X_CSP_DIRECTIVE_INVALID` at `defineHttpConfig` — `{ 'x; script-src *': [] }` is a second directive nobody declared |
| a repeated form field | a LIST, exactly as a repeated query parameter is. One collector for query, urlencoded and multipart; `Object.fromEntries` kept the last value, so a checkbox group reached the schema as one string |
| a cross-origin request from an origin the allow-list refuses | no `access-control-allow-origin`, but always `vary: origin`, so a shared cache never answers an allowed origin out of the refusal's slot |
| `cors.origins: ['*']` with `credentials: true` | `X_CORS_CONFIG_INVALID` at `defineHttpConfig`, because a browser accepts that pair from nobody |
| a `cors.origins` entry no browser sends — `'https://app.com/'`, `'https://App.com'`, `'https://app.com:443'`, `'app.com'` | `X_CORS_CONFIG_INVALID` at `defineHttpConfig`, its `fix` naming the canonical form (`URL.origin`). `As of 2026-11` (v31): the match is byte for byte, so each spelling matched nothing and refused every cross-origin write |
| a body past `maxRequestBodyBytes` (default 128 MiB, never below `bodyLimitBytes`) — declared or streamed | `X_BODY_TOO_LARGE` (413). `As of 2026-11`: Bun's own `maxRequestBodySize` is off — it answered an empty, uncoded 413 before any framework code, and its 128 MiB default refused every larger signed upload. `configureHttp({ maxRequestBodyBytes })` raises the ceiling |
| `?next=` carrying anything but a same-origin path | the fallback — including a value whose TAB/CR/LF a browser strips back into `//evil.test`, and any other control character. `nextAfterSignIn` takes the value its caller's parser already decoded and never decodes it again, `As of 2026-10`: `?q=a%26b` lands as `?q=a%26b`, not `?q=a&b`. A code point above U+007F is percent-encoded so a `Location` header can carry it. The answer is the normalised path (`/a/../b` → `/b`), and one whose pathname starts `//` (`/.//evil.test`) is refused; `x-ultimate-location` never carries a same-origin pathname starting `//` either |
| a browser with no session on a localized URL (`/es/account`) | `303` to the sign-in page in that locale (`/es/login?next=%2Fes%2Faccount`), `As of 2026-11` — it went to the default-locale `signInPath` and switched the visitor's language at the door |
| `Range: bytes=5-3` (last byte before the first) | ignored, `200` with the whole body (RFC 9110: an invalid range-spec is ignored), `As of 2026-11`; `416` stays for a valid range past the size |
| HSTS | emitted only when the connection is affirmatively https (`ctx.https`); never by the zero-argument default |
| `rateLimit.scope: 'shared'` on a per-process store | `X_RATE_LIMIT_NOT_SHARED` at `httpServer`, because N replicas each holding their own counters enforce N × every configured number |
| a route's own bucket and a configured bucket of that name disagreeing | `X_RATE_LIMIT_BUCKET_CONFLICT` at `httpServer`, because the loser would be a number someone read and nothing applied |
| a `rateLimit.tenantBucket` naming a bucket nothing declares | `X_RATE_LIMIT_TENANT_BUCKET_UNKNOWN` at `defineHttpConfig`, because the name would fall through to `default` and a whole tenant's cap would silently be the 120-burst read bucket |
| an injected limiter that does not hold a bucket a route declares | `X_RATE_LIMIT_BUCKET_UNBOUND` at `httpPipeline`, because the name would fall through to `default` — measured at 120 burst for a route declaring 5 |
| a config that never declared `rateLimit.scope` | `X_RATE_LIMIT_SCOPE_UNSET` at `defineHttpConfig`. **Breaking, `As of 2026-08`**: `'process'` used to be the default, so "nobody asked" and "the app said one replica" were the same value while the chart runs three |
| `trustProxy: true` with no `trustedProxyHops` | `X_TRUST_PROXY_UNSET` at `defineHttpConfig`. **Breaking, `As of 2026-08`**: `trustProxy` now defaults to `false`, and `x-forwarded-for` is read at `entries.length - hops` — never at `[0]`, which is whatever the client typed |
| an unsafe method from a browser — signed in, or anonymous with `Origin`/`sec-fetch-site` — that cannot be shown to be same-origin | `X_CSRF_BLOCKED` (403). `sec-fetch-site: same-origin`, `Origin` equal to this app, or an EXACT listing in `cors.origins` — anything else is refused before the body is read. `origins: ['*']` lists nobody here: `'*'` is a value for the response header, not a per-origin allowance |
| a request past `requestTimeoutMs` (30s) | `ctx.signal` aborts and the socket is answered `X_TIMEOUT` (504); a caller may shorten the deadline with `x-request-timeout-ms`, never lengthen it. A handler still running after the 504 stays in core's in-flight count until it settles, so a drain waits for it instead of closing the pool under it |
| a handler silent for longer than Bun's 10 s idle default | ANSWERED: `start()` hands `Bun.serve` an `idleTimeout` of `socketIdleTimeoutSeconds(requestTimeoutMs)` — `ceil(ms / 1000) + 2` s, `0` (off) for no deadline or one past Bun's 255 s ceiling — so the socket outlives the deadline. `As of 27.16.0`: Bun's default cut every such request at ~10–12 s, a 502 behind a proxy, whatever `requestTimeoutMs` said |
| a budget above `2_147_483_647` ms | no timer holds it: `requestTimeoutMs` past it is `X_CONFIG_INVALID`, and an `x-request-timeout-ms` past it is ignored — it used to arm a ~1 ms timer |
| the caller going away mid-request | `ctx.signal` aborts on the inbound `Request.signal` too, so a closed tab unwinds cooperative work instead of holding its pool slot for the rest of the budget. Both halves are one signal — the caller's abort is forwarded into the deadline's controller, first abort wins with its own reason — and `requestTimeoutMs: 0` still delivers the caller's |
| a request while the process is draining | SERVED, with `connection: close` so the client's next request lands on another pod, `As of 2026-09-23` — refusing it failed 598 of 7,690 requests across one helm upgrade on kind, every one on a kept-alive connection inside the readiness grace. Only a STOPPED process (resources closed) answers `X_DRAINING` (503) + `retry-after` |
| SIGTERM | `/readyz` answers 503 at once, the listener stays open for `drain.readinessGraceMs` (core; 5000 ms outside development/test, 0 inside), then closes and the drain runs. Pass `httpServer({ …, drain: appConfig.drain })` so `app.config.ts`'s value is the one applied; omitted, core's default holds and a `configureLifecycle({ readinessGraceMs })` stands |
| `?locale=es` | the locale source that outranks the cookie and the header (`resolveLocale`'s order), `As of 2026-09-23` — documented in `wiki/I18n.md` and never read before |
| a 4xx | logged at `warn` (401, 403, 429) or `info` (every other 4xx); only a 5xx is an `error` line. Every `info` refusal — routine, 404, 400, 422 — is `info` once per route and code per minute, `debug` after |
| `x-forwarded-client-cert` without `trustClientCertHeader: true` | `ctx.peer` is `null`. **Breaking**: `trustProxy` alone used to read it, and an ingress that appends to `x-forwarded-for` need not strip a certificate header the client sent |
| `/healthz`, `/readyz` from a peer `healthDetailPeers` does not list | `{ state, ready, role }` and the same status code; `buildId`, `inflight`, `uptimeMs`, `checks` and `registered` go to a listed peer only (default `['loopback']`), and behind a declared proxy the forwarded caller must be listed too |
| a `/<default-locale>/…` URL | `301`/`308` to the unprefixed path, normalised as the router matches it — `//host/x` after the prefix is `/host/x`, never a scheme-relative `Location` |
| a 3xx to a client-router request whose target is not `http:`/`https:` | `x-ultimate-location` names the REQUESTED url as a path; the target is never handed over, and one that will not parse is treated the same |
| a handler's `cache-control` carrying `max-age`, `must-revalidate` or `proxy-revalidate` with no `private`/`no-store` | an offer to a shared cache (RFC 9111 §3): `private, max-age=0` for a request carrying an identity, `vary`-keyed for an anonymous one. `immutable` stays exempt |
| a `text/*` body | decoded by its `charset` parameter (UTF-8 when none), `As of 2026-11`: `utf-8`, `utf-16le`, `utf-16be`, `windows-1252` (`latin1`/`iso-8859-1` resolve to it); any other label, known or not, is `X_BODY_INVALID`. JSON and forms stay UTF-8 by their own specs (`request-charset.ts`) |
| a body with no `content-type` | `X_BODY_INVALID` from `bodyRaw()` / the `body` stage — it used to read as "no body", so an all-optional schema validated a request nobody parsed. `bodyBytes()` still reads it |
| two cookies set in one request | two `Set-Cookie` lines: the `response` stage appends them, where `headers.set` in a loop kept the last and dropped any on the handler's own Response |
| a 5xx whose cause is withheld | its `fix` is the error's `callerFix`, else `x errors explain <CODE> --json` — never the developer's `fix:`, which is written from the same statement, row or path the cause was |
| `buildId: null` | skew detection off, whatever `BUILD_ID` says; `hostname` never defaults from `HOSTNAME` (the container id under Docker) |
| an `x-forwarded-client-cert` value in quotes | unescaped ONCE, after the pairs are split — `Subject="O=Acme; Inc,CN=svc-one"` is that whole subject, not `O=Acme` |
| a request past `maxInflight` (1000) | `X_OVERLOADED` (503) + `retry-after`, shed in the `admit` stage before any work |
| `shedLagMs: 250` and an event loop whose lag p99 (two seconds, sampled every 20 ms) is past it | `X_OVERLOADED` (503) + `retry-after: 1` from `admit`: the CPU-bound overload `maxInflight` cannot see. **Off by default in 31.x** (`0`): no sampler runs, nothing is shed on lag, `As of 2026-11` |
| a request slower than `slowRequestMs` (1000; `0` off) | one `http.request.slow` line at `warn` (`SLOW_REQUEST_MESSAGE`): `http.request.method`, `http.route` (the pattern), `http.response.status_code`, `durationMs`, `gateMs` (the stages before the handler), `handlerMs`, `dbStatements`, `dbMs`, `renderMs`, `cacheHits`, `cacheMisses`, and the request and trace ids. No per-request access log: the request metric and the trace are that record |
| `Server-Timing` | `total;dur=…` always; under `x dev` also `gate`, `handler`, `db` (with the statement count), `render` and `cache` — never in production, where a statement's duration is a timing oracle. The statement, render and cache figures are heard on the bus by `subscribeRequestTimings()`, which the boot installs once beside `subscribeSemconvMetrics()`; `requestTimings(ctx)` reads them |
| an anonymous hit on an `auth: 'required'` route (`X_UNAUTHENTICATED`, routine) | counted in `http_refusals_total{code}` (every 4xx is), logged at `info` once per route and code per minute and at `debug` after. A credential checker's own `X_UNAUTHENTICATED` stays `warn` |
| `accept-encoding` on a compressible public answer | `compress` negotiates `zstd` then `gzip` (RFC 9110 weights), gives a 304 the same validator form as its 200 (`etag-form.ts`), and codes a public strong-ETag body once per process (`compress-cache.ts`, LRU 512 entries / 16 MiB) at zstd 9 / gzip 9 — paid once, so stronger than the per-request zstd 3 / gzip 6 (170,641 B sheet: 22,051 B against 27,136 B, `As of 2026-11`). A `public, immutable` answer with no strong ETag (island chunks, surface stylesheets) is coded once more after its first hit, on the thread pool, as brotli 11, zstd 19 and gzip 9 (`compress-precode.ts`; keyed by path + length + byte hash, 2 at a time), and every later hit is a lookup: `br` when the client also offers `zstd` or `gzip`. Measured on a 170,641 B sheet: 19,496 B brotli against 27,136 B zstd 3, `As of 2026-11`. Exported: `PRECODERS` (the three coders, each on the thread pool; `x build --target static` writes `.br`/`.gz` siblings with them), `PRECODINGS`, `Precoding` |
| a public text answer of at least 1 KiB, or with no declared length | gzip on the wire, from the last stage (`compress`), `vary: accept-encoding` and a weak `etag`. Up to 256 KiB with a declared length it is coded whole (`gzipSync`, with its `content-length`); past that, or a stream with no declared length once its first 1 KiB has arrived — CSV, a large JSON export — it is coded as the client pulls (`CompressionStream`, no `content-length`), `As of 2026-11`; an undeclared body that ends under 1 KiB leaves identity with its length, and an undeclared NDJSON feed is never coded (the coder emits nothing until its source closes). A HEAD answered with no body has nothing to measure and stays identity. A private answer, a signed-in one that is not `immutable`, `no-store`, `no-transform` or a range stays identity and unread. HEAD carries GET's coded headers. Exported: `isCompressibleType(contentType)`, `COMPRESS_MIN_BYTES`, `COMPRESS_MAX_BYTES` |

`handle()` resolves to a Response, always — a stage that throws after the handler, or while
rendering another stage's throw, degrades to `X_PIPELINE_FINALIZE_FAILED` (500, the stage named in
`cause`) and the chain finishes that document instead. `finalize.ts` owns that promise.

## Rate limiting holds where the app says it holds

The counters live in a `RateLimitStore`. `memoryRateLimitStore()` is the default and is **one
process' worth of state**, so a deployment at `replicas: 3` enforces every bucket three times over.
The app declares which it needs and passes the store that provides it — the store is the only
thing that knows where its counters live, and a framework that inferred the answer from the
environment would get it wrong on the first deployment that scaled differently.

A store answers three calls: `take(key, bucket, cost, nowMs)` spends, `peek(key, bucket, nowMs)`
reads (refill applied, **no write and no row** — a key never taken is full; `rateLimitPeek` and
`refilledTokens` do the arithmetic) and `reset(key)`. `peek` is required, `As of 2026-10`: the
`auth` stage asks it on every request to an `auth: 'required'` route.

**One store, one place to choose it, `As of 31.0.0`.** Routes and primitives (an action's or a
query's declared `rateLimit:`) count in ONE installed store. The boot installs
`postgresRateLimitStore` over the pool it opened; an app that wants another names it in
`apps/<app>/runtime.ts`, and nowhere else — `httpServer({ rateLimitStore })` and the barrel's
`installRateLimitStore` / `adoptRateLimitStore` are gone (Upgrading, 30 → 31). The installer lives
on `@ultimat3/http/adapter`, which the boot imports; an app never calls it.

```ts
// apps/web/runtime.ts
import type { RateLimitStore } from '@ultimat3/http';

declare const myStore: RateLimitStore;   // its own scope is 'shared'
export const runtime = { rateLimitStore: myStore };
```

| Declared | Store | Result |
|---|---|---|
| nothing | any | `X_RATE_LIMIT_SCOPE_UNSET` at `defineHttpConfig` — **breaking, `As of 2026-08`** |
| `'process'` | any | boots; the limit is per replica, which is what was asked for |
| `'shared'` | `scope: 'shared'` | boots; one bucket for the fleet |
| `'shared'` | `scope: 'process'`, or `enabled: false` | `X_RATE_LIMIT_NOT_SHARED` at boot |

There is no default. `'process'` used to be one, which made "the app never said" and "the app
said one replica" the same value while `docker/helm/values.yaml` runs three — and
`X_RATE_LIMIT_NOT_SHARED` only fires on a `'shared'` declaration, so the silent case was exactly
the one nobody declared. A limiter with `enabled: false` owes no declaration: nothing is enforced,
so nothing can be wrong.

The installed store feeds the `PipelineDeps.limiter` seam rather than sitting beside it: the
bucket maths stays in `rateLimiter`, so every driver agrees on the numbers.

**One request spends a LIST of keys, `As of 2026-08-24`** — the caller's (`actor`, else `org`,
else `ip`) and, when the app declared `rateLimit.tenantBucket`, that caller's tenant. The key
builder used to pick exactly ONE subject and consult `orgId` only when there was no actor id,
which no authenticated request ever satisfies: a tenant with 8,000 seats took 8,000 × the
per-actor burst against one shared pool, every bucket inside its own limit, and no number an
operator could set would have refused it. The tenant key is `tenant|org:<id>` and is deliberately
NOT scoped to the route — a per-route tenant bucket is the same allowance once per route. The
spend stops at the first refusal, so a caller its own bucket refused costs its tenant nothing, and
the `ratelimit-*` headers report the bucket closest to refusing. `tenantBucket` defaults to `null`:
one tenant is a person and the next is five thousand seats, so there is no allowance a framework
can pick for you.

**A shared store ships, `As of 2026-08`** — `postgresRateLimitStore({ executor })`, one table
and one `insert … on conflict` per take (a peek is one `select`), so N replicas count against one bucket. Until it landed,
`scope: 'shared'` was a declaration nothing in the framework could satisfy while `x new` scaffolded
`replicas: 2`. `executor` is a `PgExecutor` — anything speaking `query(text, values)`, which is one
line over the client the boot already opened; **never `Bun.sql`**, whose `.query` is `undefined`.

```ts
// apps/web/runtime.ts — only when the boot's own default is not the one you want
import { baseClient, dbExecutor } from '@ultimat3/db';
import { type PgExecutor, postgresRateLimitStore } from '@ultimat3/http';

// The pool this process already opened, never a request's open transaction — the boot builds
// the same executor when it installs the store for you.
const executor: PgExecutor = dbExecutor(baseClient);

export const runtime = { rateLimitStore: postgresRateLimitStore({ executor }) };
```

**The table is UNLOGGED, `As of 2026-11`** — `x_rate_limit` is declared `RATE_LIMIT_STORAGE`
(`unlogged`, `fillfactor = 70`), so a take writes no WAL record (2 before, measured with
`explain (analyze, wal)`) and stays a HOT update (0.949 over 2,000 live buckets, 0.315 at the
default fillfactor), and a take no longer writes `updated_at`. The boot converges a table an
earlier version created: `alter table x_rate_limit set unlogged` rewrites it under `ACCESS
EXCLUSIVE`, bounded by the migrate role's `lock_timeout`. **After a crash** Postgres truncates an
unlogged table, so every bucket comes back FULL — one free burst per key, never a lockout; a clean
restart keeps it, a promoted standby starts empty. `x_auth_lockouts` stays logged.

**A Redis store ships too, `As of 2026-11`** — `redisRateLimitStore({ client })`, one Lua token
bucket per take (`EVALSHA`, falling back to `EVAL` on `NOSCRIPT`), a peek one `HMGET`. A hot key —
one NAT, a tenant bucket — no longer serialises every request on one Postgres row lock. Each key
expires once it would be full again, so it needs no purge. Same `scope: 'shared'`, same deadline
(`deadlineMs`, 250 ms) and the same degrade-to-this-pod's-memory on an outage, `ERR_REDIS_CONNECTION_CLOSED`
included. Connect the client before the first request, or the first takes are decided in memory.

```ts
// apps/web/runtime.ts
import { redisClient } from '@ultimat3/core/redis';
import { redisRateLimitStore } from '@ultimat3/http';

export const runtime = { rateLimitStore: redisRateLimitStore({ client: redisClient(), prefix: 'app' }) };
```

**An IPv6 caller is its `/64`, `As of 2026-11` (v31)** — `@ultimat3/core`'s `addressNetwork(ip)` is the address
every anonymous key and the failed-credential key count by: IPv4 whole (an IPv4-mapped IPv6 is its
IPv4), any other IPv6 `<first four hextets>::/64`. One subscriber holds a /64, so the full address
handed each holder a fresh bucket per request.

The table bounds itself only when something asks it to: `store.purgeExpired(ctx.now().getTime())`
from a `task` drops every bucket that has refilled to capacity, which is the memory store's forget
rule. `nowMs` is required and must come from the same clock the takes use — measured against the
server's clock instead, the offset between the two reads as refill and deletes buckets a throttled
caller is still sitting in.

The maths reads an injected `Clock`, defaulting to `systemClock`: `rateLimiter({ config,
clock })`. **Breaking, `As of 2026-08-19`** — it took `now?: () => number` before and read
`Date.now()` when nothing passed one, which both production call sites did, so the limiter that
actually throttles a request could not be frozen. Replace `now: () => t` with
`clock: frozenClock(t)`; a limiter you build yourself still reaches the pipeline through
`PipelineDeps.limiter`, which stays the only seam for one.

### A route may bring its own bucket

`meta.rateLimit` names a bucket; `meta.rateLimitBucket` is the numbers that bucket must hold.
`withRouteBuckets` registers them at construction — `httpServer` and `httpPipeline` both apply
it, idempotently — because `defineHttpConfig` runs before any route exists and cannot have them.
Without that half, a name nothing defined fell through `bucketFor` to `default`: an action
declaring `limit: 5` ran on 120 burst, and the number reached the OpenAPI document all the same.

| Declared | Configured under the same name | Result |
|---|---|---|
| nothing | — | `default`, unchanged — most routes |
| numbers | nothing | the route's numbers, registered |
| numbers | the same numbers | boots; a restatement is not a disagreement |
| numbers | different numbers | `X_RATE_LIMIT_BUCKET_CONFLICT` at boot |

Neither source wins a disagreement, because whichever lost would stay a number an author read and
nothing enforced. `toBucket` — in **this** package, beside `Bucket` and the maths it validates, because `action` and
`query` are the same tier and can never import each other — is the one conversion from a
declaration's
`{ limit, windowMs }` to a bucket's `{ capacity, refillPerSecond }`, and it refuses a pair the
limiter could not run on — including one whose two halves look fine and whose **division** does
not, like `{ limit: Number.MAX_VALUE, windowMs: 1 }` computing to an infinite refill.

Registering into the config is only half of it, because the limiter resolves names against the
table **it** closed over. `RateLimiter.buckets` publishes that table — declared, never inferred,
the same rule as `RateLimitStore.scope` — and `assertRouteBuckets` compares it against the routes
at construction. A limiter passed to `PipelineDeps.limiter` that cannot enforce a declared bucket
is refused rather than rebound: a `RateLimiter` is opaque, so rebinding would mean discarding the
store it carries, and a caller who built their own limiter may have meant their own numbers. Pass
no limiter — `httpServer({ routes })` builds one over the installed store from the merged table.

## Routing

Precedence is structural, not declaration-ordered: **static > param > wildcard**,
depth-first with backtracking. A tie is `X_ROUTE_CONFLICT` at startup, never a coin
flip. `HEAD` falls back to the `GET` route. `meta.auth` is **required** — a route
cannot forget to declare its auth posture.

```ts
import { httpServer, defineHttpConfig, jsonResponse } from '@ultimat3/http';

const handle = httpServer({
  routes: [{ method: 'GET', path: '/posts/:id', meta: { name: 'posts.show', auth: 'public' },
             handler: (req) => jsonResponse({ id: req.param('id') }) }],
  config: defineHttpConfig({ port: 3000 }),
  role: 'web',
}).start();
```

Static paths are registered in Bun's native `routes` table (keyed `encodeURI`'d: `Bun.serve`
refuses a non-ASCII key); param/wildcard paths, and any other spelling of a static one, fall
through to `fetch`. Method resolution stays ours so a 405 still carries problem+json.

`As of 2026-10-02`: a literal segment matches its percent-encoded request spelling, either hex
case (`/precios-espa%C3%B1a` reaches `/precios-españa`), and a wildcard matches an empty rest —
`/docs` and `/docs/` reach `/docs/*path` with `path: ''`, after a static `/docs` route if one is
declared. A malformed escape is still `X_PATH_INVALID` or a 404, never a thrown `URIError`.

### No WebSocket upgrade on the `web` role, and no hand-written `api/` route

`As of 2026-09-05`, and stated because an app went looking for both. The `web` role's
`Bun.serve` is built with no `websocket` handler (`server.ts`: "the `web` role does not use one"),
so nothing under `/api` can `server.upgrade()` a request; and `/api/*` is a **projection** —
`apiRoutes()` in `@ultimat3/cli` mounts every `action` and `query` the registries hold, and
`x g route --surface api` does not exist (`readSurface` refuses `api` by name). A raw socket is
not an action, so it has no home on this role.

The framework's one WebSocket is the `sync` role's (`@ultimat3/realtime/server`, `PORT + 1`),
authenticated by `SyncAuthenticator` and reached from the browser through `LiveClient`. A
bidirectional stream — a PTY, a log tail — is written as **two halves that already exist**:

| Direction | Primitive | Why |
|---|---|---|
| server → browser | a `channel` topic on the sync socket (`ChannelHub`, `topic(...)`, `client.subscribe(topic, …)`) | ordered frames, reconnect and backpressure are the sync node's, not a second socket's |
| browser → server | an `action` — one call per keystroke batch | it gets a policy, a schema, rate limiting, audit and the typed client for free; a socket message gets none |

A `web`-role upgrade hook was refused rather than half-built: the pipeline returns a `Response` at
every stage (middleware, finalize, security headers), and an upgraded request must return
`undefined` from `fetch` — a second exit from the pipeline with none of its guarantees. If the two
halves above cannot carry a case, the fallback is a long-poll `action` (`GET`-shaped, returning
`{ frames, cursor }` and re-called on return), which is what the app that asked shipped.

A client that is **not a browser** (a device agent) is the one exception, and it is declared, not
hand-written: `deviceSocket()` from `@ultimat3/realtime/server` ([Realtime](../../wiki/Realtime.md#device-sockets)).
Several mounts on one listener — the sync node's beside a device socket's — are joined by
`joinWebSocketMounts(mounts)`: routed by path at the upgrade, and each socket's events back to the
mount that upgraded it, keyed by the `data` object it upgraded with (`As of 2026-11-06`).

### A second door: `bearerMount` (`/v1/*`)

`As of 22.6.0`. `bearerMount({ prefix, routes, scopes, resolveToken, rateLimit?, rateLimitStore? })`
re-serves routes the app already projects under a prefix — same handler, same policy — and changes
exactly three things. Apps declare it through `defineApi({ http: { mounts } })` (`@ultimat3/action`);
`@ultimat3/cli` builds it in both boots over `apiRoutes()`.

| On the mount | Answer |
|---|---|
| credential | `Authorization: Bearer` ONLY — `meta.authenticate` replaces the app's authenticator, so a session cookie authenticates nothing here (and a bearer call needs no CSRF proof) |
| no / unresolved token | 401, `WWW-Authenticate: Bearer` / `Bearer error="invalid_token"` |
| a primitive outside the token's `scopes` | 404 `X_ROUTE_NOT_FOUND`, identical to an unknown path — MCP's hidden-tool rule |
| per-token allowance | `RateLimit-Limit/-Remaining/-Reset` on every answer, 429 + `Retry-After` past it; keyed by a SHA-256 of the token |
| paths | `/api/<x>` → `<prefix>/<x>`, `/_x/query/<x>` → `GET <prefix>/<x>` (`mountedPath`); a pinned `:param` template keeps its params — `/orders/:id/refund` → `<prefix>/orders/:id/refund`. Only the prefix is parameter-free |
| `rateLimit` declared | spent once per request in the mount's authenticator, before `body` and `authz`, so a 422 or a 403 pays too; it REPLACES `default` on the mount's routes (`rateLimitedBy: 'handler'`); a route's own `meta.rateLimit` and the tenant allowance still apply. Not declared: `default` stands |
| `Link: rel="successor-version"` | the mounted path when the successor is in the cut and this token holds its scope, success or refusal; otherwise removed. Any other `Link` is the handler's |

`RouteMeta.authenticate` is the mechanism: a route that states one is reached only through it.

For API keys, `resolveToken` is `@ultimat3/auth`'s `apiKeyResolver(() => store)` — a live key is
`{ actor, scopes }`, every wrong one is the same `null`, and a store fault stays a throw.

`resolveToken(token, facts)` (`As of 2026-10`): `facts` is `RequestFacts` — `{ address, userAgent,
origin, path }`, frozen, built by `requestFacts()`. `address` is `ctx.ip`, the pipeline's
trusted-hop answer, never a forwarding header. `@ultimat3/mcp` hands its resolver the same object
(`McpRequestFacts`), so one resolver can bind a token to a network or refuse a browser `Origin` on
both doors. A one-argument resolver still works.

## Inbound webhooks

`verifyWebhookSignature(request, { secret })` is the receiving half of the framework's webhook
mechanism. It is a plain function and not a pipeline stage, because the secret is **per sender**
and only the route knows which one applies.

```ts
// The check alone. Mounted, it is the `verify` of a `webhookReceiver()` from @ultimat3/jobs —
// verify(inbound) { return verifyWebhookSignature(inbound.request(), { secret }) } — which
// queues durably before it acks; a hand-mounted route like this one acks before anything is kept.
import { verifyWebhookSignature } from '@ultimat3/http';

declare const env: { readonly PARTNER_WEBHOOK_SECRET: string };   // the app's defineEnv() result
// The seen-set and the dispatch are the app's — this package has nowhere to keep either.
declare function alreadyHandled(eventId: string): Promise<boolean>;
declare function handle(topic: string, payload: unknown, eventId: string): Promise<void>;

export async function POST(request: Request): Promise<Response> {
  const { eventId, topic, body } = await verifyWebhookSignature(request, {
    secret: env.PARTNER_WEBHOOK_SECRET,
  });
  // Parse the bytes that were SIGNED. Never `request.json()` — the stream is spent, and a
  // re-serialisation would not be the bytes the mac covers.
  const payload: unknown = JSON.parse(body);
  if (await alreadyHandled(eventId)) return new Response(null, { status: 200 });
  await handle(topic, payload, eventId);
  return new Response(null, { status: 202 });
}
```

| Property | How |
|---|---|
| constant time | the mac is compared with `@ultimat3/core`'s `timingSafeEqual`, never `===` — where two macs first differ is exactly what a timing oracle forges one byte at a time |
| a replay expires | the signature's timestamp is checked against `toleranceMs` (5 minutes by default), **both** directions — a sender whose clock runs ahead is the same window pointed the other way |
| a replay is detectable | `eventId` is signed and returned, so it cannot be moved in transit; the seen-set is your table, because the framework has nowhere to keep one |
| moving the timestamp breaks it | the timestamp is inside the canonical string, so editing `t=` on a captured request invalidates the mac |
| the raw bytes are what is verified | the body is read through core's counting reader — the same one `UltimateRequest` uses — so a sender that declares no length cannot make this handler hold an unbounded payload |
| no secret is refused, never verified against | an empty or non-string `secret` (an unset `process.env.X`) throws `X_CONFIG_INVALID` before the request is read — a mac under an empty key is one anyone can compute. Only empty is refused, not short: the sender signs with any non-empty secret |
| the mac is checked BEFORE the window | `X_WEBHOOK_SIGNATURE_STALE` means *authentic and old*, never *unreadable and old*, so an operator reading it goes to a clock or a replay |

`X_WEBHOOK_SIGNATURE_INVALID` and `X_WEBHOOK_SIGNATURE_STALE` are both **401**: the request is
well formed and carried a credential, and the credential is what failed. Neither triggers the
sign-in redirect, which keys on `X_UNAUTHENTICATED` alone.

The sending half is `webhook()` in `@ultimat3/jobs`. Neither package may import the other, so the
wire format — the canonical string, `WEBHOOK_ID_HEADER`, `WEBHOOK_SIGNATURE_HEADER`,
`WEBHOOK_TOPIC_HEADER`, `WEBHOOK_SIGNATURE_VERSION` — is `@ultimat3/core`'s
(`webhook-signature.ts`), and a receiver imports the names from there: 25.0.0 dropped this
package's re-exports of them, and of `escapeHtml` and `readCookie` (`X_HELPER_COPY`).

### A vendor's hmac: `verifyBodyHmac`

Every other sender signs its own way, so no vendor verifier ships. `verifyBodyHmac` is the one
shared step: HMAC-SHA256 under a UTF-8 secret over the bytes you name, compared in constant time,
under any secret of a rotation list. Which bytes (`body`, `${t}.${body}`) and which header are the
vendor's, and yours to pass. A secret the vendor hands out encoded (Svix's base64 `whsec_`) is not
this helper's: the mail receivers decode their own. It answers `{ bytes, text }` — read the event
id from `text`, never from an unsigned header.

```ts
import { verifyBodyHmac } from '@ultimat3/http';

declare const bytes: Uint8Array;            // the exact body — `webhookReceiver`'s inbound.bytes
declare const headers: Headers;

const { text } = verifyBodyHmac({
  bytes,
  secret: [Bun.env['VENDOR_SECRET'] ?? '', Bun.env['VENDOR_SECRET_PREVIOUS'] ?? ''],
  given: headers.get('x-hub-signature-256'),
  encoding: 'hex',                          // or 'base64'
  prefix: 'sha256=',                        // compared, never stripped
});
```

| Answer | When |
|---|---|
| `{ bytes, text }` | one secret's mac, behind `prefix`, equals `given`; `text` is `null` when the bytes are not UTF-8 |
| `X_WEBHOOK_SIGNATURE_INVALID` (401) | no signature, or none matches. The cause names the encoding, the prefix and the secret count — never a mac, a secret or a byte |
| `X_CONFIG_INVALID` | an empty or unset secret, an empty list, or one empty entry in it |

## The exact body bytes

`As of 2026-09-24`. `UltimateRequest#bodyBytes()` returns the body exactly as it was sent,
whatever its content type. It is size-capped (`bodyLimitBytes`), read once and cached, and it is
the same byte array that `bodyRaw()` parses. An action handler receives a `Ctx` and not the
request, so it calls `useRequestBodyBytes()` to read the request in scope:

```ts
import { action, t } from '@ultimat3/action';
import { useRequestBodyBytes, useRequestHeader } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';

// The app's own check: SNS signs a canonical string of fields, a gateway signs the bytes.
declare function verifySender(bytes: Uint8Array, header: string | null, body: string): Promise<void>;

export const ingestSesEvent = action({
  input: t.string.max(600_000),           // SNS posts text/plain: the decoded body
  output: t.object({ ok: t.boolean }),
  policy: allow('public'),                // the signature below authenticates the sender
  async handle({ input }) {
    const bytes = await useRequestBodyBytes();   // what the sender signed, byte for byte
    await verifySender(bytes, useRequestHeader('x-signature'), input);
    return { ok: true };
  },
});
```

| | |
|---|---|
| why not the decoded string | a decode can rewrite a BOM or an invalid UTF-8 byte, and the signature then fails with no visible cause |
| one reader | `bodyRaw()` and `bodyBytes()` share one capped read, so an action that reads both reads the stream once |
| off HTTP | `X_NO_REQUEST`: a job or an MCP call has no body bytes |

## Serving a stored object

`As of 2026-11-02`. `objectResponse(request, { object, open }, { cache?, headers? })` is the one
correct answer to a GET for bytes held elsewhere: `/_storage`, `/media`, a query's download, and your
own route for an object a stranger may fetch.

| Argument | Is |
|---|---|
| `request` | anything with `header(name)` |
| `object` | `{ contentType, size, etag?, lastModified? }`. Structural: this package imports no storage, and a `StorageObject` fits. No etag (or `''`): no `etag` header, no 304 |
| `open(range?)` | exactly those bytes as a `BodyInit`, or a promise of them. A 304 and a 416 open nothing |
| `cache` | a `CacheHint` applied to every status. Omitted, the route's `meta.cache` decides |
| `headers` | replaces the stored-object rule (`attachment` + `sandbox` for any type but a raster image, audio or video), for a caller with its own |

A failing `if-range` (another etag, a weak one, a date that is not exact) ignores the range and
answers the whole object, so no window of an older revision is spliced onto this one.

`notModified(request, etag, headers?)` is the 304 alone, or `undefined`, for bytes not yet in hand: a
route that would have to decode to answer asks it first. `*`, a weak validator and a comma list all
count.

## Setting a cookie

`As of 2026-10-06`. A route handler, a page `load()` or an action cannot hand the pipeline a
`Response` of its own, so it calls `setCookie` on the request in scope. The line is
`@ultimat3/core`'s `serializeSetCookie` — the one serializer — appended to the context's response
headers, which the `response` stage appends to whatever is sent.

```ts
import { action, t } from '@ultimat3/action';
import { deleteCookie, setCookie } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';

export const choosePreferences = action({
  input: t.object({ theme: t.string.max(16), reset: t.boolean }),
  output: t.object({ ok: t.boolean }),
  policy: allow('public'),
  handle({ input }) {
    if (input.reset) deleteCookie('theme', { path: '/' });
    else setCookie('theme', input.theme, { httpOnly: false, maxAge: 60 * 60 * 24 * 365 });
    return { ok: true };
  },
});
```

| | |
|---|---|
| defaults | `Path=/; HttpOnly; Secure; SameSite=Lax` — core's; every option is `SetCookieOptions` |
| two calls | two `Set-Cookie` lines, in call order. The same name on two paths is two cookies; nothing overwrites |
| clearing | **`deleteCookie(name, { path, domain })` is the one way**: empty value, `Max-Age=0`, the `Path`/`Domain` (and `Partitioned`) the cookie was set with. `setCookie` with `maxAge: 0`, or an `expires` at or before `ctx.now()`, is `X_COOKIE_INVALID` naming `deleteCookie` |
| an invalid cookie | `X_COOKIE_INVALID` (core) before anything is appended: a non-token name, `__Host-` without `Secure`, a pair over 4096 octets |
| off HTTP | `X_NO_REQUEST` in a job, a task or an impersonated child context; `X_NO_CONTEXT` outside any |
| by hand | refused: `bun run set-cookie-literals` fails the build on a `Set-Cookie` attribute spelled in a literal anywhere but `packages/core/src/cookie.ts` (`X_SET_COOKIE_HAND_BUILT`) |

## Rendering a shared document

`withAnonymousRequest(ctx, url, (scope) => …)`: run as this request with nobody behind it. What
`@ultimat3/cli` renders `isr` and `static` in, so a stored document holds no visitor's answer.

| | |
|---|---|
| the actor | anonymous, with registered services rebuilt for it |
| the inbound headers | none: no header is in a stored page's key, and `accept-language` is already `ctx.locale` |
| `url` | the one handed in: the document's address, already narrowed to its key |
| `tz` | the app's default; `locale` stays, because it is in the key |
| `ip`, `peer`, `clientBuildId`, `authz`, `rateLimit`, `readBody` | empty |
| a redirect | `setRedirect()` lands on `scope`: read it with `takeRedirect(scope)` |
| the response headers | `scope.headers` is `ctx.headers` |
| the outer `ctx` | unchanged: the pipeline still answers the identified request privately |

## Errors

`X_ROUTE_NOT_FOUND` · `X_METHOD_NOT_ALLOWED` · `X_BODY_INVALID` · `X_UNAUTHENTICATED`
· `X_FORBIDDEN` · `X_RATE_LIMITED` · `X_BUILD_SKEW` · `X_ROUTE_CONFLICT`
· `X_CORS_CONFIG_INVALID` · `X_RATE_LIMIT_NOT_SHARED` · `X_WEBHOOK_SIGNATURE_INVALID`
· `X_WEBHOOK_SIGNATURE_STALE`

One `factsOf()` feeds three renderings — terminal, `application/problem+json`, dev
overlay — so the `code`/`cause`/`fix` strings can never diverge.

Which of them a caller gets is one sniff, `acceptsHtml(request)` — an `Accept` naming
`text/html`. Exported so a projection answering a browser differently (an action's `native`
form answer) asks the same question the error page does, never a copy of it.

Every problem document carries `retry` (`terminal`, `retryable` or `retry-after`, core's
`errorRetry`) at its root, a 401 and a scope 404 included. A hidden 5xx answers the class and
nothing else about the failure. It is what a client maps to an exception, so no app carries a
middleware to add it.

A problem document's `type` and `docs` answer different questions and are two different
values. `type` is `problemTypeFor(code)` — `urn:ultimate:error:X_BODY_INVALID`, the RFC-9457
identifier a client switches on, per code, with no host to resolve or rot. `docs` is
`@ultimat3/core`'s `ERROR_DOCS_URL`, one wiki page for every code, because a code lives there
in a table row and a table row has no anchor. Assert against `problemTypeFor` and
`ERROR_DOCS_URL`, never against a copy of either string.

An error's `meta` is **operator-only by default** and the document never carries it: that bag is
where `bodyInvalid` keeps the excerpt the parser choked on, where the limiter keeps the internal
key it promoted an anonymous caller to, and where core's `assert` keeps the rejected value. An app
that wants a key on the wire declares it, per code, beside the status — and both declarations
are needed, because a code with no status is an unclassified 5xx whose `meta` is blanked with
its `cause`:

```ts
import { registerErrorStatus, registerProblemMeta } from '@ultimat3/http';

registerErrorStatus({ X_SESSION_CHECKOUT_BUSY: 409 });
registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: ['sessionId', 'title', 'state'] });
// A 5xx whose cause is written for the caller, and may be shown in production:
registerProblemMeta({ X_BILLING_DOWN: { publicCause: true } });
// Both at once: { keys: ['sessionId'], publicCause: true }
```

The document then carries `meta: { sessionId, title, state }` — the declared keys that are set,
copied member by member (`__proto__` skipped at every depth), and nothing else off the error. It
is all-or-nothing, as `issues` is: one value JSON cannot carry (a `Date`, a `bigint`, a class
instance, a cycle) or a serialisation past `MAX_PROBLEM_META_BYTES` (4096) drops the whole member,
because a document missing one declared key is a claim the server never made. Absent when no
declared key is set — never `{}`. A framework-owned code is refused (`X_PROBLEM_META_INVALID`),
as is `issues`, which has its own top-level home. `@ultimat3/action`'s typed client puts the
member back on the rebuilt error's `meta`, so an island reads `error.meta.sessionId` where it
used to run a regex over `cause`.

A framework code's public keys are not an app's call: they are one reviewed table,
`problem-meta-framework.ts`, held by its test to a 4xx code and keys an app's declaration could
carry, none secret-shaped. One row, `As of 2026-11`: `X_METER_EXCEEDED` carries
`meta: { meter, limit, resetsAt }` (its delay is the `Retry-After` header).

### Error classes

Every error class `src/index.ts` exports, for `instanceof` inside one process. Across a wire or
a job boundary the class is gone and the `code` is what survives — match on that.

| Class | Code | Declared in |
|---|---|---|
| `HttpError` | any `HttpErrorCode` — `HTTP_ERROR_CODES` | `src/errors.ts` |

## Boundaries

Tier 2. Imports `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/i18n`, `@ultimat3/time` and
`@ultimat3/db` — tiers 0 and 1, which is the whole rule. `db` for one value: `RATE_LIMIT_STORAGE`,
the `x_rate_limit` table's storage declaration (`tableStorage`), rendered into its DDL and compared
by drift. Authentication and policy evaluation arrive through
`ServerHooks`, declared structurally, because `@ultimat3/policy` is a sibling tier. There is no
plugin API: `Middleware` wraps a handler, the pipeline is everything else.

`hooks.explainMiss(method, pathname)` is the same kind of seam for a request the router matched
nothing for: the error it returns is thrown in place of `X_ROUTE_NOT_FOUND`, `undefined` keeps the
plain miss. Synchronous, given only the request line, never asked about a matched route or a 405.
`@ultimat3/action` answers it for a path that is one of its actions under a `pathStyle` this server
does not serve (`X_CONTRACT_DRIFT`, 404).

## Supporting exports

`As of 2026-11-02`.

Types of `objectResponse`.

| Name | What |
|---|---|
| `ServableObject` | what the answer needs before it opens anything. `StorageObject` is one |
| `ObjectSource` | `{ object, open }`: `open(range?)` returns the body |
| `ObjectRequest` | the one thing asked of the request, `header(name)`, so a test needs no `Request` |
| `ObjectResponseOptions` | `cache` and `headers`. `cache` omitted, the route's declared `meta.cache` decides |
