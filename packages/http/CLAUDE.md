# @ultimat3/http

Owned request lifecycle over `Bun.serve`. Tier 2.

## Boundary

- May import: `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/i18n`, `@ultimat3/time` — tiers 0 and
  1. Locale and zone negotiation are i18n's and time's, never re-implemented here.
- May NOT import `@ultimat3/policy` or `@ultimat3/entity` — same tier. Authz and auth come in via
  `ServerHooks` (`hooks.ts`), declared structurally. `@ultimat3/action` (tier 3) wires policy into
  `hooks.authorize`.

## Rules — configuration

- **Every numeric knob `defineHttpConfig` resolves is screened** (`port`, `bodyLimitBytes`,
  `requestTimeoutMs`, `maxInflight`, `drainTimeoutMs`, `trustedProxyHops`) → `X_CONFIG_INVALID`
  (borrowed). `requestTimeoutMs` tops out at `MAX_TIMER_MS` (2^31−1): past it a timer arms ~1 ms.
  `buildId: null` is a declaration (`=== undefined`, never `??`); `hostname` never reads `HOSTNAME`. Helpers carry `Finite` (`assertFiniteCount`, `assertFiniteKeyCap`,
  `assertFiniteBodyLimit`) so `bun run finite-bounds` sees them; `webhook-verify.ts` and
  `rate-limit.ts` screen their own. **The floor is per option**: `requestTimeoutMs: 0` and
  `maxInflight: 0` are "off"; `trustedProxyHops` floors at 1. `resolveTrustedProxyHops` owns both
  refusals (`X_TRUST_PROXY_UNSET`, `X_CONFIG_INVALID`), with no `?? 0` behind it.
- **`MAX_PROXY_HOPS` is exported** — `@ultimat3/cli`'s `trustedHopsFromEnv` imports it; one ceiling.
- Route `meta.auth` is required. Never default a route to public.
- **An app declares its half of `HttpConfig` through `configureHttp()`**, and the boot lays its own
  facts over it. `AppHttpConfig` is `Omit<HttpConfigInput, BootOwnedHttpKey>` — derived, so a
  boot-owned key (`port`, `hostname`, `dev`, `buildId`, `signInPath`, `trustProxy`,
  `trustedProxyHops`, `rateLimit.scope`) is a type error where an app writes it. `mergeHttpConfig`
  merges `security.csp.extend` per directive. `type-pins.ts` refuses a key on `HttpConfig` missing
  from `HttpConfigInput`.
- **`config.drainTimeoutMs` defaults to `null`**: `createServer` calls `configureLifecycle({
  deadlineMs })` only when declared. **`ServerOptions.drain`** (`app.config.ts`'s `drain`) passes
  `readinessGraceMs` to core the same way.
- **`cors.origins: ['*']` with `credentials: true` is `X_CORS_CONFIG_INVALID`.** A refused origin
  still gets `vary: origin`.
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
- **`createRequestContext` COMPOSES `createContext()`** — no assertion in this file, and
  `defineService` factories and the service spread are core's. Services go on FIRST so a service
  named `actor` loses to the request's field (`context.test.ts`).
- **A request's registered services are LAZY and bound to the authenticated actor**
  (`request-services.ts`, `installServices: false` + `bindRequestServices`): built on first read,
  rebuilt only if actor, locale or tz changed. `request-services.test.ts`.
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
- **`bearerMount` re-serves existing `Route`s, never re-projects them** (`bearer-mount.ts`): same
  handler, policy, idempotency; adds the credential (bearer only, `WWW-Authenticate` on 401), the
  cut (outside the token's scopes = `X_ROUTE_NOT_FOUND`, the MCP rule), and a per-token bucket
  keyed by a SHA-256 of the token. Bad prefix / unknown name / double claim:
  `X_BEARER_MOUNT_INVALID` at construction. **The cut is decided in the `auth` stage** — one
  authenticator per route, closed over its scope — so an out-of-scope token is 404 before `body`
  (422) and `authz` (403) could describe the primitive. **The prefix is opaque**: `<prefix>/*rest`
  for every method (`opaquePrefix`) answers no token / a bad token with the same 401 challenge a
  served path gives, and a valid token with the same 404 — never 404-vs-401 or a 405 naming methods.
  That 404 SPENDS the token's allowance (once; a served call is charged in the handler), so a
  token cannot walk the cut for free.
- **`hooks.devNotices` is called only inside the `config.dev && wantsOverlay` branch.**

## Rules — the pipeline

- **The lifecycle is three files**: `pipeline.ts` owns the ORDER (`PIPELINE_STAGES`, phases, loop,
  ALS, span, the one metrics call); `stages.ts` owns what each stage does and the vocabulary;
  `finalize.ts` owns the tail. Imports go `pipeline.ts` → `stages.ts`; a stage reads
  `StageRunnersInput`, never `PipelineDeps`. A new stage is an entry in both `PIPELINE_STAGES` and the
  `Record<StageName, StageRun>` table, with a `why` and a test.
- **The request span is named by the route PATTERN** (`GET /r/:token`, `routeSpanName`), started
  as the bare method and renamed after the match; `http.route` is the pattern or `unmatched`. A
  concrete URL carries tokens and is attacker-chosen — never a span name, attribute or label.
- **The CSP `connect-src` is `'self' blob:`** — no bare `ws:`/`wss:`. A cross-origin sync node is
  the boot's `csp.extend` of that origin exactly. `security.hsts` merges key by key.
- **The two inbound ids are read BEFORE the context and the span** (`correlation.ts`, core's
  `parseTraceparent`). `x-request-id` is gated on `trustProxy`; `traceparent` deliberately is not.
- **Every proxy-supplied header goes through `forwardedElement(header, hops)`** — the entry at
  `entries.length - hops`, never `[0]`; a short chain trusts nothing. **Except `x-forwarded-proto`**
  (`forwardedProto`): proxies usually OVERWRITE it, so a list shorter than `hops` reads its first
  entry (an overwrite erased the client's value; what is left a trusted hop wrote) — HSTS behind
  two hops. A full-length list is read like an address. `trustProxy` defaults to false
  and requires `trustedProxyHops`. `x-forwarded-proto` (HSTS) and Envoy XFCC (`peer-identity.ts`) ride
  it; `ctx.peer` is `null` unless trusted AND `trustClientCertHeader` is declared (appending to
  XFF is no promise of stripping a client-sent cert header), and is never an actor.
- **One deadline per request** (`deadline.ts`): `requestTimeoutMs` (30 s, `0` disables), shortenable
  by `x-request-timeout-ms`, never lengthened. `ctx.signal` is the deadline OR the caller going away
  (`AbortSignal.any` with `Request.signal`); `expired` is the timer's alone. `Deadline.deadlineAt` is
  published as core's `ctx.deadlineAt`, which `traceHeaders()` sends onward. Always `deadline.clear()`
  in the `finally`. An ask above `MAX_TIMER_MS` is ignored. **A handler that outlives its 504 is held
  in core's in-flight count** (`beginWork()` in `execute`) until it settles (`pipeline-inflight.test.ts`).
- **`admit` is the second stage and refuses before ANY work**: past `maxInflight` (1000) is
  `X_OVERLOADED` with `retry-after`, counted by core's `inflightCount()`. **A DRAINING process
  serves** with `connection: close`; only `lifecycleState() === 'stopped'` answers `X_DRAINING`
  (`pipeline-hardening.test.ts`).
- **`csrf` sits after `auth` and before `body`**: an unsafe request needs
  `sec-fetch-site: same-origin`, an `Origin` equal to this app (from `ctx.https`), or one EXACTLY in
  `cors.origins` (`originListed`, never `allowedOrigin`); else `X_CSRF_BLOCKED` (403). No
  `mode: 'token'`. **Anonymous is not an exemption** (login CSRF): exempt are an `Authorization`
  header, and an anonymous request with NEITHER `Origin` nor `sec-fetch-site` (not a browser).
- **`meta.enforcedBy` says who evaluates `meta.policy`**: `'pipeline'` (default) decides via
  `hooks.authorize`; `'handler'` stands the `authz` stage down.
- **A 403's `fix:` names the POLICY** (`route.meta.policy`), degrading to `x routes --json` for a
  composite.
- **The body cap is enforced while reading** (`UltimateRequest.#read`'s counting reader, cancelling
  past `bodyLimitBytes`); multipart goes through the same capped bytes. **Bytes with no
  `content-type` are `X_BODY_INVALID`** from `bodyRaw()`, never "no body"; `bodyBytes()` reads them.
- **A repeated field is a LIST in all three parsers** (`collectFields`).
- **`matchRoute` never throws**: `router.ts`'s `decodeSegment` answers `path-invalid` →
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
  it is the one header that is a list of lines (`pipeline-cookies.test.ts`).
- **A redirect the framework writes stays on this origin**: the default-locale redirect goes
  through `normalizePath`; `locationFor` hands over `http:`/`https:` only, else the requested path.
- **A `cache-control` age is delta-seconds or DROPPED** (`finiteDeltaSeconds`, total, always the
  shorter direction; logs `http.cache_hint_not_delta_seconds`). Its boot half is `route-cache.ts`:
  `createRouter` refuses a bad `Route.cache` with `X_CONFIG_INVALID`. Both accept the same set; zero
  is legal. `ctx.cache` is not screened.
- **A handler's own `Response.status` is never rewritten** (`pipeline-handler-status.test.ts`).
- Health endpoints answer outside the pipeline, so their body is a stranger's: `{ state, ready,
  role }` unless the peer is in `healthDetailPeers` (default `['loopback']`; socket AND trusted
  forwarded caller must both be listed — `health-disclosure.ts`). **Lifecycle belongs to core** (`beginWork()`,
  `markReady()`, `drain()`, the payloads) — never a private state or in-flight counter.
- **`stop()` hands its two hooks back ABOVE its early return** (`packages/http/e2e/server.e2e.test.ts`
  reads `shutdownHookCount()`).

## Rules — errors and the problem document

- Statuses live in `error-map.ts` only; the framework table is closed and an app declares its codes
  with `registerErrorStatus()` (refuses a framework code). No projection of the app's half.
  **`error-facts.ts` renders the throwable**; the seam is `declaredStatusFor(code)`, imports one way.
- **A problem's `type` is `problemTypeFor(code)` = `urn:ultimate:error:<CODE>`; its `docs` is core's
  `ERROR_DOCS_URL`.** `finalize.ts`'s `lastResort` literal is pinned against `problemTypeFor('X_INTERNAL')`.
- **A 5xx cause is withheld unless its code opts in** (`hasPublicCause`, `problem-meta.ts`;
  `registerProblemMeta({ CODE: { publicCause: true } })`). `toProblem(error, { dev })` defaults `dev`
  to false. An unclassified 5xx carries nothing off the throwable. **A hidden cause hides the `fix`
  too**: `callerFix`, else `x errors explain <CODE> --json` — never `facts.fix` outside dev.
- **The document carries the ISSUE LIST** as a top-level `issues` member: `issuesOf` is total,
  all-or-nothing, absent (never `[]`) when none, dropped past `MAX_PROBLEM_ISSUES` (100), dropped under
  the opacity condition; `received` forced to `''`, entries rebuilt member by member.
- **`meta` reaches the document only by declaration** (`registerProblemMeta({ CODE: [keys] })`, app
  codes only; not `issues`, not `__proto__`): `wireMeta` copies declared keys through
  `Object.defineProperty`, bounded by `MAX_PROBLEM_META_BYTES`, dropped when opaque.
- **A rejected value is a log FIELD, never the message** — the `error-map` line's message is the code alone.
- **A rejected BODY names only what the framework chose**: `bodyInvalid`'s `issues` are a fixed
  vocabulary; what the caller sent rides in `meta`; the parser's message goes through `renderThrowable`.
- **A browser failing `auth: 'required'` is redirected; an agent gets the problem document**
  (`auth-redirect.ts`, in `error-map` before the overlay). `config.signInPath` is `null` until named.
  `nextAfterSignIn` is the ONE `?next=` reader: same-origin paths only, decoded ONCE (by the
  caller's parser, never again here — `%26` stays `%26`), any C0/DEL refused, non-ASCII
  percent-encoded for `Location`, re-parsed against an unreachable origin, never throws. It
  returns the RESOLVED path (never the raw string) and refuses one starting `//`; `locationFor`
  never emits a same-origin pathname starting `//` (`/.//…` instead).
- **A pathname in a `fix:` goes through `renderFixShellArg`** (`routeNotFound`). **A `code` is gated by
  core's `FRAMEWORK_CODE`** before `x errors explain <code>`, else `x errors list --json`. **A supplied
  `fix:` is taken only from a branded error** (`isUltimateError`).
- **Borrowed codes are never titled or registered here** (`HTTP_BORROWED_ERROR_CODES`: `X_FORBIDDEN`,
  `X_UNAUTHENTICATED`, …); `factsOf` reads a borrowed code's title off the error.
- Never throw a bare `Error` — use a factory from `errors.ts`. No `any`. Validation goes through
  Standard Schema (`validate.ts`).

## Rules — rate limiting

- **One request spends a LIST of keys**: the caller's and, when `rateLimit.tenantBucket` is declared,
  `tenant|org:<id>` (not route-scoped); stop at the first refusal; an undeclared name is
  `X_RATE_LIMIT_TENANT_BUCKET_UNKNOWN`. Headers report the bucket closest to refusing.
- **The memory store is bounded** (`forgetAtMs` sweep, `DEFAULT_MAX_RATE_LIMIT_KEYS`, evicting the
  entries closest to FULL first — never LRU).
- **The limiter takes a `Clock`** (`createRateLimiter({ clock })`); `deps.limiter` is the one seam.
- **The scope is DECLARED, with no default**: an enabled limiter without `scope` is
  `X_RATE_LIMIT_SCOPE_UNSET`; `assertRateLimitScope` (in `createPipeline`) refuses `'shared'` over a
  per-process store (`X_RATE_LIMIT_NOT_SHARED`). Install through `createServer({ rateLimitStore })`.
- **A failed `auth: 'required'` is metered in the `auth` stage** (`spendUnauthenticated`,
  `rate-limit-stage.ts`): `defaultBucket` under `unauthenticated|ip:<address>`, not route-scoped,
  spent only on failure — the 401 leaves before `rate-limit`. Covers the bearer mount's bad tokens.
  Spent, it REFUSES the address before `authenticate()` (`refuseExhaustedAddress`, via the store's
  read-only `peek` — never a take: that was an upsert per signed-in page),
  a valid credential included; no `ctx.ip`, no gate. Signed-in callers behind that NAT wait too.
- **`postgresRateLimitStore({ executor })` is the shared store**, over `@ultimat3/core`'s structural
  `PgExecutor` (re-exported here). The
  refill expression is repeated inside `on conflict do update` on purpose; `spent` is a stored column;
  `purgeExpired(nowMs)` takes the caller's clock.
- **A bucket a route names must be registered**: `withRouteBuckets` merges `meta.rateLimitBucket`
  into the table in `createServer` and `createPipeline`; any disagreement is
  `X_RATE_LIMIT_BUCKET_CONFLICT`. **The installed limiter must hold it too** — `RateLimiter.buckets`
  is declared and `assertRouteBuckets` refuses, never rebinds.

## Rules — webhooks and tests

- **`verifyWebhookSignature` is a FUNCTION, never a stage**: it reads through core's
  `readWithinLimit` and returns the raw text. The mac is checked BEFORE freshness
  (`X_WEBHOOK_SIGNATURE_STALE` means authentic and old); the window is `Math.abs`; the timestamp is
  digits-only; `:` is refused in id and topic; the comparison is `timingSafeEqual`
  (`bun run secret-compare`). **The FORMAT is core's** (`packages/core/src/webhook-signature.ts`) —
  never re-declared here.
- Tests must not touch the network — the preload seals `fetch`. Socket tests live in `e2e/` (`bun test
  packages/http/e2e`), sealed; `start()` calls core's `markListening()`. Never unseal.

## Files

| File | Job |
|---|---|
| `pipeline.ts` | the ORDER the stages run in — the framework's guarantee — and the one loop that drives a request through them |
| `stages.ts` | what each stage DOES, one entry per `StageName`, plus the stage vocabulary the other two import |
| `finalize.ts` | the tail of that lifecycle, guarded: a throw after the handler degrades, never rejects |
| `router.ts` | trie matcher, precedence static > param > wildcard, `path-invalid` for a segment that will not decode. A request segment is decoded ONCE; a static child is looked up raw, then decoded (`/precios-espa%C3%B1a` is `/precios-españa`). A wildcard takes an EMPTY rest after the node's own routes (`/docs` → `/docs/*path` with `path: ''`, the path `@ultimat3/render`'s static build writes) — `router-spelling.test.ts` |
| `navigation.ts` | the client router's server half: the gate `context` runs after the match (a prefetch to a route whose `meta.navigation` did not opt in → `204`; a soft GET to anything but a page of the router's `<app>:<surface>` → `204` + `x-ultimate-location`, before auth or app code) and the `response` stage's rewrite of a 3xx to a router request into the same hand-over, cookies kept |
| `error-map.ts` | the code → status table, closed: COMPOSES the slices and holds no row of its own |
| `error-map-http.ts`, `error-map-tier-<0-4>.ts` | the rows, one slice per owning tier (this package's own apart). `bun run new-error-code` appends to the slice its `--package` maps to; a code in two slices is refused there and by `error-map.test.ts` |
| `error-facts.ts` | every RENDERING of a throwable: `factsOf()`, the problem document (including the issue list and the opacity rule over it), the three terminal lines |
| `hooks.ts` | the seams: `authenticate`, `authorize`, `devNotices`, `errorPage`, `explainMiss` (asked ONLY on a `not-found` match, synchronously, with the request line alone; its error replaces `X_ROUTE_NOT_FOUND`) + the app's `configureAuthenticator()` |
| `type-pins.ts` | compile-time claims about `AuthzDecision`'s shape — source, because `tsc` never reads a `.test.ts` |
| `overlay.ts` | the dev error page: the same code/cause/fix as the terminal, plus any notices |
| `overlay-style.ts` | the overlay's one stylesheet, split out so `security-headers.ts` hashes it |
| `context.ts` | `RequestContext` (core's `Ctx` plus the request's own), composed from `createContext`, the single `Ctx` adapter (`asCtx`) and the inbound-header readers |
| `redirect.ts` | the intent slot a handler that cannot return a `Response` fills |
| `auth-redirect.ts` | where an unauthenticated browser goes, and where it comes back to |
| `cache-policy.ts` | the default `CacheHint` for a route that declared none — route AND actor — and the review of a declared one (`reviewedHint`) |
| `error-log-level.ts` | the level of the `error-map` stage's one line: `error` for 5xx, `warn` for 401/403/429, `info` for the rest |
| `route-cache.ts` | the screen a `Route.cache` hint gets where it is DECLARED, thrown from `createRouter`; the response path's `finiteDeltaSeconds` is the total half of the same rule |
| `rate-limit.ts` | the token-bucket maths, the store interface, the memory driver and `toBucket` |
| `rate-limit-postgres.ts` | the SHARED store: one table, one `insert … on conflict` per take, over a structural `PgExecutor` |
| `rate-limit-errors.ts` | every refusal a rate limit produces — the 429 and the six declaration faults. Split off `errors.ts` at the ceiling |
| `error-titles.ts` | the owned codes, their titles and the two `retry-after` classes, registered at import — the one module `sideEffects` lists, imported bare by the barrel and `errors.ts`. Server realm only: a browser reads an http refusal's title off the body and its delay off `Retry-After` (core's decoders), so no http module rides into an island |
| `correlation.ts` | the inbound request id and trace, read before the context and the span exist |
| `forwarded.ts` | one hop-indexed reader for every header a trusted proxy writes |
| `peer-identity.ts` | Envoy XFCC -> `ctx.peer`, on that same trust rule |
| `deadline.ts` | the per-request `AbortController`, the timer and `X_TIMEOUT` |
| `csrf.ts` | the origin proof an unsafe method from a browser must carry, signed in or not |
| `webhook-verify.ts` | the INBOUND webhook: the canonical string, the constant-time mac check and the replay window. The outbound half is `webhook()` in `@ultimat3/jobs`, which this package can never import |
| `locale.ts` | WHERE the request's locale and zone are read from — header and cookie NAMES only. It negotiates nothing; the cookie is read by `@ultimat3/core`'s `readCookie`, which `index.ts` re-exports |
| `rate-limit-buckets.ts` | the one point routes and config meet: a route's own bucket, registered or refused |
| `rate-limit-stage.ts` | what the pipeline spends and when: the `rate-limit` stage's list of keys, and the address-keyed allowance the `auth` stage spends for a failed credential |
| `health-disclosure.ts` | WHO the web role's `/healthz` and `/readyz` tell the detail to: the `healthDetailPeers` config key, its screen, and the trusted-proxy half. The body rule and the peer match are core's (`health-disclosure.ts` there), shared with the sync node |
| `bearer-mount.ts` | a second door onto existing routes: `Authorization: Bearer` on a prefix, the scope cut, the per-token allowance |
| `app-config.ts` | the app's own HTTP declaration (`configureHttp`) and the layering that keeps a boot fact above it |

## Commands

```
bun test packages/http
bun run --filter @ultimat3/http typecheck
```

Why each rule above is shaped the way it is: [`docs/history/http.md`](../../docs/history/http.md).
