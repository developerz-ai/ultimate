# @ultimat3/core — agent notes

Tier 0. **Imports no `@ultimat3/*` package except `@ultimat3/schema`** (the declared `core → schema`
edge; `schema → core` stays forbidden). Everything else depends on this, so a change here is a
change to every package.

| Rule | |
|---|---|
| Deps | `@ultimat3/schema` only (`bun-types`: types) |
| Errors | never `throw new Error`. A FRAMEWORK code: `bun run new-error-code` (a class, `CORE_CODE_TITLES` or the package's `errors.ts`, a `--status`/`--off-socket` decision, a wiki row). An APP code: `defineError()` (`define-error.ts`), which registers title, status and retry in one call and needs no wiki row; its own module, so an `UltimateError`-only chunk never retains it (`define-error-bytes.test.ts`) |
| Values in a message | `renderCauseValue()` / `renderFixLiteral()`; never raw `JSON.stringify`, `String()` or `${…}` on an `unknown` |
| A value in a `fix:` a shell READS | `renderFixShellArg(value, placeholder)` — `renderFixLiteral`'s double quotes leave `$(…)`, `` ` `` and `${…}` live. An ordinary path or URL passes through; anything a shell would read becomes the placeholder |
| Whether that value TRAVELS | `isFixShellSafe(value)`, the predicate `renderFixShellArg` is built on. A placeholder is not a runnable command, so a `fix:` whose value sits mid-command asks this first and emits PROSE when the answer is no (`@ultimat3/auth`'s `jwks.ts`, `@ultimat3/scraping`'s `profileLocked`) |
| Rendering the 3-line format | nothing to remember — `UltimateError`'s CONSTRUCTOR escapes `code`, `title`, `cause`, `fix` and `docs` with `singleLine()`. Call it yourself only for a shape this class never built (a `Finding`) |
| A value a CALLER supplied | `describeValue()` — shape, never content. `renderCauseValue` is safe against throwing, not against leaking |
| Reading a caught value | `renderThrowable()` / `isThrownError()` / `stringField()` / `failureStack()`; never `error.message`, `instanceof Error` or `typeof error.code === 'string'` |
| New code | add to `CORE_CODE_TITLES` in `core-error-codes.ts` — a side-effect anchor the barrel bare-imports, so `UltimateError` alone never carries the table |
| Where an error points | `ERROR_DOCS_URL` — one constant, never a per-code URL. `docs:` is omitted at construction and resolved from the registry |
| Time | take a `Clock`; `Date.now()` / `new Date()` only inside `clock.ts` |
| Context | never thread `ctx` as a parameter — `useContext()` |
| A value ambient across an `await` | `asyncContext<T>(subject)` from `async-context.ts`, in **every** package — never `new AsyncLocalStorage` |
| Exports | explicit in `src/index.ts`; no `export *`. FIVE public subpaths (`./page`, `./outbound`, `./redis`, `./render-node`, `./render-nodes`), one INTERNAL (`./internal/error-status`); nothing that constructs an error joins `./page` (`page-bundle.test.ts`, 1.5 kB). `./page` is what a browser client imports — `@ultimat3/action`'s `client.ts` and error modules read it, never the barrel; the barrel itself must build for a browser with no warning (no static `node:` import a polyfill lacks — `image/png-pixels.ts` resolves `node:zlib` at the call). Full rule: `docs/history/core.md` |
| Files | < 200 LOC, 500 hard ceiling, one responsibility, `kebab-case.ts`, test beside source |
| Type claims | `type-pins.ts`, never a `.test.ts` — `tsconfig.json` excludes tests |

Deliberate cycle (safe — nothing referenced at module evaluation): `errors.ts ⇄ error-codes.ts`. No
top-level `UltimateError` use in `error-codes.ts`.

## Invariants

- **`async-context.ts` is the framework's ONE `AsyncLocalStorage`.** Construction is deferred to
  the first `get()`/`run()`, so a browser bundle can evaluate the module; reads degrade to
  `undefined`, writes throw `X_ASYNC_CONTEXT_UNAVAILABLE`. `scripts/async-context-guard.ts` refuses a
  `new AsyncLocalStorage` or an import of the class anywhere else; `scripts/browser-barrel.test.ts`
  covers `await import('node:async_hooks')`.
- **`error-render.ts` imports nothing** except schema's re-exports (`describeValue`, `charCount`) —
  an error factory that dies formatting its own message is the failure it exists to prevent.
  `scripts/error-render.ts` (`X_ERROR_RENDER_UNSAFE`) cannot see a value laundered through a local
  helper.
- **`singleLine` keeps the 3-line contract to three lines, applied in the CONSTRUCTOR** so every
  door (`format()`, `.message`, `.cause`, `toJSON()`) is covered once. It touches only C0 controls
  and DEL — a cause keeps its quotes and backslashes. `@ultimat3/schema` carries a deliberate
  duplicate, pinned by `single-line-pin.test.ts` HERE, with `ERROR_DOCS_URL`. The brand symbol is
  NOT a copy: `ULTIMATE_ERROR_BRAND` is schema's one declaration, imported by `errors.ts`.
- **`core → schema` is declared: import a schema value, never copy it.** Bundle cost:
  `docs/architecture/01-package-map.md`; it depends on `@ultimat3/schema` keeping `sideEffects: false`.
- **A string's length is CODE POINTS** — `validators.ts` rejects in that unit and
  `json-schema.ts` publishes `minLength` in it. `parseId`/`uuidTimestamp` describe a rejected id and
  never echo it: a value baked into a message has no log field key to redact.
- **A test never patches `process.stdout` to read a log line**: `setLogSink(sink)` is the seam, and the
  test preloads install one that drops every line (`LOG_LEVEL` named = not installed). It decides
  WHERE a line goes, never whether — the level is untouched.
- `logger.ts` must not import `context.ts` (`context.ts` injects ids via `setLoggerContextFields()`).
  It imports `secret.ts` one way only: `secret.ts` owns `REDACTED`, `logger.ts` re-exports it.
- **`ActorFacts` is the app's extension point on `Actor`** (module augmentation). Core never declares
  a fact; every fact reads `T | undefined` through `actorFact()` so an unresolved fact denies.
  `type-pins.ts` pins the shape.

| Concept | Owner | Note |
|---|---|---|
| which deploy this is | `environment.ts` (`ULTIMATE_ENV`) | the twin of `ROLE`; never a second env var |
| one-home helpers | `store-mode` `html-escape` `cookie` `fnv1a` `pg-executor` `deprecation` `aws-sigv4` | never copied (`X_HELPER_COPY`). Rows here: `docs/history/core.md` |
| the ONE keyed hash | `hmac.ts` (`hmac(alg, key, data, encoding?)`) | `node:crypto`'s `createHmac`: a keyed `Bun.CryptoHasher` throws a stale failed-EC-import error (Bun 1.4.4). `bun run keyed-hasher` (`X_KEYED_HASHER`) |
| this process's job | `roles.ts` (`ROLE`) | |
| `allowHosts` | `host-rules.ts` | a wildcard admits no inward literal, no `localhost`/`*.localhost`; exact rules do |
| how a route renders, caches offline and hydrates | `route-vocabulary.ts` (`RENDER_MODES`, `OFFLINE_STRATEGIES`, `HYDRATE_STRATEGIES`) | every union is `(typeof ARRAY)[number]`, pinned in `type-pins.ts`; `scripts/render-modes.test.ts` refuses a second declaration. Re-export it, never restate it |
| which of two route patterns wins a pathname | `route-rank.ts` (`routeRank`) | the request router's order as one integer: segment by segment, literal 3 > `:param` 2 > `*catch-all` 1, ENDED 4, packed base 5 over 22 segments |
| an `http.path` template (`/orders/:id`) | `route-path-template.ts` (pure, also on `./page`) + `route-path-merge.ts` (`mergePathParams`, `X_HTTP_PATH_INPUT_CONFLICT`) | `action` and `query` both pin one and share a tier; never a copy in either |
| `errors:` | `declared-errors.ts`, `-openapi.ts`, `-scan.ts` | ONE copy for `action` and `query`. The HTTP status is passed in (`ErrorStatusOf`): http is above core. The scan is test-time only |
| a session's loss, an island's poll | `session-lost.ts` (`noteRefusal`, called by `client-dispatch.ts`; a cell on the page handle, cleared by `rescope()`), `visible-interval.ts` (the ONE poll an island takes) | both on `./page`, pinned by `page-bundle.test.ts` |
| which rungs a cache ladder has | `cache-vocabulary.ts` (`CACHE_TIERS`) | `@ultimat3/cache`'s read order, imported (no `TIER_ORDER` alias). `isr` is a `RenderMode`, never a tier |
| which build of the APP this is | `app-version.ts` (`APP_VERSION`) | one reader, `dev` by default |
| the values | `env.ts` | `checkEnv().values` holds REAL secrets — printing goes through `maskedEnvValues()` |
| `.env.example` | `env-example.ts` | a projection of the schema, never hand-maintained |
| loading `.env` | **Bun**, not us | `envFileCandidates()` documents the measured order; there is no `.env.staging` |
| how long to wait, and whether to wait at all | `backoff.ts` + `retry-loop.ts` + `retry.ts` | one curve, one loop (no context, for `client-flight.ts`), one executor over it that reads the ambient signal and deadline: the ONE place a loop meets its caller's lifetime, `runToCompletion` the one way out; `jitter` is REQUIRED on a retry policy and defaults to `none` on the arithmetic. `attempt` is 1-based |
| N callers on one key | `single-flight.ts` | identity-checked eviction, optional injected deadline, optional injected `signal`: a live joiner re-leads after its leader's abort. Reads no context |
| how many at once | `flight-gate.ts` | hand-over on release, refusal past `maxQueued`, injectable `overflow:` refusal |
| whether an answer still applies | `generation-fence.ts` | `X_SUPERSEDED` / `isSuperseded` |
| which HTTP statuses are worth repeating | `retryable-status.ts` | `>= 500` plus 408, 409, 425, 429 |
| how long this request has left | `request-budget.ts` (`Ctx.deadlineAt`, `REQUEST_TIMEOUT_HEADER`) | `@ultimat3/http`'s `startDeadline` is the one writer of the instant; `traceHeaders()` the one writer of the header. A spent budget sends nothing, never `0` |
| the above, composed into one typed-client call | `client-flight.ts` + `client-wire.ts` | shared by `@ultimat3/action` and `@ultimat3/query` (both tier 3), re-exported by both. Declares no code of its own. A gate slot per ATTEMPT; the wait holds none, ends on `bump()` or the caller's abort |
| a stream-declaring action, read in the browser | `client-stream.ts` | `clientStream`: `POST` with `accept: text/event-stream` through `client-dispatch.ts`'s `dispatchStream` (the ONE browser `fetch`; body handed back unread), never `EventSource` (cannot POST, skips the credentials rule); `clientTransport`'s credentials, headers, caller's signal, session fence and problem decode; a `chunk` frame yields, `done` returns, `error` throws its problem at its own status. A JSON answer is `clientTransport`'s `settleAnswer` (envelope, records, dates), so `stream()` and `call()` agree. Never retried |
| the browser's one HTTP function, records envelope, per-tab handle and principal fence | `client-transport.ts`, `client-dispatch.ts`, `client-problem.ts`, `client-retry-after.ts`, `client-paths.ts`, `record-envelope.ts`, `record-sink.ts`, `client-scope.ts` | `pageClient()` is the ONE `globalThis` write (`Symbol.for('ultimate.client')`); `clientTransport` never value-imports `clientFlight` or `traceHeaders()` (the OUTBOUND SLOT, `outbound-headers.ts`). A write never dedupes. Full rule: `docs/history/core.md` |
| a write's public name | `write-digest.ts` (`writeDigest`, `isWriteDigest`, also on `./page`) + `write-origin.ts` (`withWriteOrigin`, `currentWriteOrigin`, `WRITE_ORIGIN_WAL_PREFIX`, server-only) | SHA-256 of an idempotency key, 32 hex; carried action → entity → WAL → realtime `records` frame. A malformed value runs the work unnamed: a label, never a gate |
| which row survives a conflict | `conflict-policy.ts` (`ConflictPolicy`, `resolveConflict`, `Row`) | read by `action`'s mutator and `realtime`'s rebase |
| where a visitor's light/dark choice is stored | `theme-storage.ts` (`THEME_STORAGE_KEY`, also on `./page`) | render's boot script reads it, ui's toggle writes it — both tier 4, so the one literal lives here. Persisted in browsers: never respelled |
| the four shapes of an async region | `async-state.ts` (`AsyncState`) | `realtime` returns it, `ui` renders it. `bun run render-modes` refuses a second status union sharing three members |
| the audit record + one sink | `audit.ts` | `action` + `query`; `AUDIT_RECORD_FIELDS` pins both |
| gate shapes | `gate-shapes.ts` | shared by `action` and `query`: the audit outcome, the rate-limit subject/scope/limit. One copy, never one per primitive |
| is this `unknown` a keyed record? | `json-object.ts` (`isJsonObject`) | narrows a shape; does not certify provenance |
| may a caller read this 5xx `cause`? | `public-cause.ts` (`hasPublicCause`) | one table for http, mcp, ai. `registerPublicCause` is `@ultimat3/http`'s `registerProblemMeta` writing it — never an app's door |
| is this field a credential? | `logger.ts` (`isRedactedKey`) | exact keys + `CREDENTIAL_NAME`; a bare `token` suffix is NOT one (`idempotencyToken`, `maxTokens`). Log line, monitor envelope and `action`'s audit ask it |
| a value that must not be printed | `secret.ts` | redacted by VALUE; `revealSecret()` is the one, greppable, way out |
| an `Intl` formatter cache, and the screen in front of it | `intl-cache.ts` (`cachedFormatter`, `canonicalLocale`, `assertLocale`, `MAX_CACHED_FORMATTERS`, `MAX_LOCALE_EXCERPT`) | a locale arrives from a header: refuse a non-tag (`X_LOCALE_INVALID`), key canonically AND bound the cache — never a copy of any of the three. |
| the text direction of a locale | `locale-direction.ts` (`directionOf`, `isRtl`, `Direction`) | import from here, never `@ultimat3/i18n`; here so `@ultimat3/ui` skips the i18n barrel |
| the committed encrypted values | `secrets.ts` (envelope) + `secrets-store.ts` (files, `installSecrets`) | plaintext is a flat map of ENV NAMES; there is no `secrets.get()` |
| ONE sealed value | `seal.ts` (`seal`, `open`, `openText`, `sealAll`) + `seal-keys.ts` (the ring) + `seal-errors.ts` | the framework's one AES call above the envelope: `entity`'s sealed column and `scraping`'s stored session call it, never WebCrypto. `purpose` is required and is AAD |
| one outbound HTTP call | `outbound.ts` + `outbound-attempt.ts` / `-hops.ts` / `-read.ts` / `-dial.ts` / `-errors.ts` / `-types.ts`, entry `outbound-subpath.ts` | never on the barrel (`outbound-subpath.test.ts`). `retry()` owns the clamp to `ctx`, so no second clamp. Its ten codes register their retry class in `outbound-errors.ts`, NOT `error-retry.ts`'s table, which rides every page. `screenDial` holds the framework's one `Bun.dns.lookup` |
| is a dependency down | `breaker.ts` | the machine only; the trigger is `classify` or a hand-called `failed()`. Every settle takes the `admit()` ticket. `X_BREAKER_OPEN` registers its class here |
| what an element carries, for a test | `render-nodes.ts` (`renderNodes`, `nodesOf`, selectors) + `render-node.ts` (`JSX_NODE`, `ISLAND_NODE`, `HOLE_NODE`) | the one walker: `ui`, `admin` and apps import the subpath, never a copy. Islands and holes are branded ARRAYS, tested before `Array.isArray`; a hole is walked as `fallback` and `error`, never its deferred `children` |

- **`installSecrets()` is the ONLY path from `secrets.enc.json` to an app value**, landing in
  `process.env` before `defineEnv` reads it. The real environment always wins.
- **`intl-cache.ts`'s bound and canonical key are two halves of one rule** and live in one file:
  validating and keying are one `getCanonicalLocales` call. Never build an `Intl` formatter on a
  caller string without both.
- **`secrets-errors.ts`'s command lines are screened** (`renderFixShellArg`; a bad variable name degrades to prose). Full rule: `docs/history/core.md`.
- **`seal.ts` adds no variable for the CURRENT key** (`findMasterKey()`). The wire form `x1.<keyId>.<iv>.<ciphertext+tag>` and the AAD string are persisted data: a change is `x2`, never an edit. Full rule: `docs/history/core.md`.
- **`schema-error-codes.ts` registers `@ultimat3/schema`'s codes** (schema cannot call core), and
  derives their retry classification from the same set. It is a `SIDE_EFFECTS_ANCHORS` entry.
- **`canonical-json.ts`: `canonicalJson` is INJECTIVE and `fingerprint` is SHA-256/16 of it** — the
  hash every in-memory sharing key is taken over (`query`'s `queryHash`, `realtime`'s `qid`).
  `NaN`, `±Infinity` and `-0` are bare tokens; `Date`, `Map` and `Set` are TAGGED. Never a
  fourth copy, never parseable (`@ultimat3/action`'s `stableStringify` is the document form).
- **A PERSISTED fingerprint is `keyedFingerprint`** (`keyed-fingerprint.ts`: HMAC under a per-purpose
  key derived from the cursor secret, `h1:` versioned) — `action`'s idempotency `requestHash`. An
  unkeyed prefix in a table is an offline oracle for a short account number in the input.
- **`decimal-order.ts`'s `compareDecimalText` answers `undefined` for a non-decimal**, and only a
  caller that knows the column's kind may ask (`@ultimat3/entity`'s `compareByKind`) — never
  `@ultimat3/query`, whose `OrderKey` has no kind.
- **The flight layer** (`backoff.ts`, `retry-loop.ts`, `retry.ts`, `single-flight.ts`, `flight-gate.ts`,
  `generation-fence.ts`, `retryable-status.ts`, `client-flight.ts`, `client-wire.ts`) imports
  nothing but this package, runs nothing at import, and injects every source of non-determinism
  (roll, sleep, clock, timer). `classifyThrown` / `statedDelayMs` live beside `error-retry.ts`'s table.
- **`finiteOption` / `finiteCount` (`finite-option.ts`) are the framework's ONE screen for a numeric
  option.** `finiteCount(subject, option, value, min)` takes `min: 0 | 1` because only the caller
  knows what zero means. `bun run finite-bounds` recognises a repair by the call's shape, so a
  package screen carries `Finite` in its name.
- **`mcp-exposure.ts`'s `isMcpExposed` is the ONE answer to "did this opt into MCP?"**, read by
  `action`, `query`, `mcp`, `ai`, `manifest`. `@ultimat3/cli`'s `mcp-exposure-pin.test.ts` checks
  it; `isAgentOffered` adds `agents: true`; `@ultimat3/admin`'s own catalog is the one opt-OUT exception (`mcp-tools.ts`).

## Metrics, tracing, reporting

`metrics.ts`: counters (spans are `telemetry.ts`), always on, no-op exporter by default.
`runtime-metrics.ts` alone names a series the chart reads (`http_requests_total`, `connections`,
`queue_depth`), keyed by `ScalingSignal` in `SCALING_METRICS`. `process-metrics.ts`: `process_*`
(resident memory, heap, external, CPU seconds, event-loop lag, start time, `process_info{role}`);
server-only, never on `page.ts`. One call site per recorder; a second is the bug:

| Recorder | The one caller |
|---|---|
| `recordRequest` | `@ultimat3/http` `pipeline.ts`, the `finally` around `execute` |
| `recordConnection` | `@ultimat3/realtime` `socket.ts`, `SocketRegistry.add`/`remove` |
| `recordQueueDepth` | `@ultimat3/jobs` `worker.ts`, throttled inside `tick()` |
| `recordJob` | `@ultimat3/jobs` `worker.ts`, the outcome branch inside `tick()` (`JOB_OUTCOME_LABELS` drops `suspended`) |
| `recordLeaseLost` | `@ultimat3/jobs` `heartbeat.ts`, once per lapsed lease |
| `recordBreakerTransition` | `breaker.ts`, on every state change |

- **One bus, `instrument.ts`**: every observer is a `subscribe()` — OTLP spans (`span.end`, sampled
  only), logs (`log.record`), metrics. No `set*Observer`/`set*Sink`/`recent*()` slot
  (`X_INSTRUMENT_SLOT_FORBIDDEN`). Sampler reads `OTEL_TRACES_SAMPLER*` at the first span.
- **An empty `spanId` means "no inbound decision"** — `startSpan` narrows through
  `inboundParent()`, carrying the trace id and never the synthesised sampling bit.
- The OTLP exporters are built, not wrapped ([`docs/idea/18-build-vs-wrap.md`](../../docs/idea/18-build-vs-wrap.md)).
  `otlpTraceRequest` / `otlpMetricsRequest` are pure. **gRPC (`:4317`) is out of scope**:
  `X_OTLP_PROTOCOL_UNSUPPORTED` names `:4318`; a boot that must not throw asks `tryOtlpEndpoint(signal)`.
- **`postOtlp` (`otlp-post.ts`) retries `OTLP_RETRY_STATUSES` and a transport failure only**, never `isRetryableStatus`. Full rule: `docs/history/core.md`.
- **`errorFingerprint` (`error-fingerprint.ts`) is a function, never an `ErrorReport` field**:
  `code`, `source`, `scope.operation`, plus the top app frame for `X_INTERNAL` only. Never `cause`,
  `meta`, ids or `release`. Total over hostile getters; the Sentry envelope's `fingerprint`.
- **Failure capture is OFF by default** (`config-failure-capture.ts`, `failureCapture.enabled`;
  `x dev` forces it on): with no `FailureStore` installed nothing allocates. The OUTER
  `invoke`/`runQuery` opens one buffer (`withFailureCapture`, `failure-capture.ts`); seams record
  into it (`recordFailureFact`: entity reads, flag answers), masked and path-listed by
  `captureValue` (`failure-capture-mask.ts`). A 5xx HOLDS the buffer on the thrown value, a 4xx
  never; `reportError` releases it keyed by `errorFingerprint` over the same report
  (`failure-capture-flush.ts`). Caps: `perHour` 5 per fingerprint per process, `maxRows` 50,
  `maxBytes` 64 KiB — past one, stored `truncated`. A refused save is a log line, never awaited.
- **Three OTLP variables, three codes** — `X_OTLP_ENDPOINT_INVALID`, `X_OTLP_HEADERS_INVALID`,
  `X_OTLP_PROTOCOL_UNSUPPORTED`. A header KEY is in the cause/fix/meta; its VALUE never is.
- **A cause is cut at 4 KiB in the constructor** (`boundedCause`); schema's copy is pinned by `single-line-pin.test.ts`.
- `error-reporter.ts`: `ErrorReporter`, no-op default, memory reporter for tests, Sentry transport (`error-reporter-sentry.ts`, optional export). Full rule: `docs/history/core.md`. `'browser'`: only cli's `client-errors-routes.ts`, one `X_CLIENT_ERROR` per report.
- `METRICS_PATH` is served by `@ultimat3/cli`'s `metrics-endpoint.ts` on `METRICS_PORT` (9090), never
  the role's HTTP port; every role opens it.

## Lifecycle and readiness

- `markReady()` means **bound**; readiness means **usable** — `registerReadinessCheck(name, check)`. Full rule: `docs/history/core.md`.
- **`drain()`'s memo is published BEFORE the first hook runs** — a hook may re-enter `drain()`
  (`@ultimat3/http`'s `handle.stop()`), and `settleWithin` invokes hooks synchronously.
- **The drain deadline is enforced** (`lifecycle-deadline.ts`): a hook overrunning the whole drain's budget is abandoned and logged (`X_SHUTDOWN_TIMEOUT`); real monotonic time, never the injected `clock`. Full rule: `docs/history/core.md`.
- **An exit after a drain is `drainExitCode()`** — 70 when work was abandoned (`X_SHUTDOWN_TIMEOUT`), else 0. Never a literal `process.exit(0)`.
- **`close` hooks run last-registered first; the other phases as registered** (`runPhase`). No fourth phase.
- **Who a health endpoint tells what is ONE rule, here** (`health-disclosure.ts`): `healthBody` +
  `healthPeerListed`, called by http and by realtime's sync listener. Never a second copy.
- **An address answers two questions** (`address-class.ts`): `classifyAddress` is where a DIAL lands
  and reads through every embedded IPv4; `peerAddressClass` is what a CALLER or a local name may be
  trusted as, and a transit form (`2002:7f00:1::`, `64:ff9b::7f00:1`) is never loopback there. A
  check that grants something asks the second. Unmechanised: review catches a new `=== 'loopback'`.
- **A readiness grace runs before the `accept` phase** (`lifecycle-grace.ts`), ADDED to `deadlineMs`. Full rule: `docs/history/core.md`.
- **`abandonment()`: a branded abort reason refuses writes** (`@ultimat3/db`); **`runToCompletion(fn)` is the one escape**, built by `derivedContext`. `run-to-completion.test.ts`.
- `impersonate(actor, reason, fn)` is the ONE door through `withChildContext({ actor })`; it stamps
  `Actor.onBehalfOf` so `actorLabel` renders `service:eng-7→user:cust-99@org-3`. No second path.
- Every `UltimateError` carries `retry` (`terminal | retryable | retry-after`), **defaulting to `terminal`**. Full rule: `docs/history/core.md`.
- `PRIMITIVE_KINDS` is the executable eight-primitive rule; `PrimitiveKind` derives from it and
  `registrar.test.ts` fails on a ninth. `PRIMITIVE_FACTORIES` lists the factories.

```bash
bun test packages/core/src    # from the REPO ROOT, never from packages/core
bun run typecheck
```

The root is load-bearing: Bun reads `bunfig.toml` (its preload installs `@ultimat3/testing`'s
matchers) from the cwd.

Gotchas (`exactOptionalPropertyTypes`, `Ctx`'s index signature, registry resets, `onShutdown`'s unregister, cursor-secret restore): [`docs/history/core.md`](../../docs/history/core.md#moved-out-2026-11-03-plan-101-wave-3-the-claudemd-ceiling).

Why each rule above is shaped the way it is: [`docs/history/core.md`](../../docs/history/core.md).
- `drain-deadline.ts` also owns `WORKER_RETIRE_DEFAULT_MS` and `workerRetireIssue`.
