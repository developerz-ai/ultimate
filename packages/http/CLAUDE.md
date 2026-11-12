# @ultimat3/http

Owned request lifecycle over `Bun.serve`. Tier 2.

## Boundary

- May import: `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/i18n`, `@ultimat3/time`, `@ultimat3/db`
  (`tableStorage` only) — tiers 0 and 1. Locale and zone negotiation are i18n's and time's, never re-implemented here.
- May NOT import `@ultimat3/policy` or `@ultimat3/entity` — same tier. Authz and auth come in via
  `ServerHooks` (`hooks.ts`), declared structurally. `@ultimat3/action` (tier 3) wires policy into
  `hooks.authorize`.

## Rules — configuration

- **Every numeric knob `defineHttpConfig` resolves is screened** (`port`, `bodyLimitBytes`, `requestTimeoutMs`, `maxInflight`, `trustedProxyHops`) → `X_CONFIG_INVALID` (borrowed). Full rule: `docs/history/http.md`.
- **`MAX_PROXY_HOPS` is exported** — `@ultimat3/cli`'s `trustedHopsFromEnv` imports it; one ceiling.
- Route `meta.auth` is required. Never default a route to public.
- **An app declares its half of `HttpConfig` through `configureHttp()`**, and the boot lays its own
  facts over it. `AppHttpConfig` is `Omit<HttpConfigInput, BootOwnedHttpKey>` — derived, so a
  boot-owned key (`port`, `hostname`, `dev`, `buildId`, `signInPath`, `trustProxy`,
  `trustedProxyHops`, `rateLimit.scope`) is a type error where an app writes it. `mergeHttpConfig`
  merges `security.csp.extend` per directive. `type-pins.ts` refuses a key on `HttpConfig` missing
  from `HttpConfigInput`.
- **No drain deadline here**: `drain.deadlineMs` is the one budget (core, per role); the deleted
  key and `ServerOptions.drain`: `docs/history/http.md#no-drain-deadline`.
- **`X_CORS_CONFIG_INVALID`: `cors.origins: ['*']` with `credentials: true`, `'null'`, or any entry
  but `'*'` whose `URL.origin` is not itself** (fix names the canonical form). A refused origin still gets `vary: origin`.
- **`DEFAULT_CORS` is what `clientTransport` sends and reads**, off core's constants; `cors.test.ts` observes the transport's real traffic, so a new header fails it. `date` alone stays hidden: this server writes delta-seconds. An app's list replaces the default whole.
- **A `security.csp.extend` entry must emit only the directive it names**
  (`X_CSP_DIRECTIVE_INVALID`); `buildCsp` builds through a `Map`.
- **The security headers are built once per `(SecurityConfig, https)`** (`responseSecurityHeaders`, a
  `WeakMap`); a config is never mutated after `defineHttpConfig`. HSTS only when `ctx.https` is affirmed.
- **A `content-security-policy` the handler set is kept**: the `response` stage APPENDS the app's
  policy beside it (two policies, both enforced), so a handler can narrow — `sandbox` on a served
  upload — and never widen. Every other security header is set over the handler's (`stages-csp.test.ts`).

## Rules — the context

- **`asCtx` is a WIDENING the compiler checks, never a cast** (`RequestContext extends Ctx`;
  `_RequestContextIsACtx` in `type-pins.ts`). `ctx.buildId` is the process's build;
  `ctx.clientBuildId` is the client's claim, read only by `assertBuild()`.
- **`requestContext` COMPOSES `ctxOf()`** — no assertion in this file, and
  `defineService` factories and the service spread are core's. Services go on FIRST so a service
  named `actor` loses to the request's field (`context.test.ts`).
- **A request's registered services are LAZY and bound to the authenticated actor**
  (`request-services.ts`, `installServices: false` + `bindRequestServices`): built on first read,
  rebuilt only if actor, locale or tz changed. `request-services.test.ts`.
- **A shared document renders in `withAnonymousRequest(ctx, url, fn)`**. Full rule: `docs/history/http.md`.
- **A member's saved locale and zone apply, re-resolved after `auth`**
  (`resolvePreferences`; cookie beats a saved locale, a saved zone beats the cookie).
  `member-preferences.test.ts`.
- **The `locale` stage decides WHERE, the owners decide WHAT**: raw strings to `@ultimat3/i18n`'s
  `resolveLocale` and `@ultimat3/time`'s `resolveTimeZone`, landing on core's `ctx.locale`/`ctx.tz`.
  Defaults are `configureTime({ defaultZone })` / `defineCatalogs({ default })`, never `HttpConfig`.
- **`ctx.actor` is never null** — the `auth` stage turns the hook's `null` into `anonymousActor()`.
- **The context carries the inbound headers, never the `Request`** (`ctx.requestHeaders`,
  `useRequestHeader` / `useRequestCookie`).
- **`hooks.authenticate` has one declaration site: `configureAuthenticator()`.** A route may
  REPLACE it with `meta.authenticate` (never run beside it): `bearerMount` sets it so a session
  cookie authenticates nothing on `/v1/*`.
- **`bearerMount` re-serves existing `Route`s, never re-projects them** (`bearer-mount.ts`): the cut is decided in the `auth` stage (outside it: `X_ROUTE_NOT_FOUND`); the token allowance is spent once, in the authenticator; a declared `rateLimit` REPLACES `default`, a route's own and the tenant allowance stay; a successor `Link` is rewritten or removed (`bearer-mount-wire.test.ts`). Full rule: `docs/history/http.md`.
- **`hooks.devNotices` is called only inside the `config.dev && wantsOverlay` branch.**
- **A dev 4xx asks `hooks.errorPage` first; a 5xx is always the overlay** (#492): the app's file
  when it has one, else the overlay. Production asks for every status (`stages-error-page.test.ts`).

## Rules — the pipeline

- **The lifecycle is three files**: `pipeline.ts` owns the ORDER (`PIPELINE_STAGES`, phases, loop,
  ALS, span, the one metrics call); `stages.ts` owns what each stage does and the vocabulary;
  `finalize.ts` owns the tail. Imports go `pipeline.ts` → `stages.ts`; a stage reads
  `StageRunnersInput`, never `PipelineDeps`. A new stage is an entry in both `PIPELINE_STAGES` and the
  `Record<StageName, StageRun>` table, with a `why` and a test.
- **The request span is named by the route PATTERN** (`GET /r/:token`, `routeSpanName`), renamed
  on match; `http.route` is the pattern or `unmatched`. A concrete URL (tokens,
  attacker-chosen) is never a span name, attribute or label — no `url.path`. Keys: core's
  `SEMCONV`; the id is `ultimate.request_id`. **`http.request` is emitted once, in the same
  `finally`**, after `deadline.clear()` (`pipeline-telemetry.test.ts`).
- **The CSP `connect-src` is `'self' blob:`** — no bare `ws:`/`wss:`. A cross-origin sync node is
  the boot's `csp.extend` of that origin exactly. `security.hsts` merges key by key.
- **The two inbound ids are read BEFORE the context and the span** (`correlation.ts`, core's
  `parseTraceparent`). `x-request-id` is gated on `trustProxy`; `traceparent` deliberately is not.
- **Every proxy-supplied header goes through `forwardedElement(header, hops)`**, the entry at `entries.length - hops`, never `[0]`, except `x-forwarded-proto` (`forwardedProto`). `ctx.peer` is `null` unless trusted AND `trustClientCertHeader` is declared, and is never an actor. Full rule: `docs/history/http.md`.
- **One deadline per request** (`deadline.ts`): `requestTimeoutMs` (30 s, `0` off; Bun's `idleTimeout` derives from it, `idle-timeout.ts`), shortened by `x-request-timeout-ms`, never lengthened. Full rule: `docs/history/http.md`.
- **`admit` is the second stage and refuses before ANY work**: past `maxInflight` (1000) is
  `X_OVERLOADED` with `retry-after`, counted by core's `inflightCount()`. **A DRAINING process
  serves** with `connection: close`; only `lifecycleState() === 'stopped'` answers `X_DRAINING`
  (`pipeline-hardening.test.ts`).
- **`csrf` sits after `auth` and before `body`**: an unsafe request needs
  `sec-fetch-site: same-origin`, an `Origin` equal to this app (from `ctx.https`), or one EXACTLY in
  `cors.origins` (`originListed`, never `allowedOrigin`); else `X_CSRF_BLOCKED` (403). No
  `mode: 'token'`. **Anonymous is not an exemption** (login CSRF): exempt are `Authorization:
  Bearer` (cached Basic is ambient), and an anonymous request with NEITHER `Origin` nor `sec-fetch-site` (not a browser).
  **`meta.csrf: 'cookieless'`** (`/oauth/*`) exempts an ANONYMOUS caller only; `httpRouter`
  refuses it without `meta.authenticate` (`assertRouteCsrf`).
- **`meta.enforcedBy` says who evaluates `meta.policy`**: `'pipeline'` (default) decides via
  `hooks.authorize`; `'handler'` stands the `authz` stage down.
- **A 403's `fix:` names the POLICY** (`route.meta.policy`), degrading to `x routes --json` for a
  composite.
- **`maxRequestBodyBytes` (128 MiB, ≥ `bodyLimitBytes`) is the transport ceiling**; Bun's is off.
  A declared length past it (`admit`) or a streamed one (`server.ts`) is `X_BODY_TOO_LARGE` (413).
- **The body cap is enforced while reading** (`UltimateRequest.#read`'s counting reader, cancelling
  past `bodyLimitBytes`); multipart goes through the same capped bytes. **Bytes with no
  `content-type` are `X_BODY_INVALID`** from `bodyRaw()`, never "no body"; `bodyBytes()` reads them.
- **A repeated field is a LIST in all three parsers** (`collectFields`).
- **`matchRoute` never throws**: `route-path.ts`'s `decodeSegment` answers `path-invalid` →
  `X_PATH_INVALID` (400).
- **`handle()` resolves to a Response or nothing**: request phases are guarded by `execute`, the tail
  by `finalize.ts` — a refusing finalize stage degrades to `X_PIPELINE_FINALIZE_FAILED` with a second
  pass; everything degraded goes THROUGH the recover stage. **Both guards are TOTAL** (`String(x)`
  and bare property reads on a caught value are forbidden; `factsOf` uses core's `stringField`), and
  **`recoverWith`'s fallback is INSIDE its `try`** (a literal `X_INTERNAL` document, logged
  `pipeline.problem_failed`).
- **`toBucket` lives here** (action and query both need it). **`ERROR_STATUS`'s keys are LITERAL**
  (`satisfies`, pinned by `@ts-expect-error` in `error-map.test.ts`); non-literal codes go through
  `statusFor()` / `BY_CODE` with `Object.hasOwn`. A table keyed by a caller's code is read with
  `Object.hasOwn`, or is a `Map` (`APP_ERROR_STATUS`).
- **The `cache-headers` stage is the ONE owner of the final cache answer**: `offersSharedCache` turns a
  shared answer for an identified request into `PRIVATE_CACHE` and gives an anonymous one
  `SHARED_CACHE_VARY` (`accept-language, cookie`); `immutable` is left alone. `vary` is added, never
  set (`addVary`). An offer is `public`, `s-maxage`, or any `max-age` / `must-revalidate` /
  `proxy-revalidate` without `private`/`no-store` (RFC 9111 §3).
- **`Set-Cookie` is appended by the `response` stage, every other context header is `set`** —
  it is the one header that is a list of lines (`pipeline-cookies.test.ts`). App code writes one
  only via `setCookie`/`deleteCookie` (core's serializer; `bun run set-cookie-literals`).
- **A redirect the framework writes stays on this origin**: the default-locale redirect goes
  through `normalizePath`; `locationFor` hands over `http:`/`https:` only, else the requested path.
- **A `cache-control` age is delta-seconds or DROPPED** (`finiteDeltaSeconds`, total, always the
  shorter direction; logs `http.cache_hint_not_delta_seconds`). Its boot half is `route-cache.ts`:
  `httpRouter` refuses a bad `Route.cache` with `X_CONFIG_INVALID`. Both accept the same set; zero
  is legal. `ctx.cache` is not screened.
- **A handler's own `Response.status` is never rewritten** (`pipeline-handler-status.test.ts`).
- Health endpoints answer outside the pipeline, so their body is a stranger's: `{ state, ready,
  role }` unless the peer is in `healthDetailPeers` (default `['loopback']`; socket AND trusted
  forwarded caller must both be listed — `health-disclosure.ts`). **Lifecycle belongs to core** (`beginWork()`,
  `markReady()`, `drain()`, the payloads) — never a private state or in-flight counter.
- **`stop()` hands its two hooks back ABOVE its early return** (`packages/http/e2e/server.e2e.test.ts`
  reads `shutdownHookCount()`).
- **`compress` is the last stage and has no option** (`compress.ts`, `compress-read.ts`): `zstd` then `gzip` by weight; a 304's validator is its 200's (`etag-form.ts`); `private`/`no-store`/`no-cache`/`no-transform` is identity (BREACH); a refused response is the SAME object. An `immutable` asset is coded ONCE in the background at br 11 / zstd 19 / gzip 9 (`compress-precode.ts`, 2 keys at a time; a coder that throws is logged, never unhandled), and later hits are lookups. Full rule: `docs/history/http.md`.

## Rules — errors and the problem document

- Statuses live in `error-map.ts` only; the framework table is closed. The app's half lives in core
  (`error-status-declared.ts`, `@ultimat3/core/internal/error-status`): an app's own code declares
  its status with core's `defineError`; `registerErrorStatus()` keeps its refusals (a framework code)
  and writes there, for codes an app re-raises but does not declare. No projection of the app's half.
  **`error-facts.ts` renders the throwable**; the seam is `declaredStatusFor(code)`, imports one way.
- **A problem's `type` is `problemTypeFor(code)` = `urn:ultimate:error:<CODE>`; its `docs` is core's
  `ERROR_DOCS_URL`.** `finalize.ts`'s `lastResort` literal is pinned against `problemTypeFor('X_INTERNAL')`.
- **A 5xx cause is withheld unless its code opts in** (`hasPublicCause`, `problem-meta.ts`;
  `registerProblemMeta({ CODE: { publicCause: true } })`). `toProblem(error, { dev })` defaults `dev`
  to false. An unclassified 5xx carries nothing off the throwable. **A hidden cause hides the `fix`
  too**: `callerFix`, else `x errors explain <CODE> --json` — never `facts.fix` outside dev.
- **The document carries the ISSUE LIST** (`issues`): `issuesOf` is total, all-or-nothing,
  absent when none, past 100 or opaque; `received` is `''`. `issuesTruncated: true` rides only
  with a carried list and `meta.issuesTruncated === true`. Both are reserved meta keys.
- **`meta` reaches the document only by declaration** (`registerProblemMeta({ CODE: [keys] })`, app
  codes only; not `issues`, not `__proto__`): `wireMeta` copies declared keys through
  `Object.defineProperty`, bounded by `MAX_PROBLEM_META_BYTES`, dropped when opaque.
- **A rejected value is a log FIELD, never the message** — the `error-map` line's message is the code alone.
- **A rejected BODY names only what the framework chose**: `bodyInvalid`'s `issues` are a fixed
  vocabulary; what the caller sent rides in `meta`; the parser's message goes through `renderThrowable`.
- **A browser failing `auth: 'required'` is redirected; an agent gets the problem document** (`auth-redirect.ts`, in `error-map` before the overlay), in the routed locale. Full rule: `docs/history/http.md`.
- **A pathname in a `fix:` goes through `renderFixShellArg`** (`routeNotFound`). **A `code` is gated by
  core's `FRAMEWORK_CODE`** before `x errors explain <code>`, else `x errors list --json`. **A supplied
  `fix:` is taken only from a branded error** (`isUltimateError`).
- **Borrowed codes are never titled or registered here** (`HTTP_BORROWED_ERROR_CODES`: `X_FORBIDDEN`,
  `X_UNAUTHENTICATED`, …); `factsOf` reads a borrowed code's title off the error.
- Never throw a bare `Error` — use a factory from `errors.ts`. No `any`. Validation goes through
  Standard Schema (`validate.ts`).
- **Every document carries `retry` at its root** (core's `errorRetry`, through the total `retryOf`); a hidden 5xx answers the class and no cause. `finalize.ts`'s `lastResort` literal is pinned against `toProblem`'s answer for `X_INTERNAL`.

## Rules — rate limiting

Full rules and their reasons: [`docs/history/http-rate-limit.md`](../../docs/history/http-rate-limit.md).

- **An address key is core's `addressNetwork(ip)`** (IPv6 `/64`). **One request spends a LIST of
  keys** (caller's, then `tenant|org:<id>` when declared); stop at the first refusal.
- **The memory store is bounded** (`DEFAULT_MAX_RATE_LIMIT_KEYS`, evicts closest-to-FULL first).
- **The scope is DECLARED, with no default** (`X_RATE_LIMIT_SCOPE_UNSET`); `'shared'` over a
  per-process store is `X_RATE_LIMIT_NOT_SHARED`, checked in `httpPipeline`.
- **ONE store slot** (`rate-limit-installed.ts`): routes AND primitives count in
  `installedRateLimitStore()`; a server reads it PER REQUEST (`liveRateLimitStore`). Installer and
  reset are on `@ultimat3/http/adapter` only (`adapter.test.ts`); an app names `rateLimitStore` in
  `apps/<app>/runtime.ts`. `httpServer` takes no store (v31).
- **A bucket a route names must be registered** (`withRouteBuckets`, `X_RATE_LIMIT_BUCKET_CONFLICT`)
  and held by the limiter (`assertRouteBuckets`, `X_RATE_LIMIT_BUCKET_UNBOUND`).
- Shared stores: `postgresRateLimitStore({ executor })` (`x_rate_limit` unlogged: a crash refills every bucket), `redisRateLimitStore({ client })`.

## Rules — webhooks and tests

- **`verifyWebhookSignature` is a FUNCTION, never a stage**: it reads through core's
  `readWithinLimit` and returns the raw text. The mac is checked BEFORE freshness
  (`X_WEBHOOK_SIGNATURE_STALE` means authentic and old); the window is `Math.abs`; the timestamp is
  digits-only; `:` is refused in id and topic; the comparison is `timingSafeEqual`
  (`bun run secret-compare`). **An empty `secret` is `X_CONFIG_INVALID`.**
  **The FORMAT is core's** (`packages/core/src/webhook-signature.ts`) — never re-declared here.
- **`verifyWebhookSignature` and `verifyBodyHmac` share ONE secret screen** (`assertWebhookSecrets`)
  and one pair of refusals (`webhookSecretMissing`, `webhookSignatureInvalid`), each naming its caller.
- Tests must not touch the network — the preload seals `fetch`. Socket tests live in `e2e/` (`bun test
  ./packages/http/e2e/`), sealed; `start()` calls core's `markListening()`. Never unseal.

## Files

| File | Job |
|---|---|
| `pipeline.ts` | the ORDER the stages run in — the framework's guarantee — and the one loop that drives a request through them |
| `stages.ts` | what each stage DOES, one entry per `StageName`, plus the stage vocabulary the other two import |
| `finalize.ts` | the tail of that lifecycle, guarded: a throw after the handler degrades, never rejects |
| `router.ts` | trie, static > param > wildcard; a segment decoded ONCE (static looked up raw, then decoded), `path-invalid` if it will not. A wildcard takes an EMPTY rest (`/docs` → `/docs/*path`). `route-path.ts` owns segments and `canonicalPath`: `ctx.routePath` is the match's one spelling, `requestAddress(ctx)` what render keys `isr` on |
| `navigation.ts` | the client router's server half: `context`'s gate after the match (an un-opted prefetch, or a soft GET off the router's `<app>:<surface>` → `204` [+ `x-ultimate-location`], before auth) and `response`'s rewrite of a 3xx to that hand-over, cookies kept |
| `error-map.ts` | the code → status table, closed: COMPOSES the slices and holds no row of its own |
| `error-map-http.ts`, `error-map-tier-<0-4>.ts` | the rows, one slice per owning tier. `bun run new-error-code` appends to its `--package`'s slice; a code in two is refused by `error-map.test.ts` |
| `error-facts.ts` | every RENDERING of a throwable: `factsOf()`, the problem document (including the issue list and the opacity rule over it), the three terminal lines |
| `hooks.ts` | the seams: `authenticate`, `authorize`, `devNotices`, `errorPage`, `explainMiss` (a `not-found` match only, sync; its error replaces `X_ROUTE_NOT_FOUND`) + `configureAuthenticator(fn, { credentialTtlMs })` |
| `type-pins.ts` | compile-time claims about `AuthzDecision`'s shape — source, because `tsc` never reads a `.test.ts` |
| `overlay.ts` | the dev error page: the same code/cause/fix as the terminal, plus any notices |
| `overlay-style.ts` | the overlay's one stylesheet, split out so `security-headers.ts` hashes it |
| `context.ts` | `RequestContext` (core's `Ctx` plus the request's own), composed from `ctxOf`, the single `Ctx` adapter (`asCtx`) and the inbound-header readers |
| `redirect.ts` | the intent slot a handler that cannot return a `Response` fills |
| `set-cookie.ts` | `setCookie`/`deleteCookie`: one line each onto `ctx.headers` |
| `object-response.ts` | `objectResponse`: an object held elsewhere, structural; `notModified`: the `if-none-match` answer |
| `stored-object-headers.ts` | inline only for raster images, audio, video; else `attachment` + `sandbox` (private) |
| `auth-redirect.ts` | where an unauthenticated browser goes, and where it comes back to |
| `cache-policy.ts` | the default `CacheHint` for a route that declared none — route AND actor — and the review of a declared one (`reviewedHint`) |
| `error-log-level.ts` | the `error-map` line's level: `error` 5xx, `warn` 401/403/429, `info` the rest and a `routineRefusal` |
| `route-cache.ts` | the screen a `Route.cache` hint gets where it is DECLARED, thrown from `httpRouter`; the response path's `finiteDeltaSeconds` is the total half of the same rule |
| `rate-limit.ts` | the token-bucket maths, the store interface, the memory driver |
| `adapter.ts` | `@ultimat3/http/adapter`: the store port's interface, the shipped stores' types (also on `.`, beside their factories), the driver error (adapter only), and the boot's installer |
| `rate-limit-config.ts` | the bucket table, its resolver and `toBucket` |
| `rate-limit-postgres.ts` | the SHARED store: one table, one `insert … on conflict` per take, over a structural `PgExecutor` |
| `rate-limit-redis.ts` | the other shared store: one Lua token bucket per take |
| `body-ceiling.ts` | the transport ceiling and `X_BODY_TOO_LARGE` |
| `rate-limit-errors.ts` | every refusal a rate limit produces — the 429 and the declaration faults |
| `error-titles.ts` | the owned codes, titles and `retry-after` classes, registered at import — the one `sideEffects` module. Server realm only: a browser reads title and delay off the body and `Retry-After` |
| `correlation.ts` | the inbound request id and trace, read before the context and the span exist |
| `forwarded.ts` | one hop-indexed reader for every header a trusted proxy writes |
| `peer-identity.ts` | Envoy XFCC -> `ctx.peer`, on that same trust rule |
| `deadline.ts` | the per-request `AbortController`, the timer and `X_TIMEOUT` |
| `csrf.ts` | the origin proof an unsafe method from a browser must carry, signed in or not |
| `webhook-verify.ts` | the INBOUND webhook: canonical string, constant-time mac, replay window. Outbound is `@ultimat3/jobs`' `webhook()` |
| `webhook-hmac.ts` | `verifyBodyHmac`: a vendor's HMAC-SHA256 over named bytes, UTF-8 secret, rotation list, constant-time; answers `{ bytes, text }` |
| `locale.ts` | WHERE the request's locale and zone are read from — header and cookie NAMES only. It negotiates nothing; the cookie is read by core's `readCookie`, imported, never re-exported |
| `rate-limit-buckets.ts` | the one point routes and config meet: a route's own bucket, registered or refused |
| `rate-limit-stage.ts` | what the pipeline spends and when: the `rate-limit` stage's list of keys, and the address-keyed allowance the `auth` stage spends for a failed credential |
| `health-disclosure.ts` | WHO `/healthz` and `/readyz` tell the detail to: `healthDetailPeers`, its screen, the trusted-proxy half. Body rule and peer match are core's |
| `bearer-mount.ts` | a second door onto existing routes: `Authorization: Bearer` on a prefix, the scope cut, the per-token allowance |
| `request-facts.ts` | `RequestFacts`, any token resolver's frozen 2nd arg; address = `ctx.ip` |
| `app-config.ts` | the app's own HTTP declaration (`configureHttp`) and the layering that keeps a boot fact above it |
| `compress.ts` | the `compress` stage's rule: which answers leave coded |
| `compress-precode.ts` | the immutable-asset precoder: background br/zstd/gzip once per key, `pick` by `accept-encoding` |
| `admit-stage.ts`, `lag-shed.ts` | `admit`'s refusals; lag p99 shed (`shedLagMs`, OFF in 31.x: no sampler) |
| `request-timings.ts`, `slow-request-log.ts` | a request's stage split: `Server-Timing` (dev), `http.request.slow` |
| `refusal-log.ts` | `http_refusals_total{code}`; routine refusal `info` once/route/min, then `debug` |
| `compress-read.ts` | the one body read that rule does: counted, deadline-bound, replayable |
| `request-as.ts` | `withRequestAs`: an exercise entry's `request` (cookies, headers) as an inbound request, for `x exercise` and the contract step |

## Commands

```
bun test ./packages/http/
bun run --filter @ultimat3/http typecheck
```

Why each rule above is shaped the way it is: [`docs/history/http.md`](../../docs/history/http.md).
