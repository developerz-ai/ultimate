# @ultimat3/http

Owned request lifecycle over `Bun.serve`. Tier 2.

## Boundary

- May import: `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/i18n`, `@ultimat3/time` — tiers 0
  and 1, which is the whole rule. There is no extra restriction here; the line used to read
  "core, schema. Nothing else, ever", stated no reason, and was stricter than the tier table.
  **What it bought was three re-implementations.** `locale.ts` carried its own `negotiateLocale`,
  `isValidTimeZone` and `resolveTimeZone`, and each disagreed with its owner about the same
  request: an app shipping `{ en, fr }` resolved `ctx.locale` to `'en'` forever, a switcher writing
  the documented `LOCALE_COOKIE` (`x_locale`) was read by nothing because this package spelled it
  `x-locale`, and `x-timezone: +01:00` — a fixed offset with no DST rules — became `ctx.tz` and
  threw four packages later. Adding a tier-1 import is cheaper than a fourth divergence.
- May NOT import `@ultimat3/policy` or `@ultimat3/entity` — same tier. Authz and auth
  come in via `ServerHooks` (`hooks.ts`), declared structurally.
- `@ultimat3/action` (tier 3) is what wires policy into `hooks.authorize`.

## Rules

- Route `meta.auth` is required. Never default a route to public.
- **An app declares its half of `HttpConfig` through `configureHttp()`, and the boot lays its own
  facts over it** (`As of 2026-08-24`). Until 12.0.0 the entire tuning surface was **unreachable
  from a shipped app**: `AppConfig` has never had an `http` key, `RuntimeOverrides` carries none,
  and the only construction any shipped process made was one fixed literal in
  `packages/cli/src/dev-roles.ts` passing eight boot facts — so `DEFAULT_CORS.origins` was `[]` in
  every deployment (an SPA on `app.example.com` calling `api.example.com` could not work, ever),
  `bodyLimitBytes` was 1 MiB for a 4 MB CSV endpoint, `requestTimeoutMs` 30s for a five-minute
  export, and `rateLimit.buckets` was 120 burst / 2 rps for a bank and a blog alike. Fourteen
  `fix:` lines told the reader to edit `http.<key>` in `app.config.ts`, which has never held one.
  It is a registration and not a config key for `configureAuthenticator`'s reason, stated in
  `hooks.ts`: `@ultimat3/core` is tier 0 and cannot hold this package's types, so an `http` block
  on `AppConfig` would be a **second declaration** of `HttpConfigInput` in a package that can
  never check it against this one. `AppHttpConfig` is `Omit<HttpConfigInput, BootOwnedHttpKey>`,
  **derived, never listed**: a key the boot always overwrites (`port`, `hostname`, `dev`,
  `buildId`, `signInPath`, `trustProxy`, `trustedProxyHops`, `rateLimit.scope`) is a type error
  where an app writes it, rather than a value silently discarded at every boot. `mergeHttpConfig`
  merges one level down — `security.csp.extend` per DIRECTIVE, because the app's CDN source and
  the boot's inline-script hash are each the whole answer for something, and either alone breaks a
  page. `type-pins.ts` holds the other half: a key on `HttpConfig` and not on `HttpConfigInput` is
  a build error, which `scripts/config-readers.ts` cannot see — that ratchet walks `AppConfig` and
  asks whether a key is READ, and this is the mirror question.
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
  already mapped to 504. **`ctx.signal` is the deadline OR the caller going away**, `As of
  2026-08`: `pipeline.ts` hands `startDeadline` the inbound `Request.signal` and the two are joined
  with `AbortSignal.any`, which is what `context.ts` had documented and nothing wired — a closed
  tab held its handler, its pool slot and its vendor connection for the whole 30s. `expired` stays
  the timer's alone: it answers the SOCKET, and a caller that hung up has no socket to answer.
  **And it leaves this process on the next hop's headers, `As of 2026-08-24`**:
  `Deadline.deadlineAt` is published as core's `ctx.deadlineAt`, and `traceHeaders()` (tier 0, the
  one thing both typed clients spread before the caller's own headers) sends what is LEFT as
  `x-request-timeout-ms`. Before that the header had exactly one reader — `resolveTimeoutMs`, in
  this file — and **zero writers anywhere in the tree**, so gateway → A (30s) → B meant a call made
  at t=29 started B on a FRESH 30s: real work, holding a pool slot and a vendor connection, half a
  minute after A's socket was answered `X_TIMEOUT`. A spent budget sends no header at all rather
  than `0`, because `resolveTimeoutMs` ignores anything under 1ms and falls back to its own.
  With `requestTimeoutMs: 0` the caller's signal is handed through as-is rather than the shared
  never-aborted singleton, which every such request used to share — one `abort` listener per
  request, accumulating for the life of the process. Always `deadline.clear()` in the `finally` —
  a live timer keeps the event loop from going idle, so a process that answered everything still
  refuses to exit.
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
- **An unclassified 5xx tells the CALLER nothing off the throwable** (`As of 2026-08-23`).
  `error-page.ts` has always shown a browser the status, the code and the request id and said so in
  its header; `toProblem` rendered `facts.cause`, which for a 500 nobody classified falls through to
  the exception's own `message` — a driver's DSN, the row Postgres rejected, an absolute path. One
  condition, two audiences, and they disagreed. The discriminator is a code nobody declared a status
  for, plus `X_INTERNAL` itself: core's `toError()` wraps a caught value into an `InternalError`
  whose cause is `renderCauseValue(value)`, so the framework's own word for "unclassified" is where
  the leak arrives. `toProblem(error, { dev })` is the seam and `dev` DEFAULTS TO FALSE: the
  `error-map` stage is the one call site that can see the config, and every degraded `problem()` in
  the tail must stay opaque. The real text is not lost — it is the log field and the error report,
  both keyed by the request id the caller was given.
- **A rejected value is a log FIELD, never part of the message.** `logger.emit()` redacts `bound`,
  `contextFields` and `fields` — and never `msg` — so `logger.error(\`${code}: ${cause}\`)` in the
  `error-map` stage wrote a rejected password verbatim into the log store, at 4xx, which is logged
  and not reported and therefore kept for the full retention. The message is the CODE alone. The
  other half is `@ultimat3/schema`'s `describeValue` (shape, never content) and it is the
  load-bearing one; this half is what makes the value redactable at all.
- **A repeated field is a LIST, in all three parsers.** `collectFields` in `request.ts` is the one
  collector for the query, `application/x-www-form-urlencoded` and `multipart/form-data`. The last
  two were `Object.fromEntries`, which keeps the LAST value: a checkbox group posting `tags` three
  times reached the body schema as one string, while the query parser three functions up had built
  an array for the same shape since it shipped.
- **A rejected BODY is not a log field either — `bodyInvalid`'s `issues` may name only what the
  framework chose** (`As of 2026-08-19`). `request.ts` built `could not parse ${type}: ${String(error)}`,
  and the runtime's `SyntaxError` quotes the token it choked on: a `POST` of
  `{"password": hunter2SuperSecret}` answered `422` with that identifier in `cause`, which goes to
  the CALLER through `toProblem` and to the log store as the unredactable field `cause`. Two rules,
  both needed. The caller-facing `issues` are a fixed vocabulary — `could not parse the body as
  JSON`, and the LIST of accepted content-types rather than the one that was sent — and everything
  the caller supplied rides in `bodyInvalid`'s third argument, `meta`, which `toProblem` never
  renders. The parser's own message goes through core's `renderThrowable`, never `String(error)`:
  `bun run error-render` cannot see this class of defect, because a `catch` binding is not a
  parameter, so it is a review rule here and a blind spot there.
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
- **The `cache-headers` stage is the ONE owner of the final cache answer, `As of 2026-08-23`.** It
  used to apply the actor-aware default only when nothing had set a header — and every page route
  in every app sets one, because `@ultimat3/render`'s `ssrHeaders` writes
  `public, max-age=0, s-maxage=30, stale-while-revalidate=300` for any route that declares no
  `policy`, which is exactly what `x g route --surface app` scaffolds. So the rule below was
  unreachable for the surface it was written for. A render mode states the MODE's intent; this
  stage decides, and `offersSharedCache` is the discriminator: a shared answer for an identified
  request becomes `PRIVATE_CACHE`, an anonymous one gains `SHARED_CACHE_VARY`. `immutable` is left
  alone in both directions — it asserts the body is a function of the URL, which is what a
  content-addressed island chunk is, and demoting those would re-download every chunk on every
  navigation for every signed-in user.
- **The cache default reads the ACTOR, not just the route, and `vary` is added and never set.**
  `meta.auth` is only `'public' | 'required'`, so the page that greets a signed-in visitor by name
  is a `'public'` route: keying the default off the route alone put that visitor's personalised
  HTML in a shared cache for 60 seconds. A request whose actor is not anonymous is `private`;
  an anonymous one stays shared-cacheable and carries `vary: accept-language, cookie`. Both halves
  are required — either alone leaves the hole. `addVary` (`response.ts`) is how the `response`
  stage merges CORS's `vary: origin` into the cache stage's key instead of replacing it.
- **A `security.csp.extend` entry is refused at `defineHttpConfig` unless it can only emit the
  directive it names.** A directive name and a source both go into the header VERBATIM and the
  header's own separators are `;` and ` `, so `extend: { 'x; script-src *': [] }` was not one badly
  named directive — it was a second directive nobody declared, widening the one this package locks
  down hardest. `X_CSP_DIRECTIVE_INVALID`, at boot, because there is no encoding for a CSP source
  and escaping one at emission time is not a repair. `buildCsp` builds through a **`Map`** for the
  other half of the same class: `directives[name]` was a computed read of an object literal keyed by
  a caller-chosen name, so `extend: { toString: [...] }` spread a function off `Object.prototype`
  and threw a bare `TypeError` at boot. `proto-index` cannot see it — `baseline()` is what produces
  the object.
- **`config.drainTimeoutMs` is `number | null`, and `null` is the default** (`As of 2026-08-23`).
  `createServer` calls `configureLifecycle({ deadlineMs })` only when an app DECLARED one. It used
  to call it unconditionally with a value `defineHttpConfig` had defaulted to 15s, so an app that
  wrote `configureLifecycle({ deadlineMs: 600_000 })` — the edit `X_SHUTDOWN_TIMEOUT`'s own `fix:`
  prints — had it silently reverted by the next line of boot, in every process that serves web.
  "Nobody said" and "the app said 15 seconds" are different claims and only one of them may move a
  process-global deadline.
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
- **A 403's `fix:` names the POLICY, never the pathname** (`As of 2026-08`). `forbidden` emitted
  `x policy explain ${ctx.url.pathname}`, and `x policy explain` resolves a policy SUBJECT — a
  permission, an action name or a query name. A page pathname is none of them, so the one command
  the error told the reader to run exited `X_DECLARATION_UNKNOWN` (`x policy explain /settings`,
  reproduced in `examples/dummy`). The third argument is `route.meta.policy`, which is what the
  `authz` stage was evaluating and what the index can resolve; anything that is not a bare
  `resource:verb` — a composite renders `and(a:b, c:d)` — degrades to `x routes --json`, the shape
  `bodyInvalid` already uses. A fix that names the wrong thing is not a fix.
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
- **The `locale` stage decides WHERE, the owners decide WHAT.** It reads a header and a cookie and
  hands the raw strings to `@ultimat3/i18n`'s `resolveLocale` and `@ultimat3/time`'s
  `resolveTimeZone`; it must never negotiate, validate or canonicalize one itself. The two answers
  land on `ctx.locale` and `ctx.tz` — **core's own declared fields, the framework's only ambient
  store for either** — so `currentLocale()` and `currentTimeZone()` answer for this request once
  `pipeline.ts` publishes the context into the ALS. `@ultimat3/time` kept a second store
  (`ctx['timeZone']`) with zero writers until 1.3.0, and the whole cost was silent: every
  `@ultimat3/ui` server render formatted its dates in UTC however the request arrived. A default
  for either value is `configureTime({ defaultZone })` / `defineCatalogs({ default })`, never a
  third copy in `HttpConfig`.
- **`toBucket` lives here, not in `@ultimat3/action`.** `action` and `query` are the same tier and
  can never import each other, so the only conversion between `{ limit, windowMs }` and a `Bucket`
  sitting in one of them is why a `query` could not declare a rate limit at all. It is beside
  `Bucket` and the maths it validates, and it throws http's own `X_RATE_LIMIT_INVALID`.
- **`ERROR_STATUS`'s keys are LITERAL, not an index signature** (`As of 2026-08-19`). The
  annotation was `Readonly<Record<string, number>>`, which made `ERROR_STATUS.X_QUERY_NOT_PAGABLE`
  a legal read answering `undefined` — a mistyped row in the one table the framework's whole error
  contract rests on. It is now an object literal `satisfies Readonly<Record<string, number>>`, so a
  typo is a compile error; `error-map.test.ts` pins that with a `@ts-expect-error`. Read it by a
  code the framework did not mint through `statusFor()`, which goes via the file-local `BY_CODE`
  view and keeps `Object.hasOwn`.
- **A problem document's `type` and its `docs` are two different questions, `As of 2026-08-23`.**
  Both used to be `https://ultimate.dev/errors/<code>` — one string, twice, and a host that
  answers **404** on every 4xx and 5xx this package has ever rendered. `docs` is now core's
  `ERROR_DOCS_URL`, one wiki page for every code, and it is never spelled here: a construction site
  omits `docs:` and `UltimateError` resolves it. `type` did NOT follow it there. It is RFC 9457's
  primary identifier for the problem KIND — a client switches on it — so collapsing it onto one
  page would have given a 422 and a 403 the same identifier. `problemTypeFor(code)` answers
  `urn:ultimate:error:<CODE>`: per code, stable, and a URN has no host to rot. `finalize.ts`'s
  `lastResort` spells its one `type` as a literal because that function calls nothing, and
  `pipeline-finalize.test.ts` pins the literal against `problemTypeFor('X_INTERNAL')` so the two
  cannot drift. Never assert either value as a copied string — import the constant.
- **`error-map.ts` answers the status; `error-facts.ts` renders the throwable** (`As of
  2026-08-24`). One file did both and reached 501 lines, over the ceiling. The seam between
  them is `declaredStatusFor(code)` — `number | undefined`, exported to this package only —
  because the two questions are genuinely different: `statusFor` always answers a number, while
  "did ANYBODY classify this code" is what decides whether a 5xx may carry the throwable's own
  words back to the caller (`isUnclassifiedFailure`). Imports go one way, `error-facts.ts` →
  `error-map.ts`; a status read from the facts file would be the second table this package
  spent a release deleting.
- Statuses live in `error-map.ts` only. No other file writes a status number. The framework's
  table (`ERROR_STATUS`) is closed; an app declares its own codes' statuses with
  `registerErrorStatus()`, which refuses a code the framework already holds. Without that half,
  every app code was 500 and `pipeline.ts` paged the on-call for a wrong password. There is
  deliberately **no projection of the app's half**: `appErrorStatus()` was exported for "`x errors
  list` and the manifest" and neither ever called it (deleted 2026-08). It could not have worked —
  `APP_ERROR_STATUS` is process-global runtime state filled by the app's own imports, while both
  named surfaces are build artefacts derived from source, so in a CLI process it answers `{}`.
  Wiring one means deriving it from source, not re-exporting the map.
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
- **Both guards in that tail are TOTAL against a throwable that fights being read** (`As of
  2026-08`). `recoverWith`'s catch built its log line with `String(failure)`, which is itself a
  `TypeError` on a null-prototype object — thrown out of the one guard documented "never throws, by
  construction", from the frame with nothing above it. It is a log FIELD now, the same rule the
  `error-map` stage already follows, and `logger.emit` degrades a hostile field per key. The second
  half is `factsOf`: it read `record['code']` directly, and that read is a getter call or a
  `Proxy`'s `get` trap on a value the framework did not build — so a handler throwing one took the
  recover stage AND the `problem()` the guard degrades to, and `handle()` rejected. Every field
  comes off the throwable through core's `stringField`. Never spell either read inline again:
  `String(x)`, `${x}` and a bare property read on a caught value are all the same defect, and
  `error-render.ts` names seven prior instances.
- **A table keyed by a `code` is read with `Object.hasOwn`, never `[code] !== undefined`** (`As of
  2026-08`). `code` is a string off a throwable this package did not build, so `ERROR_STATUS` and
  `HTTP_ERROR_TITLES` — object literals, and therefore holders of every name on
  `Object.prototype` — answered `'toString'`, `'constructor'`, `'valueOf'` and `'hasOwnProperty'`
  with a FUNCTION. `statusFor` handed that to `new Response(body, { status })`, a `RangeError`
  raised inside `recoverWith`'s fallback, and `handle()` rejected: the same defect class as the
  reads above, arriving through a lookup instead of a property. `registerErrorStatus` had the third
  copy, refusing an app code named `toString` with a cause reading `the framework already maps it
  to function toString() { [native code] }`. `scripts/error-map.ts` reads this table correctly and
  always has. `APP_ERROR_STATUS` is a `Map`, which is why it never had the bug — prefer one for
  anything keyed by a value a caller chose.
- **`recoverWith`'s fallback is INSIDE its `try`.** `return problem(ctx.error, …)` sat beside the
  guard, so the file whose one promise is "never throws, by construction" rested on every reader
  below that line being total. The degraded answer is a literal `problem+json` document naming
  `X_INTERNAL`, built with no call that could fail in turn, and the renderer's own failure goes to
  the log as `pipeline.problem_failed` — a last resort sharing a code path with what just broke is
  not one.
- **One request spends a LIST of rate-limit keys, and the tenant's is the second** (`As of
  2026-08-24`). `rateLimitKey` picked ONE subject — actor > org > ip, exclusive — and `actorView`
  answers `null` for anonymous, so `orgId` was consulted only for a caller with an org and no id:
  **no authenticated request ever touched an org bucket**. A tenant with 8,000 seats whose
  integration entered a retry loop therefore took 8,000 × the per-actor burst against one shared
  pool, every bucket inside its own limit, and no number an operator could set would have refused
  it — while `@ultimat3/jobs` has had `perTenant` since it shipped. `rateLimitSpends` answers the
  caller's key **and** `tenant|org:<id>` when the app declared `rateLimit.tenantBucket`; the stage
  spends them in order and stops at the first refusal, so a caller its own bucket already refused
  costs its tenant nothing. The tenant key is deliberately NOT scoped to the route — a per-route
  tenant bucket is the same number multiplied by the route table, which is not a cap. `null` is
  the default because one tenant is a person and the next is five thousand seats (axiom 8), and a
  name nothing declares is `X_RATE_LIMIT_TENANT_BUCKET_UNKNOWN` at `defineHttpConfig`, never a
  silent fall-through to `default`. The headers report the bucket **closest to refusing**: telling
  a client `remaining: 99` off its own bucket while its tenant's holds 2 is a number that plans a
  caller into a 429.
- **The memory rate-limit store is bounded, and the eviction order is part of the guarantee.**
  The key falls back to the connection address (`rateLimitSpends`), so a scan rotating through an
  IPv6 /64 mints one entry per request — an unbounded map hands the flood the process. Every
  entry carries `forgetAtMs`, the instant a refilled bucket becomes indistinguishable from a
  missing one, and the sweep drops those for free. `DEFAULT_MAX_RATE_LIMIT_KEYS` is the backstop,
  and it evicts the entries **closest to full** first: throwing away a spent bucket is a free
  reset for whoever spent it, so the most-throttled key is the last one to go. Never swap that
  comparator for insertion order or an LRU — recency is not the same as worthlessness here.
- **The limiter takes a `Clock`; `Date.now()` is not read here** (`As of 2026-08-19`). `rate-limit.ts`
  read it inline while BOTH production call sites (`server.ts`, `pipeline.ts`) built their limiter
  with no override, so the bucket maths that decides whether a caller is throttled could not be
  frozen by any test — while `@ultimat3/auth`'s credential limiter has taken an injected `Clock`
  since it shipped. `createRateLimiter({ clock })` defaults to `systemClock`, the same shape as
  `createRequestContext`'s `init.clock`. Deliberately NOT a `clock` on `PipelineDeps`:
  `deps.limiter` is already the one seam for handing the pipeline a limiter you built, and a second
  entry point for one number is axiom 1.
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
- **The shared store is `postgresRateLimitStore({ executor })`, and it is what makes
  `scope: 'shared'` satisfiable** (`As of 2026-08`). Before it, `assertRateLimitScope` refused
  every store the framework shipped, so the declaration required by a chart with `replicas: 3` had no
  answer. `PgExecutor` is declared STRUCTURALLY here, exactly as `@ultimat3/action`'s idempotency
  store declares it: this package has no `@ultimat3/db` dependency, and taking one to type a single
  method would put the database package in http's install graph. The refill expression is repeated
  four times inside `on conflict do update` **on purpose** — only a direct `x_rate_limit.<column>`
  reference reads the row as it is after the lock, so a CTE computing it once would compute from
  the statement's own snapshot and lose a concurrent spend. `spent` is a stored column because the
  token count alone cannot tell a take that landed at 0.5 from a refusal with 0.5 left, and the
  invented answer would be "allowed". `purgeExpired(nowMs)` takes the CALLER's clock and never
  `now()`: `last_ms` is written from the caller's, so measuring against the server's reads the
  offset between the two as refill and deletes buckets a throttled caller is still sitting in.
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
| `error-map.ts` | the code → status table, closed, plus the app's half (`registerErrorStatus`) |
| `error-facts.ts` | every RENDERING of a throwable: `factsOf()`, the problem document, the three terminal lines |
| `hooks.ts` | the seams: `authenticate`, `authorize`, `devNotices` + the app's `configureAuthenticator()` |
| `type-pins.ts` | compile-time claims about `AuthzDecision`'s shape — source, because `tsc` never reads a `.test.ts` |
| `overlay.ts` | the dev error page: the same code/cause/fix as the terminal, plus any notices |
| `overlay-style.ts` | the overlay's one stylesheet, split out so `security-headers.ts` hashes it |
| `context.ts` | `RequestContext` + the single `Ctx` adapter (`asCtx`) + the inbound-header readers |
| `redirect.ts` | the intent slot a handler that cannot return a `Response` fills |
| `auth-redirect.ts` | where an unauthenticated browser goes, and where it comes back to |
| `cache-policy.ts` | the default `CacheHint` for a route that declared none — route AND actor |
| `rate-limit.ts` | the token-bucket maths, the store interface, the memory driver and `toBucket` |
| `rate-limit-postgres.ts` | the SHARED store: one table, one `insert … on conflict` per take, over a structural `PgExecutor` |
| `rate-limit-errors.ts` | every refusal a rate limit produces — the 429 and the six declaration faults. Split off `errors.ts` at the ceiling; the codes and titles stay there, one registry |
| `correlation.ts` | the inbound request id and trace, read before the context and the span exist |
| `forwarded.ts` | one hop-indexed reader for every header a trusted proxy writes |
| `peer-identity.ts` | Envoy XFCC -> `ctx.peer`, on that same trust rule |
| `deadline.ts` | the per-request `AbortController`, the timer and `X_TIMEOUT` |
| `csrf.ts` | the origin proof an unsafe method from a credentialed browser must carry |
| `locale.ts` | WHERE the request's locale and zone are read from — header and cookie NAMES only, plus `readCookie`. It negotiates nothing |
| `rate-limit-buckets.ts` | the one point routes and config meet: a route's own bucket, registered or refused |
| `app-config.ts` | the app's own HTTP declaration (`configureHttp`) and the layering that keeps a boot fact above it |

## Commands

```
bun test packages/http
bun run --filter @ultimat3/http typecheck
```
