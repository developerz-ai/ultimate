# @ultimat3/core — agent notes

Tier 0. **Imports no `@ultimat3/*` package except `@ultimat3/schema`** (the declared `core → schema`
edge; `schema → core` stays forbidden). Everything else depends on this, so a change here is a
change to every package.

| Rule | |
|---|---|
| Deps | `@ultimat3/schema` only (`bun-types` for types) |
| Errors | subclass `UltimateError`; never `throw new Error` |
| Values in a message | `renderCauseValue()` / `renderFixLiteral()`; never raw `JSON.stringify`, `String()` or `${…}` on an `unknown` |
| A value in a `fix:` a shell READS | `renderFixShellArg(value, placeholder)` — `renderFixLiteral`'s double quotes leave `$(…)`, `` ` `` and `${…}` live. An ordinary path or URL passes through; anything a shell would read becomes the placeholder |
| Whether that value TRAVELS | `isFixShellSafe(value)`, the predicate `renderFixShellArg` is built on. A placeholder is not a runnable command, so a `fix:` whose value sits mid-command asks this first and emits PROSE when the answer is no (`@ultimat3/auth`'s `jwks.ts`, `@ultimat3/scraping`'s `profileLocked`) |
| Rendering the 3-line format | nothing to remember — `UltimateError`'s CONSTRUCTOR escapes `code`, `title`, `cause`, `fix` and `docs` with `singleLine()`. Call it yourself only for a shape this class never built (a `Finding`) |
| A value a CALLER supplied | `describeValue()` — shape, never content. `renderCauseValue` is safe against throwing, not against leaking |
| Reading a caught value | `renderThrowable()` / `isThrownError()` / `stringField()`; never `error.message`, `instanceof Error` or `typeof error.code === 'string'` |
| New code | add to `CORE_CODE_TITLES` in `core-error-codes.ts` — a side-effect anchor the barrel bare-imports, so `UltimateError` alone never carries the table |
| Where an error points | `ERROR_DOCS_URL` — one constant, never a per-code URL. `docs:` is omitted at construction and resolved from the registry |
| Time | take a `Clock`; `Date.now()` / `new Date()` only inside `clock.ts` |
| Context | never thread `ctx` as a parameter — `useContext()` |
| A value ambient across an `await` | `asyncContext<T>(subject)` from `async-context.ts`, in **every** package — never `new AsyncLocalStorage` |
| Exports | explicit in `src/index.ts`; no `export *`. ONE subpath, `@ultimat3/core/page` (`src/page.ts`): the page handle, the principal fence and the page's shared names, because any barrel import retains the error registry (~7.6 kB). `page-bundle.test.ts` pins the retained module set and a 1.5 kB ceiling; nothing that constructs an error may join it. `src/exports/` groups three subjects; every name is still written out in `index.ts` |
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
  duplicate, pinned by `single-line-pin.test.ts` HERE, with `ERROR_DOCS_URL` and the brand key.
- **`core → schema` is declared, and the five former copies are gone** (`describeValue`,
  `charCount`, `CURRENCY_CODE_PATTERN`, `SCHEMA_ERROR_CODES`, `isIanaZoneName`). Its bundle cost is
  measured in `docs/architecture/01-package-map.md`; it depends on `@ultimat3/schema` keeping
  `sideEffects: false`.
- **A string's length is CODE POINTS** — `validators.ts` rejects in that unit and
  `json-schema.ts` publishes `minLength` in it. `parseId`/`uuidTimestamp` describe a rejected id and
  never echo it: a value baked into a message has no log field key to redact.
- `logger.ts` must not import `context.ts` (`context.ts` injects ids via `setLoggerContextFields()`).
  It imports `secret.ts` one way only: `secret.ts` owns `REDACTED`, `logger.ts` re-exports it.
- **`ActorFacts` is the app's extension point on `Actor`** (module augmentation). Core never declares
  a fact; every fact reads `T | undefined` through `actorFact()` so an unresolved fact denies.
  `type-pins.ts` pins the shape against a local sample.

| Concept | Owner | Note |
|---|---|---|
| which deploy this is | `environment.ts` (`ULTIMATE_ENV`) | the twin of `ROLE`; never a second env var |
| what this process does | `roles.ts` (`ROLE`) | |
| how a route renders, caches offline and hydrates | `route-vocabulary.ts` (`RENDER_MODES`, `OFFLINE_STRATEGIES`, `HYDRATE_STRATEGIES`) | every union is `(typeof ARRAY)[number]`, pinned in `type-pins.ts`; `scripts/render-modes.test.ts` refuses a second declaration. Re-export it, never restate it |
| which rungs a cache ladder has | `cache-vocabulary.ts` (`CACHE_TIERS`) | `@ultimat3/cache`'s `TIER_ORDER` IS this array. `isr` is a `RenderMode`, never a tier |
| which build of the APP this is | `app-version.ts` (`APP_VERSION`) | one reader, `dev` by default |
| the values | `env.ts` | `checkEnv().values` holds REAL secrets — printing goes through `maskedEnvValues()` |
| `.env.example` | `env-example.ts` | a projection of the schema, never hand-maintained |
| loading `.env` | **Bun**, not us | `envFileCandidates()` documents the measured order; there is no `.env.staging` |
| how long to wait, and whether to wait at all | `backoff.ts` + `retry.ts` | one curve, one executor; `jitter` is REQUIRED on a retry policy and defaults to `none` on the arithmetic. `attempt` is 1-based |
| N callers on one key | `single-flight.ts` | identity-checked eviction, optional injected deadline |
| how many at once | `flight-gate.ts` | hand-over on release, refusal past `maxQueued`, injectable `overflow:` refusal |
| whether an answer still applies | `generation-fence.ts` | `X_SUPERSEDED` / `isSuperseded` |
| which HTTP statuses are worth repeating | `retryable-status.ts` | `>= 500` plus 408, 409, 425, 429 |
| how long this request has left | `request-budget.ts` (`Ctx.deadlineAt`, `REQUEST_TIMEOUT_HEADER`) | `@ultimat3/http`'s `startDeadline` is the one writer of the instant; `traceHeaders()` the one writer of the header. A spent budget sends nothing, never `0` |
| the above, composed into one typed-client call | `client-flight.ts` + `client-wire.ts` | shared by `@ultimat3/action` and `@ultimat3/query` (both tier 3), re-exported by both. Declares no code of its own |
| the browser's one HTTP function, records envelope, per-tab handle and principal fence | `client-transport.ts`, `client-dispatch.ts`, `client-problem.ts`, `client-paths.ts`, `record-envelope.ts`, `record-sink.ts`, `client-scope.ts` | `pageClient()` is the ONE `globalThis` write (`Symbol.for('ultimate.client')`); the scope's listeners live ON the handle. `clientTransport` never value-imports `createClientFlight` or `traceHeaders()`: trace/budget headers reach it through the page handle's OUTBOUND SLOT (`outbound-headers.ts`). `isSuperseded` answers both `X_SUPERSEDED` and `X_CLIENT_SCOPE_CHANGED`. The fence never `bump()`s a caller's flight. A write never dedupes; a read dedupes only with a caller's `flight`. `pageClient()` reads `<meta name="ultimate-scope">` (`CLIENT_SCOPE_META`) once: content = principal, empty = anonymous (`null`), absent = UNSCOPED (`undefined`, nothing persisted). Byte figures (`As of 2026-09-23`): `clientTransport` 14,405 B, `pageClient` 8,853 B through the barrel, 332 B from its own module; `rpc`'s live in `packages/action/CLAUDE.md`, `queryClient`'s in `packages/query/CLAUDE.md` |
| a write's public name | `write-digest.ts` (`writeDigest`, `isWriteDigest`, also on `./page`) + `write-origin.ts` (`withWriteOrigin`, `currentWriteOrigin`, `WRITE_ORIGIN_WAL_PREFIX`, server-only) | SHA-256 of an idempotency key, 32 hex; carried action → entity → WAL → realtime `records` frame. A malformed value runs the work unnamed: a label, never a gate |
| which row survives a conflict | `conflict-policy.ts` (`ConflictPolicy`, `resolveConflict`, `Row`) | read by `action`'s mutator and `realtime`'s rebase |
| the four shapes of an async region | `async-state.ts` (`AsyncState`) | `realtime` returns it, `ui` renders it. `bun run render-modes` refuses a second status union sharing three members |
| is this `unknown` a keyed record? | `json-object.ts` (`isJsonObject`) | narrows a shape; does not certify provenance |
| a value that must not be printed | `secret.ts` | redacted by VALUE; `revealSecret()` is the one, greppable, way out |
| an `Intl` formatter cache, and the screen in front of it | `intl-cache.ts` (`cachedFormatter`, `canonicalLocale`, `assertLocale`, `MAX_CACHED_FORMATTERS`, `MAX_LOCALE_EXCERPT`) | a locale arrives from a header: refuse a non-tag (`X_LOCALE_INVALID`), key canonically AND bound the cache — never a copy of any of the three. The cause quotes at most `MAX_LOCALE_EXCERPT` (35) code points; the whole tag rides in `meta.locale` |
| the text direction of a locale | `locale-direction.ts` (`directionOf`, `isRtl`, `Direction`) | re-exported by `@ultimat3/i18n`; lives here so `@ultimat3/ui` need not reach the i18n barrel |
| the committed encrypted values | `secrets.ts` (envelope) + `secrets-store.ts` (files, `installSecrets`) | plaintext is a flat map of ENV NAMES; there is no `secrets.get()` |

- **`installSecrets()` is the ONLY path from `secrets.enc.json` to an app value**, landing in
  `process.env` before `defineEnv` reads it. The real environment always wins.
- **`intl-cache.ts`'s bound and canonical key are two halves of one rule** and live in one file:
  validating and keying are one `getCanonicalLocales` call. Never build an `Intl` formatter on a
  caller string without both.
- **`secrets-errors.ts`'s command lines are screened**: paths through `renderFixShellArg`; a
  variable name must match `/^[A-Z_][A-Z0-9_]*$/` or the line degrades to prose;
  `X_SECRETS_KEY_MISMATCH`'s command carries no key id (it is read from a file). Its seven codes
  register through `registerErrorCodes()`, so `resetErrorCodes()` drops them — take
  `errorCodeSnapshot()` first. The envelope's `kid` lets *wrong key* and *edited file* be two codes.
- **`schema-error-codes.ts` registers `@ultimat3/schema`'s codes** (schema cannot call core), and
  derives their retry classification from the same set. It is a `SIDE_EFFECTS_ANCHORS` entry.
- `timing-safe-equal.ts` is the one constant-time comparison (`@ultimat3/auth`, `@ultimat3/storage`).
- **`canonical-json.ts`: `canonicalJson` is INJECTIVE and `fingerprint` is SHA-256/16 of it** — the
  hash every sharing key is taken over (`action`'s `requestHash`, `query`'s `queryHash`, `realtime`'s
  `qid`). `NaN`, `±Infinity` and `-0` are bare tokens; `Date`, `Map` and `Set` are TAGGED. Never a
  fourth copy, never parseable (`@ultimat3/action`'s `stableStringify` is the document form).
- **`decimal-order.ts`'s `compareDecimalText` answers `undefined` for a non-decimal**, and only a
  caller that knows the column's kind may ask (`@ultimat3/entity`'s `compareByKind`) — never
  `@ultimat3/query`, whose `OrderKey` has no kind.
- **`format-bytes.ts`: one `formatBytes(bytes)`, 1024-base, `b|kb|mb|gb`** for byte counts in error
  messages. Not `@ultimat3/ui`'s locale-formatted decimal one. Not mechanised — review catches a
  third copy.
- **The flight layer** (`backoff.ts`, `retry.ts`, `single-flight.ts`, `flight-gate.ts`,
  `generation-fence.ts`, `retryable-status.ts`, `client-flight.ts`, `client-wire.ts`) imports
  nothing but this package, runs nothing at import, and injects every source of non-determinism
  (roll, sleep, clock, timer). `classifyThrown` / `statedDelayMs` live beside `error-retry.ts`'s table.
- **`backoffDelay` REFUSES a non-finite bound**: `attempt`, `base`, `max` and `factor` go through
  `finiteOption` before the clamps. The trailing `return 0` is reachable only by `factor` overflow.
  It clamps to `max` **before** jitter.
- **`finiteOption` / `finiteCount` (`finite-option.ts`) are the framework's ONE screen for a numeric
  option.** `finiteCount(subject, option, value, min)` takes `min: 0 | 1` because only the caller
  knows what zero means. `bun run finite-bounds` recognises a repair by the call's shape, so a
  package screen carries `Finite` in its name.
- **`createFlightGate` HANDS its slot to a waiter** rather than releasing it. `X_FLIGHT_GATE_OVERLOADED`
  is core's own code (tier 0 cannot borrow http's `X_OVERLOADED`); `overflow:` lets a caller throw its own.
- **`client-flight.ts` INVERTS `retryDecision`'s unclassified default** through its `transient:`
  predicate: a bare `TypeError` (dead network) and an `AbortError` (the caller's cancellation) are
  indistinguishable by class. Never "simplify" it back.
- **`ClientFlight` stays `import type`-only in `action`'s and `query`'s `client.ts`** — a value import
  pulls the whole flight layer into every caller's chunk.
- **`mcp-exposure.ts`'s `isMcpExposed` is the ONE answer to "did this opt into MCP?"**, read by
  `action`, `query`, `mcp`, `ai`, `manifest`. `@ultimat3/cli`'s `mcp-exposure-pin.test.ts` checks
  it; `@ultimat3/admin`'s own catalog is the one opt-OUT exception (`mcp-tools.ts`).

## Metrics, tracing, reporting

`metrics.ts` is to `telemetry.ts` what a counter is to a span: always on, no-op exporter by
default. `runtime-metrics.ts` is the only place that names a series the chart reads
(`http_requests_total`, `connections`, `queue_depth`), keyed by `ScalingSignal` in
`SCALING_METRICS`. One call site per package; a second is the bug:

| Recorder | The one caller |
|---|---|
| `recordRequest` | `@ultimat3/http` `pipeline.ts`, the `finally` around `execute` |
| `recordConnection` | `@ultimat3/realtime` `socket.ts`, `SocketRegistry.add`/`remove` |
| `recordQueueDepth` | `@ultimat3/jobs` `worker.ts`, throttled inside `tick()` |
| `recordJob` | `@ultimat3/jobs` `worker.ts`, the outcome branch inside `tick()` (`JOB_OUTCOME_LABELS` drops `suspended`) |
| `recordLeaseLost` | `@ultimat3/jobs` `heartbeat.ts`, once per lapsed lease |

- Tracing is three files: `telemetry.ts` builds spans, `sampler.ts` decides, `otlp*.ts` exports.
  `span.end()` returns early when `traceFlags & 1` is 0. The default sampler reads
  `OTEL_TRACES_SAMPLER*` at the first span, never at module scope. `resetTelemetry()` drops both.
- **An empty `spanId` means "no inbound decision"** — `startSpan` narrows through
  `inboundParent()`, carrying the trace id and never the synthesised sampling bit.
- The OTLP exporters are built, not wrapped ([`docs/idea/18-build-vs-wrap.md`](../../docs/idea/18-build-vs-wrap.md)).
  `otlpTraceRequest` / `otlpMetricsRequest` are pure. **gRPC (`:4317`) is out of scope**:
  `X_OTLP_PROTOCOL_UNSUPPORTED` names `:4318`; a boot that must not throw asks `tryOtlpEndpoint(signal)`.
- **Three OTLP variables, three codes** — `X_OTLP_ENDPOINT_INVALID`, `X_OTLP_HEADERS_INVALID`,
  `X_OTLP_PROTOCOL_UNSUPPORTED`. A header KEY is in the cause/fix/meta; its VALUE never is.
- `error-reporter.ts`: `ErrorReporter`, no-op default, memory reporter for tests, Sentry transport
  (`error-reporter-sentry.ts`, optional export). `reportError` never throws, never awaits. Callers:
  `@ultimat3/http` `stages.ts` (`status >= 500`), `@ultimat3/jobs` `execute.ts`, `@ultimat3/realtime`
  `sync-node.ts` and `sync-upgrade.ts`, `@ultimat3/flags` `runtime.ts`. `configureErrorReporting({
  release })` takes the build id `serve.ts` computed. Trace and span resolve as a PAIR.
- `METRICS_PATH` is served by `@ultimat3/cli`'s `metrics-endpoint.ts` on `METRICS_PORT` (9090), never
  the role's HTTP port; every role opens it.

## Lifecycle and readiness

- `markReady()` means **bound**; readiness means **usable** — `registerReadinessCheck(name, check)`.
  `/readyz` is ready when the state is `ready` AND every check passes. `HealthReport.registered` is
  the count (an empty registry is still `ready`, deliberately). `readinessChecks()` builds through
  `Object.fromEntries` (a check named `__proto__`). Checks are **synchronous**; liveness ignores
  them. The registration returns its unregister; `readinessCheckCount()` is the leak probe.
- **`drain()`'s memo is published BEFORE the first hook runs** — a hook may re-enter `drain()`
  (`@ultimat3/http`'s `handle.stop()`), and `settleWithin` invokes hooks synchronously.
- **The drain deadline is enforced**: `runPhase` races each hook against the time left before
  `deadlineAt` (`lifecycle-deadline.ts`'s `settleWithin`) and ABANDONS an overrun, logging it
  (`X_SHUTDOWN_TIMEOUT`, whose `fix:` names `configureLifecycle({ deadlineMs })`). The budget is the
  WHOLE drain's; `DEFAULT_DEADLINE_MS` (25 s) always applies; it is real monotonic time
  (`systemClock`), never the injected `clock`. `drainDeadlineMs()` is the one decision point.
  `settleWithin` attaches a rejection handler unconditionally.
- **A readiness grace runs before the `accept` phase** (`lifecycle-grace.ts`): `/readyz` answers 503
  with the socket still open for `drain.readinessGraceMs`, ADDED to `deadlineMs` (a chart's
  `terminationGracePeriodSeconds` must exceed the sum — 5 s + 25 s by default). Unset: 0 in
  development/test, 5000 everywhere else including a process naming no environment (fail closed).
- `impersonate(actor, reason, fn)` is the ONE door through `withChildContext({ actor })`; it stamps
  `Actor.onBehalfOf` so `actorLabel` renders `service:eng-7→user:cust-99@org-3`. No second path.
- Every `UltimateError` carries `retry` (`terminal | retryable | retry-after`), **defaulting to
  `terminal`**. `registerErrorRetry()` is the one registration path and refuses to reclassify a
  core code. Two readers: `retryFor(code)` (what to do, fails closed) and
  `declaredErrorRetry(code)` (what was declared, `undefined` otherwise) — a caller deciding whether
  to STOP work in flight (`@ultimat3/jobs`' executor) reads the second. An instance `retry` on an
  unregistered code reads as unclassified.
- `PRIMITIVE_KINDS` is the executable eight-primitive rule; `PrimitiveKind` derives from it and
  `registrar.test.ts` fails on a ninth. `PRIMITIVE_FACTORIES` lists the factories.

```bash
bun test packages/core/src    # from the REPO ROOT, never from packages/core
bun run typecheck
```

The root is not a preference: `bunfig.toml`'s preload installs `@ultimat3/testing`'s matchers, and
Bun reads `bunfig.toml` from the cwd (`scripts/coverage-gate.ts` runs from the root for the same reason).

Gotchas:
- `exactOptionalPropertyTypes` is on — declare optional fields as `x?: T | undefined`.
- `noPropertyAccessFromIndexSignature` is on — `ctx.services['mail']`, not `.mail`.
- `Ctx` carries a string index signature so apps can augment `CtxServices`; the cost is that
  `ctx.anything` type-checks as `unknown`. Deleting it is a breaking change, measured to compile
  core clean; land it alone, with a full `bun run verify`.
- **`Ctx extends CtxFacts, CtxServices`, and `createContext` holds the framework's ONE irreducible
  `as Ctx`.** `CtxFacts` is what the framework sets (and what a `ServiceFactory` receives); an
  augmentation's named members are required of every `Ctx`, and no framework function can obtain
  them. `@ultimat3/http`'s `createRequestContext` composes `createContext()` and has no assertion.
  Four alternatives were measured and refused (listed in the file header); the structural repair is
  a major, alongside the index-signature deletion.
- Tests that touch the registry, the lifecycle or the listener table call `resetErrorCodes()` /
  `resetLifecycle()` / `resetListeners()` — and a registry reset takes `errorCodeSnapshot()` first
  and restores it in `afterAll`, or every earlier package's titles render humanised for the run.
- `onShutdown`'s return value is the unregister, owned by every caller that can start twice
  (`@ultimat3/http`'s `server.ts`, `@ultimat3/realtime`'s `listenSyncNode`, `@ultimat3/jobs`' worker,
  `@ultimat3/cli`'s `hold.ts`). `shutdownHookCount()` is the leak probe.
- Tests calling `configureCursorSigning()` restore the previous secret or call
  `resetCursorSigning()`. The secret is read inside `sign()`, never at module scope; new secrets
  follow the same call-time rule.

Why each rule above is shaped the way it is: [`docs/history/core.md`](../../docs/history/core.md).
