# @ultimat3/core — agent notes

Tier 0. **Imports no `@ultimat3/*` package except `@ultimat3/schema`** (the declared `core → schema`
edge; `schema → core` stays forbidden). Everything else depends on this, so a change here is a
change to every package. A row or rule marked `†` has its full text in
[`docs/history/core-rules.md`](../../docs/history/core-rules.md).

| Rule | |
|---|---|
| Deps | `@ultimat3/schema` only (`bun-types`: types) |
| Errors | never `throw new Error`. Framework code: `bun run new-error-code`; app code: `defineError()` (`define-error.ts`) † |
| Values in a message | `renderCauseValue()` / `renderFixLiteral()`; never raw `JSON.stringify`, `String()` or `${…}` on an `unknown` |
| A value in a `fix:` a shell READS | `renderFixShellArg(value, placeholder)` — `renderFixLiteral`'s double quotes leave `$(…)`, `` ` `` and `${…}` live. An ordinary path or URL passes through; anything a shell would read becomes the placeholder |
| Whether that value TRAVELS | `isFixShellSafe(value)`; a value that does not travel makes the `fix:` prose, never a placeholder mid-command † |
| Rendering the 3-line format | nothing to remember — `UltimateError`'s CONSTRUCTOR escapes `code`, `title`, `cause`, `fix` and `docs` with `singleLine()`. Call it yourself only for a shape this class never built (a `Finding`) |
| A value a CALLER supplied | `describeValue()` — shape, never content. `renderCauseValue` is safe against throwing, not against leaking |
| Reading a caught value | `renderThrowable()` / `isThrownError()` / `stringField()` / `failureStack()`; never `error.message`, `instanceof Error` or `typeof error.code === 'string'` |
| New code | add to `CORE_CODE_TITLES` in `core-error-codes.ts` — a side-effect anchor the barrel bare-imports, so `UltimateError` alone never carries the table |
| Where an error points | `ERROR_DOCS_URL` — one constant, never a per-code URL. `docs:` is omitted at construction and resolved from the registry |
| Time | take a `Clock` (a `SleepClock` to wait); `Date.now()` / `new Date()` only in `clock.ts`; a waiting timer only in `sleep-clock.ts` |
| Context | never thread `ctx` as a parameter — `useContext()` |
| A value ambient across an `await` | `asyncContext<T>(subject)` from `async-context.ts`, in **every** package — never `new AsyncLocalStorage` |
| Exports | explicit in `src/index.ts`; no `export *`. Six public subpaths (`./adapter`, `./page`, `./outbound`, `./redis`, `./render-node`, `./render-nodes`), one internal (`./internal/error-status`); nothing that loads a titles table joins `./page` (`page-bundle.test.ts`); an app imports `defineError` there (`define-error-bytes.test.ts`) † |
| Files | < 200 LOC, 500 hard ceiling, one responsibility, `kebab-case.ts`, test beside source |
| Type claims | `type-pins.ts`, never a `.test.ts` — `tsconfig.json` excludes tests |

Deliberate cycle (safe — nothing referenced at module evaluation): `errors.ts ⇄ error-codes.ts`. No
top-level `UltimateError` use in `error-codes.ts`.

## Invariants

- **`async-context.ts` is the framework's ONE `AsyncLocalStorage`** (`scripts/async-context-guard.ts`). †
- **`error-render.ts` imports nothing** except schema's re-exports (`describeValue`, `charCount`) —
  an error factory that dies formatting its own message is the failure it exists to prevent.
  `scripts/error-render.ts` (`X_ERROR_RENDER_UNSAFE`) cannot see a value laundered through a local
  helper.
- **`singleLine` keeps the 3-line contract to three lines, applied in the CONSTRUCTOR.** †
- **`core → schema` is declared: import a schema value, never copy it.** Bundle cost:
  `docs/architecture/01-package-map.md`; it depends on `@ultimat3/schema` keeping `sideEffects: false`.
- **A string's length is CODE POINTS** — `validators.ts` rejects in that unit and
  `json-schema.ts` publishes `minLength` in it. `parseId`/`uuidTimestamp` describe a rejected id and
  never echo it: a value baked into a message has no log field key to redact.
- **A test never patches `process.stdout` to read a log line**: `installLogSink(sink)` is the seam
  — on the `.` barrel, a test seam and not a port (`scripts/lib/adapter-port-pins.ts`); a stack,
  `finally` releases; preloads install one that drops lines (`LOG_LEVEL` named = none).
  WHERE a line goes, never whether: the level is untouched.
- `teeLogLines(tee)` adds a COPY of every process-logger line beside the streams (a set, each release its own; a throwing tee loses only its copy) — `x dev`'s `dev.log`.
- `logger.ts` must not import `context.ts` (`context.ts` injects ids via `setLoggerContextFields()`).
  It imports `secret.ts` one way only: `secret.ts` owns `REDACTED`, `logger.ts` re-exports it.
- **`ActorFacts` is the app's extension point on `Actor`** (module augmentation). Core never declares
  a fact; every fact reads `T | undefined` through `actorFact()` so an unresolved fact denies.
  `type-pins.ts` pins the shape.

| Concept | Owner | Note |
|---|---|---|
| which deploy this is | `environment.ts` (`ULTIMATE_ENV`) | the twin of `ROLE`; never a second env var |
| every env name the framework reads | `framework-env.ts` (`FRAMEWORK_ENV`) | a literal env read missing from it is red: `bun run scripts/framework-env.ts` (`X_FRAMEWORK_ENV_UNREGISTERED`) |
| one-home helpers | `store-mode` `html-escape` `cookie` `fnv1a` `pg-executor` `deprecation` `aws-sigv4` `der` | never copied (`X_HELPER_COPY`). Rows here: `docs/history/core.md` |
| an X.509 certificate's public key | `der.ts` (`x509Spki(der)`) | the ONE DER walk to the `subjectPublicKeyInfo` Web Crypto imports: auth's SAML key and mail's SNS key both read it; trailing bytes refused |
| the ONE keyed hash | `hmac.ts` (`hmac(alg, key, data, encoding?)`) | `bun run keyed-hasher` (`X_KEYED_HASHER`) † |
| this process's job | `roles.ts` (`ROLE`) | |
| `allowHosts` | `host-rules.ts` | a wildcard admits no inward literal, no `localhost`/`*.localhost`; exact rules do |
| which surface a route lives on, how it renders, caches offline and hydrates | `route-vocabulary.ts` (`SURFACES`, `RENDER_MODES`, `OFFLINE_STRATEGIES`, `HYDRATE_STRATEGIES`) | every union is `(typeof ARRAY)[number]`, pinned in `type-pins.ts`; `scripts/render-modes.test.ts` refuses a second declaration. Re-export it, never restate it; `@ultimat3/render` re-exports the `Surface` type only, never `SURFACES` (`X_HELPER_COPY`) |
| which of two route patterns wins a pathname | `route-rank.ts` (`routeRank`) | the request router's order as one integer: segment by segment, literal 3 > `:param` 2 > `*catch-all` 1, ENDED 4, packed base 5 over 22 segments |
| an `http.path` template (`/orders/:id`) | `route-path-template.ts` (pure, also on `./page`) + `route-path-merge.ts` (`mergePathParams`, `X_HTTP_PATH_INPUT_CONFLICT`) | `action` and `query` both pin one and share a tier; never a copy in either |
| `errors:` | `declared-errors.ts`, `-openapi.ts`, `-scan.ts` | ONE copy for `action` and `query`. The HTTP status is passed in (`ErrorStatusOf`): http is above core. The scan is test-time only |
| a session's loss, an island's poll | `session-lost.ts`, `visible-interval.ts` | the ONE poll an island takes; both on `./page` † |
| which rungs a cache ladder has | `cache-vocabulary.ts` (`CACHE_TIERS`) | `@ultimat3/cache`'s read order, imported (no `TIER_ORDER` alias). `isr` is a `RenderMode`, never a tier |
| which build of the APP this is | `app-version.ts` (`APP_VERSION`) | one reader, `dev` by default |
| the values | `env.ts` | `checkEnv().values` holds REAL secrets — printing goes through `maskedEnvValues()` |
| `.env.example` | `env-example.ts` | a projection of the schema, never hand-maintained |
| loading `.env` | **Bun**, not us | `envFileCandidates()` documents the measured order; there is no `.env.staging` |
| how long to wait, and whether to wait at all | `backoff.ts` + `retry-loop.ts` + `retry.ts` | one curve, one loop, one executor that meets the caller's signal and deadline; `jitter` REQUIRED on a retry policy; `attempt` is 1-based † |
| N callers on one key | `single-flight.ts` | identity-checked eviction, optional injected deadline, optional injected `signal`: a live joiner re-leads after its leader's abort. Reads no context |
| a lazy boot or load, once per process | `retry-memo.ts` (`retryMemo`) | a rejection is never the memo's answer; never `x ??= start()` for a promise |
| how many at once | `flight-gate.ts` | hand-over on release, refusal past `maxQueued`, injectable `overflow:` refusal |
| a fan-out with a bound | `map-bounded.ts` (`mapBounded`) | `width` REQUIRED, no default; input order; first rejection aborts the rest via the signal. Never a hand-rolled worker pool |
| whether an answer still applies | `generation-fence.ts` | `X_SUPERSEDED` / `isSuperseded` |
| which HTTP statuses are worth repeating | `retryable-status.ts` | `>= 500` plus 408, 409, 425, 429 |
| how long this request has left | `request-budget.ts` (`Ctx.deadlineAt`) | http's `startDeadline` writes the instant, `traceHeaders()` the header † |
| the above, composed into one typed-client call | `client-flight.ts` + `client-wire.ts` | shared by `action` and `query`, re-exported by both; a gate slot per ATTEMPT † |
| a stream-declaring action, read in the browser | `client-stream.ts` | `clientStream`: `POST` + `accept: text/event-stream`, never `EventSource`. Full rule: `docs/history/core-moved-2026-11-09.md` |
| the browser's one HTTP function and per-tab handle | `client-transport.ts`, `client-dispatch.ts`, `client-*.ts`, `record-envelope.ts`, `record-sink.ts` | `pageClient()` is the ONE `globalThis` write. A write never dedupes † |
| a write's public name | `write-digest.ts` + `write-origin.ts` (server-only) | SHA-256 of an idempotency key: a label, never a gate † |
| which row survives a conflict | `conflict-policy.ts` (`ConflictPolicy`, `resolveConflict`, `Row`) | read by `action`'s mutator and `realtime`'s rebase |
| where a visitor's light/dark choice is stored | `theme-storage.ts` (`THEME_STORAGE_KEY`, on `./page`) | persisted in browsers: never respelled † |
| the four shapes of an async region | `async-state.ts` (`AsyncState`) | `realtime` returns it, `ui` renders it. `bun run render-modes` refuses a second status union sharing three members |
| the audit record + one sink | `audit.ts` | `action` + `query` read `getAuditSink()`; the boot installs (`installAuditSink`, `./adapter`); `AUDIT_RECORD_FIELDS` pins both |
| gate shapes | `gate-shapes.ts` | shared by `action` and `query`: the audit outcome, the rate-limit subject/scope/limit. One copy, never one per primitive |
| is this `unknown` a keyed record? | `json-object.ts` (`isJsonObject`) | narrows a shape; does not certify provenance |
| may a caller read this 5xx `cause`? | `public-cause.ts` (`hasPublicCause`) | one table for http, mcp, ai. `registerPublicCause` is `@ultimat3/http`'s `registerProblemMeta` writing it — never an app's door |
| is this field a credential? | `logger-redact.ts` (`isRedactedKey`) | exact keys + `CREDENTIAL_NAME`; a bare `token` suffix is NOT one (`idempotencyToken`, `maxTokens`). Log line, monitor envelope and `action`'s audit ask it; verdict memoised per key, 4,096, cleared by `redactKeys` |
| a value that must not be printed | `secret.ts` | redacted by VALUE; `revealSecret()` is the one, greppable, way out |
| an `Intl` formatter cache, and the screen in front of it | `intl-cache.ts` | refuse a non-tag (`X_LOCALE_INVALID`), key canonically, bound the cache — one file † |
| the text direction of a locale | `locale-direction.ts` (`directionOf`, `isRtl`, `Direction`) | import from here, never `@ultimat3/i18n`; here so `@ultimat3/ui` skips the i18n barrel |
| the committed encrypted values | `secrets.ts` (envelope) + `secrets-store.ts` (files, `installSecrets`) | plaintext is a flat map of ENV NAMES; there is no `secrets.get()` |
| ONE sealed value | `seal.ts` + `seal-keys.ts` + `seal-errors.ts` | the framework's one AES call above the envelope; `purpose` is required and is AAD † |
| one outbound HTTP call | `outbound*.ts`, entry `outbound-subpath.ts` | never on the barrel; `screenDial` holds the one `Bun.dns.lookup` † |
| retries as a share of calls | `breaker-retry-budget.ts` (`retryBudgetOf`) | per breaker key: a call earns 1, a retry costs 5 (≤ 20%), burst 10; a refused retry answers the last error |
| is a dependency down | `breaker.ts` | the machine only; the trigger is `classify` or a hand-called `failed()`. Every settle takes the `admit()` ticket. `X_BREAKER_OPEN` registers its class here |
| where a raster transform runs | `image/raster-pool.ts` + `raster-worker.ts` + `raster-wire.ts` | one lazy Worker; inline only where none starts (one warn), the web role then held to `RASTER_SYNC_PIXELS` (`X_IMAGE_RASTER_BUDGET`). A compile that bundles core adds `rasterWorkerBundle()` (`raster-worker-bundle.ts`). Never `transformInline` on a request path |
| what an element carries, for a test | `render-nodes.ts` + `render-node.ts` | the one walker, imported from the subpath, never copied † |

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
  hash form; `@ultimat3/action`'s `stableStringify` is the document form. †
- **A PERSISTED fingerprint is `keyedFingerprint`** (`keyed-fingerprint.ts`: HMAC under a per-purpose
  key derived from the cursor secret, `h1:` versioned) — `action`'s idempotency `requestHash`. An
  unkeyed prefix in a table is an offline oracle for a short account number in the input.
- **`decimal-order.ts`'s `compareDecimalText` answers `undefined` for a non-decimal**, and only a
  caller that knows the column's kind may ask (`@ultimat3/entity`'s `compareByKind`) — never
  `@ultimat3/query`, whose `OrderKey` has no kind.
- **The flight layer** imports nothing but this package, runs nothing at import, injects every
  source of non-determinism. †
- **`finiteOption` / `finiteCount` (`finite-option.ts`) are the framework's ONE screen for a numeric option.** Full rule: `docs/history/core.md`.
- **`mcp-exposure.ts`'s `isMcpExposed` is the ONE answer to "did this opt into MCP?"** †

## Metrics, tracing, reporting

`metrics.ts`: counters (spans: `telemetry.ts`), always on. **There is no exporter until something
subscribes to `metric.export`**: `exportMetrics()` returns at once with no subscriber (no
`noopMetricExporter`, deleted in 31.0.0); the OTLP boot's `subscribe` is the install, its release
the uninstall.
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
  `meta`, ids or `release`. Total over hostile getters; the LOCAL group; the monitor's is `monitorFingerprint` (`[code]`; `X_INTERNAL` + app frame; `X_CLIENT_ERROR` + operation).
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
- `error-reporter.ts`: `ErrorReporter`, an `adapterSlot` (`installErrorReporter` on `./adapter`; `configureErrorReporting` keeps clock/release/environment/enabled only), no-op default, memory reporter for tests, Sentry transport (`error-reporter-sentry.ts`, optional export). Full rule: `docs/history/core.md`. `'browser'`: only cli's `client-errors-routes.ts`, one `X_CLIENT_ERROR` per report.
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
- **`ADAPTER_PORTS` (`registrar.ts`) is every swappable backend**; `registrar.test.ts` pins each row
  and checks each interface is exported by its package. A port's installer lives on that package's
  `./adapter` subpath (core's: `adapter.ts`), returns its release, and is never on the barrel.

```bash
bun test ./packages/core/src/    # from the REPO ROOT, never from packages/core; the ./ matters
bun run typecheck
```

The root is load-bearing: Bun reads `bunfig.toml` (its preload installs `@ultimat3/testing`'s
matchers) from the cwd.

Gotchas (`exactOptionalPropertyTypes`, `Ctx`'s index signature, registry resets, `onShutdown`'s unregister, cursor-secret restore): [`docs/history/core.md`](../../docs/history/core.md#moved-out-2026-11-03-plan-101-wave-3-the-claudemd-ceiling).

Why each rule is shaped so: [`docs/history/core.md`](../../docs/history/core.md).
- `drain-deadline.ts` also owns `WORKER_RETIRE_DEFAULT_MS` and `workerRetireIssue`.
