# @ultimat3/http

Owned request lifecycle over `Bun.serve`. Tier 2.

## Boundary

- May import: `@ultimat3/core`, `@ultimat3/schema`. Nothing else, ever.
- May NOT import `@ultimat3/policy` or `@ultimat3/entity` — same tier. Authz and auth
  come in via `ServerHooks` (`hooks.ts`), declared structurally.
- `@ultimat3/action` (tier 3) is what wires policy into `hooks.authorize`.

## Rules

- Route `meta.auth` is required. Never default a route to public.
- **`asCtx` is a WIDENING the compiler checks, never a cast.** `RequestContext extends Ctx`, and
  `asCtx` is the identity function. It used to be `ctx as unknown as Ctx` over an object that set
  none of `clock`, `now`, `logger`, `signal` or `services` — so `ctx.now()` threw
  `TypeError: ctx.now is not a function` on every audited action served over HTTP,
  `useService()` threw a `TypeError` instead of the `X_SERVICE_MISSING` it exists to raise, and
  `throwIfAborted()` — the documented cancellation seam — was inert on the one surface where a
  caller can actually go away. Never reintroduce the assertion: the type error IS the enforcement,
  and it is a type-pin rather than a `.test.ts` because `tsconfig.json` excludes tests.
  `ctx.buildId` is core's meaning — the build this PROCESS serves; the CLIENT's claim is
  `ctx.clientBuildId`, read only by `assertBuild()`.
- **The two inbound ids are read BEFORE the context and the span, in `correlation.ts`.** `startSpan`
  resolves its parent from `currentSpanContext()`, which reads `ctx.traceId`, so a `traceparent`
  parsed by a stage arrived one frame after the span's context was already frozen: the caller's
  trace was discarded, the root span carried a dashed UUIDv7 no collector accepts as a trace id,
  and the log lines beside it quoted a third value. The `request-id` and `trace` stages now only
  PUBLISH what was decided — they do not decide. The regex is core's `parseTraceparent`, one copy.
- **Every proxy-supplied header goes through `forwardedElement(header, hops)` and nothing else.**
  `trustProxy` documented reading `x-forwarded-for` and had no reader at all, so behind any ingress
  every anonymous request keyed to the proxy — one `auth` bucket (capacity 10) for the whole
  internet, and one scanner enough to 429 every signup on the fleet. The entry read is
  `entries.length - hops`, never `[0]`, which is whatever the client typed; a chain shorter than
  declared trusts nothing rather than falling back leftward. `trustProxy` defaults to **false** and
  requires `trustedProxyHops` (`X_TRUST_PROXY_UNSET` at `defineHttpConfig`) — it also gates the
  `x-request-id` echo, and a direct caller choosing its own request id poisons log correlation.
  `x-forwarded-proto` rides the same rule, which is what finally emits HSTS behind a
  TLS-terminating ingress, and so does Envoy's `x-forwarded-client-cert` (`peer-identity.ts`).
  **A peer certificate read from an untrusted hop is worse than none, because it authenticates** —
  so `ctx.peer` is `null` for an untrusted deployment, a missing header and a short chain alike.
  `ctx.peer` is never an actor: `hooks.authenticate` is the one funnel, through
  `verifyWorkloadToken()` -> `actorFromService()` in `@ultimat3/auth`.
- **One deadline per request, and it is what makes `ctx.signal` exist.** `deadline.ts` holds the
  `AbortController` and the timer; `config.requestTimeoutMs` (30s, `0` disables) is the budget and
  a caller may SHORTEN it with `x-request-timeout-ms`, never lengthen it. Two halves, both needed:
  the abort is what cooperative code unwinds on, and the race in `execute` is what answers the
  socket when a handler never looked at the signal. `X_TIMEOUT` is borrowed (core's concept) and
  already mapped to 504. Always `deadline.clear()` in the `finally` — a live timer keeps the event
  loop from going idle, so a process that answered everything still refuses to exit.
- **`admit` is the second stage, and it refuses before ANY work.** `isDraining()` had no reader in
  this package while this file claimed the layer answered 503 on it; past `config.maxInflight`
  (1000, `0` disables) a request is shed `X_OVERLOADED` with `retry-after`. Both set the header on
  `ctx.headers`, which the `response` stage merges, rather than teaching `error-map` a second
  special case. The in-flight number is core's `inflightCount()` — the same counter `beginWork()`
  in `server.ts` maintains — never a private one, for the same reason the drain phase is core's.
  A refusal that costs as much as a served request is not load shedding.
- **`csrf` sits after `auth` and before `body`, and CORS cannot replace it.**
  `application/x-www-form-urlencoded` is a CORS-*simple* content type, so a cross-site
  `<form method="post">` is SENT and EXECUTED with the session cookie attached and
  `cors.origins: []` only withholds the reply — long after the refund went through. After auth
  because only an AMBIENT credential can be forged into (anonymous and bearer callers are exempt);
  before body so a rejected write never allocates its payload. `sec-fetch-site: same-origin`, an
  `Origin` equal to this app, or an `Origin` already in `cors.origins`; anything else is
  `X_CSRF_BLOCKED` (403, never 401 — the caller IS signed in, which is the problem). The self
  origin is built from `ctx.https`, not `url.protocol`, or every legitimate post behind a
  TLS-terminating ingress would be refused. **`mode: 'token'` is deliberately NOT shipped** — a
  double-submit token needs a cookie issuer and a form-field helper at tier 4/5, and a half-built
  token mode is worse than an honest `'origin' | 'off'`.
- **A rejected value is a log FIELD, never part of the message.** `logger.emit()` redacts `bound`,
  `contextFields` and `fields` — and never `msg` — so `logger.error(\`${code}: ${cause}\`)` in the
  `error-map` stage wrote a rejected password verbatim into the log store, at 4xx, which is logged
  and not reported and therefore kept for the full retention. The message is the CODE alone. The
  other half is `@ultimat3/schema`'s `describeValue` (shape, never content) and it is the
  load-bearing one; this half is what makes the value redactable at all.
- **A browser that fails `auth: 'required'` is redirected; an agent gets the problem document.**
  One condition, two audiences, decided once in `auth-redirect.ts` and applied in the `error-map`
  stage before the overlay. `config.signInPath` is `null` until an app names its page, because a
  framework that guessed `/signin` would send an app spelling it `/login` to a 404 — strictly
  worse than the JSON. The round trip is `?next=`, and `nextAfterSignIn` is the ONE reader of it:
  anything that is not a same-origin path falls back, or the page that hands out a session
  becomes an open redirect. **A control character is an off-site destination**: a browser deletes
  TAB, CR and LF from a `Location` before parsing it, so `/%09/evil.test` decodes to a value that
  starts with one slash, passes a prefix check and is then followed as `//evil.test`. The prefix
  checks are not the last word — the value is re-parsed against an origin no relative path can
  reach, and anything that resolves off it falls back. Nothing here throws either: `?next=%` is a
  bare `URIError`, and this runs while the pipeline is already rendering a 401.
- **The body cap is enforced while reading, never after.** `UltimateRequest.#read` pulls the body
  through a counting reader and cancels the stream the moment the running total passes
  `bodyLimitBytes`. `content-length` is a courtesy — a `transfer-encoding: chunked` request
  declares none, so `arrayBuffer()` allocated a 10GB payload in full before measuring it. Multipart
  goes through the same capped bytes (re-parsed by `Response.formData()` off the announced
  boundary) rather than being handed to the runtime as an unbounded stream, which is what left it
  with no byte guard at all when the length was undeclared.
- **The cache default reads the ACTOR, not just the route, and `vary` is added and never set.**
  `meta.auth` is only `'public' | 'required'`, so the page that greets a signed-in visitor by name
  is a `'public'` route: keying the default off the route alone put that visitor's personalised
  HTML in a shared cache for 60 seconds. A request whose actor is not anonymous is `private`;
  an anonymous one stays shared-cacheable and carries `vary: accept-language, cookie`. Both halves
  are required — either alone leaves the hole. `addVary` (`response.ts`) is how the `response`
  stage merges CORS's `vary: origin` into the cache stage's key instead of replacing it.
- **`cors.origins: ['*']` with `credentials: true` is refused at `defineHttpConfig`.** No browser
  accepts that pair, and `allowedOrigin` answering `null` for it meant the natural "open it up"
  edit emitted no CORS headers at all, silently, on every request — with `DEFAULT_CORS.credentials`
  (true) as the half nobody thinks to look at. `X_CORS_CONFIG_INVALID`, at config time, with the
  one-line edit in the `fix`. A REFUSED origin still gets `vary: origin`: without it a shared cache
  files the un-CORS'd body under the URL alone and hands it to an allowed origin next.
- **HSTS is emitted only when https is affirmed.** `securityHeaders(config, { https })` defaults to
  NOT sending it — the pipeline is the one caller that knows, and it passes `ctx.https`. The guard
  read `!== false`, so every other caller sent a two-year `includeSubDomains` for a connection
  nothing had established was secure, which is the opposite of what the comment above it promised.
- **`meta.enforcedBy` says who evaluates `meta.policy`, and the `authz` stage obeys it.**
  `'pipeline'` (the default, and what a page wants) means the stage decides through
  `hooks.authorize`; `'handler'` means the handler is the one evaluation and the stage returns
  without deciding — no hook required, and none consulted. An action route says `'handler'`
  because `@ultimat3/action`'s `invoke` loads the row a row-level rule reads and this stage
  cannot. Deciding in both places is two authz systems, and the one that answers first is the
  one holding less.
- **`ctx.actor` is never null.** `asCtx` publishes the request context itself as core's `Ctx`,
  and `Ctx.actor` is an `Actor` — so "nobody" is core's anonymous actor, not `null`. The
  `authenticate` hook still says it with `null`; the `auth` stage is where that becomes
  `anonymousActor()`. A null here reaches every `ctx.actor` reader in the framework as a contract
  violation that only shows up on the first unauthenticated request.
- **The lifecycle is three files, and the split is by responsibility, not by length.** `pipeline.ts`
  owns the ORDER (`PIPELINE_STAGES`, the phases, the run loop, ALS, the span and the one metrics
  call); `stages.ts` owns what each stage does and declares the vocabulary (`StageName`,
  `StageRun`, `Stage`) beside the implementations it names; `finalize.ts` owns the promise that the
  tail answers rather than rejects. Imports go one way — `pipeline.ts` → `stages.ts` — because a
  stage body reads `StageRunnersInput`, an explicit list of what a stage may depend on, and never
  `PipelineDeps`. Adding a stage means an entry in **both** `PIPELINE_STAGES` and the
  `Record<StageName, StageRun>` table; the record type is what makes forgetting one a build error.
- Never add a stage to `PIPELINE_STAGES` without a `why` and a test.
- **`toBucket` lives here, not in `@ultimat3/action`.** `action` and `query` are the same tier and
  can never import each other, so the only conversion between `{ limit, windowMs }` and a `Bucket`
  sitting in one of them is why a `query` could not declare a rate limit at all. It is beside
  `Bucket` and the maths it validates, and it throws http's own `X_RATE_LIMIT_INVALID`.
- Statuses live in `error-map.ts` only. No other file writes a status number. The framework's
  table (`ERROR_STATUS`) is closed; an app declares its own codes' statuses with
  `registerErrorStatus()`, which refuses a code the framework already holds. Without that half,
  every app code was 500 and `pipeline.ts` paged the on-call for a wrong password.
- **The context carries the inbound headers, never the `Request`.** `ctx.requestHeaders` is set
  once at construction; `useRequestHeader` / `useRequestCookie` are what app code reads, and
  `UltimateRequest.cookie()` is what `hooks.authenticate` reads. A `Request` on the context is a
  second body reader past the size cap, the content-type parse and the cache.
- **`hooks.authenticate` has one declaration site: `configureAuthenticator()`.** A single value,
  not a list — two answers to "who is this?" is two identities per request. `@ultimat3/auth` is
  the same tier and can never import this package, so the app is what wires them together.
- **`hooks.devNotices` is dev-only, and the overlay path is the only place it is called.**
  `OverlayNotice` is declared structurally in `overlay.ts` because the packages that produce one
  — `@ultimat3/entity`'s N+1 codes, reported by `x dev` — are this tier or above and can never be
  imported here, exactly as `AuthzDecision` is. The call sits INSIDE the
  `config.dev && wantsOverlay` branch: the overlay is a notice's only surface, so a production
  process, or an agent that asked for problem+json, must not pay a diagnostic's per-request cost
  for findings nothing renders. No notices means no card, byte for byte.
- **`matchRoute` never throws — a pathname is whatever the client typed.** `decodeURIComponent`
  is called only through `router.ts`'s guarded `decodeSegment`, and a segment that will not decode
  answers `{ reason: 'path-invalid', segment }` → `X_PATH_INVALID` → 400. A bare `URIError` here
  reached `factsOf` as `X_INTERNAL`, so a `%ZZ` answered 500 and paged the on-call for a typo.
  Only the branch that would have decoded fails: static segments are compared raw, so a path that
  reaches no param or wildcard is still a 404 and precedence is unchanged.
- **`handle()` resolves to a Response or the server has no answer at all.** The request phases are
  guarded by `execute`'s own `try`; the two that run after them are guarded in `finalize.ts`, and
  neither guard is optional. A finalize stage that refuses the response it was handed degrades to
  `X_PIPELINE_FINALIZE_FAILED` (500), and the chain runs a **second** pass over that problem
  document — whose headers are writable — so the request id, CORS and the security headers still
  reach the client. Two passes, never a loop. A throw inside the recover stage (an app's `onError`,
  a `devNotices` producer) is answered with the problem document for the error the request actually
  hit: the stage that renders a throw has nothing left to render its own. Every degraded answer goes
  *through* the recover stage, never around it — reporting, logging and the overlay each keep one
  call site.
- **The memory rate-limit store is bounded, and the eviction order is part of the guarantee.**
  The key falls back to the connection address (`rateLimitKey`), so a scan rotating through an
  IPv6 /64 mints one entry per request — an unbounded map hands the flood the process. Every
  entry carries `forgetAtMs`, the instant a refilled bucket becomes indistinguishable from a
  missing one, and the sweep drops those for free. `DEFAULT_MAX_RATE_LIMIT_KEYS` is the backstop,
  and it evicts the entries **closest to full** first: throwing away a spent bucket is a free
  reset for whoever spent it, so the most-throttled key is the last one to go. Never swap that
  comparator for insertion order or an LRU — recency is not the same as worthlessness here.
- **Where the limiter's counters live is DECLARED by the app, never inferred, and refused at
  boot — and there is no default.** `DEFAULT_RATE_LIMIT` carries no `scope`, so
  `resolveRateLimitConfig` refuses `X_RATE_LIMIT_SCOPE_UNSET` at `defineHttpConfig` when a limiter
  that is ENABLED has not been told. `'process'` used to be the default, which made "nobody asked"
  and "the app said one replica" the same value while `docker/helm/values.yaml` runs three — so
  `assertRateLimitScope` below, which only fires on a `'shared'` declaration, could never see the
  silent case. A disabled limiter owes no declaration: nothing is enforced, so nothing can be
  wrong. The rest of the check is unchanged: `RateLimitStore.scope` says what a driver provides; `config.rateLimit.scope` says what
  the deployment requires; `assertRateLimitScope` compares them once, inside `createPipeline` —
  the one construction path `createServer`, the tests and any embedder all share. `'shared'` over
  a per-process store is `X_RATE_LIMIT_NOT_SHARED` before the socket opens, because the failure it
  replaces is silent: the limiter's counters are **per process**, and `docker/helm/values.yaml`
  runs `roles.web.replicas: 3` before its HPA has said anything, so every configured bucket was
  being enforced three times over with a green `x verify`. Nothing here reads the
  environment to guess a replica count — an app that scales is the only thing that knows. The
  supported way to install one is `createServer({ rateLimitStore })`, which builds the limiter
  through `createRateLimiter` and hands it to the `PipelineDeps.limiter` seam that already
  existed; never add a second limiter entry point beside it.
- **A bucket a route names is a bucket something must register.** `meta.rateLimit` selects by
  name and `meta.rateLimitBucket` carries the numbers; `withRouteBuckets` (`rate-limit-buckets.ts`)
  merges them into `config.rateLimit.buckets` at construction, in `createServer` and again in
  `createPipeline` — idempotently, since the store-backed limiter is built from the merged config
  and `bucketFor` must see the same table the pipeline does. It has to happen there: routes do not
  exist when `defineHttpConfig` builds the table, so a name declared and never registered fell
  through to `default` — an action declaring `limit: 5` ran on 120 burst while its OpenAPI
  operation published 5. **Precedence is refusal, not a winner.** An identical restatement passes;
  any disagreement, with the config or with another route, is `X_RATE_LIMIT_BUCKET_CONFLICT` before
  the socket opens — the same shape as `assertRateLimitScope` and as `@ultimat3/auth`'s
  `AuthLimiter` policy check, and for the same reason: the declaration that lost would go on being
  read as enforced. Never make one side the default winner.
- **Registering into the config is only half of it — the installed LIMITER must hold the bucket
  too.** `createRateLimiter` closes over its config, so a limiter handed to `PipelineDeps.limiter`
  resolves names against the table it was built with; one built before the routes existed misses
  the route's name, falls through `bucketFor` to `default`, and was measured at 120 burst and 21
  of 21 requests allowed for a route declaring 5. `RateLimiter.buckets` publishes that table —
  declared, never inferred, exactly as `RateLimitStore.scope` is — and `assertRouteBuckets` runs
  beside `assertRateLimitScope` in `createPipeline`. **Refused, never rebound**: a `RateLimiter`
  is opaque, so rebinding means discarding the caller's limiter and the store it carries, and a
  caller who built their own may have meant their own numbers. A limiter that declares no table
  is refused too — what cannot be shown to hold is not assumed to hold.
- Never throw a bare `Error` — use a factory from `errors.ts`.
- No `any`. Validation goes through Standard Schema (`validate.ts`), not a vendor API.
- Health endpoints answer outside the pipeline, on purpose.
- **Lifecycle belongs to core.** `server.ts` uses `beginWork()`, `markReady()`,
  `drain()` and `healthzPayload()`/`readyzPayload()`. Never keep a private `state` or
  in-flight counter — core waits on work it does not know about, so a private counter
  hangs every deploy at the `inflight` phase.
- **Borrowed error codes are never titled or registered here.** `X_FORBIDDEN` is policy's,
  `X_UNAUTHENTICATED` is auth's; both sit in `HTTP_BORROWED_ERROR_CODES`, which carries codes
  only. `HTTP_ERROR_TITLES` holds owned codes, and `registerErrorCodes` takes it whole and
  unguarded — declaring a borrowed one throws `X_ERROR_CODE_DUPLICATE` at import, which is the
  point. `factsOf` therefore reads a borrowed code's title off the error itself, never the map.
- Tests must not touch the network — the preload seals `fetch`. Socket tests live in
  `e2e/` and run with `bun test packages/http/e2e`, sealed: `start()` calls core's
  `markListening()`, so the seal treats our own port as self, not egress. Never unseal.

## Files

| File | Job |
|---|---|
| `pipeline.ts` | the ORDER the stages run in — the framework's guarantee — and the one loop that drives a request through them |
| `stages.ts` | what each stage DOES, one entry per `StageName`, plus the stage vocabulary the other two import |
| `finalize.ts` | the tail of that lifecycle, guarded: a throw after the handler degrades, never rejects |
| `router.ts` | trie matcher, precedence static > param > wildcard, `path-invalid` for a segment that will not decode |
| `error-map.ts` | code → status table + `factsOf()` |
| `hooks.ts` | the seams: `authenticate`, `authorize`, `devNotices` + the app's `configureAuthenticator()` |
| `type-pins.ts` | compile-time claims about `AuthzDecision`'s shape — source, because `tsc` never reads a `.test.ts` |
| `overlay.ts` | the dev error page: the same code/cause/fix as the terminal, plus any notices |
| `overlay-style.ts` | the overlay's one stylesheet, split out so `security-headers.ts` hashes it |
| `context.ts` | `RequestContext` + the single `Ctx` adapter (`asCtx`) + the inbound-header readers |
| `redirect.ts` | the intent slot a handler that cannot return a `Response` fills |
| `auth-redirect.ts` | where an unauthenticated browser goes, and where it comes back to |
| `cache-policy.ts` | the default `CacheHint` for a route that declared none — route AND actor |
| `rate-limit.ts` | the token-bucket maths, the store interface, the memory driver and `toBucket` |
| `correlation.ts` | the inbound request id and trace, read before the context and the span exist |
| `forwarded.ts` | one hop-indexed reader for every header a trusted proxy writes |
| `peer-identity.ts` | Envoy XFCC -> `ctx.peer`, on that same trust rule |
| `deadline.ts` | the per-request `AbortController`, the timer and `X_TIMEOUT` |
| `csrf.ts` | the origin proof an unsafe method from a credentialed browser must carry |
| `rate-limit-buckets.ts` | the one point routes and config meet: a route's own bucket, registered or refused |

## Commands

```
bun test packages/http
bun run --filter @ultimat3/http typecheck
```
