# @ultimat3/core — agent notes

Tier 0. **Imports no `@ultimat3/*` package.** Everything else depends on this, so a change here
is a change to every package.

| Rule | |
|---|---|
| Deps | none (`bun-types` only) |
| Errors | subclass `UltimateError`; never `throw new Error` |
| Values in a message | `renderCauseValue()` / `renderFixLiteral()`; never raw `JSON.stringify`, `String()` or `${…}` on an `unknown` |
| Rendering the 3-line format | nothing to remember — `UltimateError`'s CONSTRUCTOR escapes `code`, `title`, `cause`, `fix` and `docs` with `singleLine()`. Call it yourself only when you render a shape this class never built, e.g. a `Finding` |
| A value a CALLER supplied | `describeValue()` — shape, never content. `renderCauseValue` is safe against throwing, not against leaking |
| Reading a caught value | `renderThrowable()` / `isThrownError()` / `stringField()`; never `error.message`, `error instanceof Error` or `typeof error.code === 'string'` directly — the probe throws before the renderer runs |
| New code | add to `CORE_CODE_TITLES` in `error-codes.ts`, else the title is auto-humanised |
| Where an error points | `ERROR_DOCS_URL` — one constant, never a per-code URL. `docs:` is omitted at every construction site and resolved from the registry |
| Time | take a `Clock`; `Date.now()` / `new Date()` only inside `clock.ts` |
| Context | never thread `ctx` as a parameter — `useContext()` |
| A value ambient across an `await` | `asyncContext<T>(subject)` from `async-context.ts`, in **every** package — never `new AsyncLocalStorage` |
| Exports | add to `src/index.ts` explicitly; no `export *`. Three subjects that each span a dozen modules arrive through `src/exports/` — every name is still written out in `index.ts`, so the public surface is one file to read |
| Files | < 200 LOC, 500 hard ceiling, one responsibility, `kebab-case.ts`, test beside source |
| Type claims | `type-pins.ts`, never a `.test.ts` — `tsconfig.json` excludes tests, so `tsc` never reads one |

Deliberate cycles (safe — nothing is referenced at module-evaluation time):
`errors.ts ⇄ error-codes.ts`. Keep it that way: no top-level `UltimateError` use in
`error-codes.ts`.

**`async-context.ts` is the framework's ONE `AsyncLocalStorage`, and that is a framework rule
rather than a core one, `As of 2026-08-20`.** `asyncContext` is exported from `src/index.ts` and
six modules outside this package opened their own before they adopted it — `@ultimat3/db`'s
transaction, statement attribution and expected-loop scopes, `@ultimat3/entity`'s `crossTenant`,
`@ultimat3/ai`'s budget ledger and LLM stream sink. Each was a module-scope `new` a browser bundler
turns into `TypeError: undefined is not a constructor` at module EVALUATION, so importing any of
those packages from a client bundle failed before a line of app code ran. Reads degrade to
`undefined`, writes throw `X_ASYNC_CONTEXT_UNAVAILABLE`; deferring the construction changes nothing
a server can observe — the storage is built on the first `get()` or `run()` rather than at module
evaluation, and `getStore()` outside a scope answers `undefined` either way.

The mechanical half is `scripts/async-context-guard.ts`, collected by `x verify`'s `unit` step
through `scripts/async-context-guard.test.ts` — it refuses a `new AsyncLocalStorage` **and** the
import that binds the class, aliased or namespaced, anywhere but this one file. The browser-barrel
test in `async-context.test.ts` covers the same defect for core alone and cannot see another
package; the guard cannot see a runtime `await import('node:async_hooks')`. Neither is the other's
duplicate.

`error-render.ts` imports nothing, including from this package — an error factory that dies
formatting its own message is the failure it exists to prevent, so it cannot depend on anything
that could itself throw. The same defect shipped three times (`entity`, `flags`, `cli`) before
this file existed; `renderCauseValue` is `@ultimat3/entity`'s `renderValue` moved down a tier
VERBATIM, `a object` included, so a package adopting it changes no message. `toUltimateError`,
`parseId` and `readPackageVersion` are its first callers. The mechanical half is
`scripts/error-render.ts` on `x verify`'s `errors` step (`X_ERROR_RENDER_UNSAFE`) — it reads
parameters typed `unknown` that reach a `cause:` / `fix:`, and it cannot see a value laundered
through a local helper first (`packages/ui/src/components/ErrorState.tsx` builds a `message`
const, then assigns it).

`singleLine` is the escape that keeps the 3-line contract to three lines, and it exists because
`scripts/error-render.ts` **cannot see this class**. That gate refuses a parameter typed
`unknown`/`any` reaching a `cause:`; a value that is already a `string` renders without throwing, so
there is nothing for it to object to — while a newline in one adds a line to a format that is
line-oriented in the terminal, in CI logs and inside the dev overlay's `<pre>`. Three holes shipped
in `@ultimat3/auth` under a green check, the worst reachable by an unauthenticated stranger with one
crafted OIDC token (issue #97).

**It is applied in the CONSTRUCTOR, `As of 2026-08-20` — not at the renderers, which is where it
went first and could not stay.** Escaping at each renderer was six call sites, and six is a number
that only goes up: a seventh in this repo, and every renderer an APP writes, would each have had to
remember. `format()` is also not the only reader — an uncaught throw prints `.message`, a log line
takes `.cause`, `--json` takes `toJSON()` — so a per-renderer escape left three of four doors open.
One constructor covers all of them, and `singleLine` is idempotent, so a call site that already
escaped (`@ultimat3/auth` renders `claims.iss` at its source, quotes and all) is unharmed. `format()`
therefore interpolates the fields bare: a second pass would be a second place that has to be right.
The four renderers that still call it — `renderErrorLines` in `@ultimat3/http`,
`renderFrameworkError` in `@ultimat3/mcp`, `renderFinding` / `detailLines` in `@ultimat3/cli` — take
shapes this class never built (a `Finding`, a catalog entry), which is the one case left.

It is not a general sanitiser: a cause is prose and keeps its quotes,
its backslashes and its percent signs — only the control range is touched. Line breaks are the
structural half; the rest of C0 and DEL ride along because a terminal reads a raw `\u001b` as an ANSI
escape, so a cause could repaint the screen or hide the line above it. `@ultimat3/schema` carries a
deliberate duplicate for the tier-0 reason below, pinned behaviourally by
`single-line-pin.test.ts` in `@ultimat3/cli`.

`describeValue` in `error-render.ts` is a deliberate duplicate of `describeValue` in
`packages/schema/src/describe-value.ts`, for the same tier-0 reason `SCHEMA_ERROR_CODE_TITLES` is
one: schema and core are both tier 0 and `core → schema` is **not** a declared edge in
`scripts/lib/tiers.ts`, so neither may import the other. Keep the two ANSWERING identically — that
is the contract, and the source is no longer character-for-character: schema counts characters
through `char-count.ts`, which core copies privately. A pin test in
`@ultimat3/cli` (which may legally import both) is the mechanical half, the same shape as
`schema-error-codes-pin.test.ts`. **A string's length is CODE POINTS in both, `As of 2026-08-22`**
— `validators.ts` rejects in that unit and `json-schema.ts` publishes `minLength` in it, so
`.length` made `t.string.min(3).safeParse('👍a')` say "at least 3 chars, received a string of 3
characters". The rule it enforces: a `cause` reaches the log index AND the
HTTP problem document, redaction is by log FIELD key, and a value baked into a message string has
no key left to redact — so `parseId`/`uuidTimestamp` describe a rejected id and never echo it.

`logger.ts` must not import `context.ts`. `context.ts` injects the ids via
`setLoggerContextFields()`. It **does** import `secret.ts`, one way only: `secret.ts` owns
`REDACTED` so a `Secret` can render it without importing the logger, and `logger.ts` re-exports
the constant so there is still one definition and one public path.

`ActorFacts` is the app's extension point on `Actor` — module augmentation, the same trick as
`CtxServices` and `PermissionRegistry`. Core declares the seam and **never a fact**: augmenting
`ActorFacts` inside the framework would declare that fact for every app. Every fact reads as
`T | undefined` through `actorFact()` on purpose — an unresolved fact must deny, and a job, a
test and an MCP token exchange all mint actors that resolved nothing. `type-pins.ts` pins that
shape against a locally declared sample interface for exactly that reason.

| Concept | Owner | Note |
|---|---|---|
| which deploy this is | `environment.ts` (`ULTIMATE_ENV`) | the twin of `ROLE`; never declare a second env var for it |
| what this process does | `roles.ts` (`ROLE`) | |
| how a route renders, caches offline and hydrates | `route-vocabulary.ts` (`RENDER_MODES`, `OFFLINE_STRATEGIES`, `HYDRATE_STRATEGIES`) | tier 0 because SIX packages name them and imports only go down — `render`, `http`, `seo`, `manifest` and `pwa` each kept a hand-copy until 2026-08, and `'spa'` was deleted from one while five went on admitting it under a green typecheck. Every union is `(typeof ARRAY)[number]`, pinned in `type-pins.ts`; `scripts/render-modes.test.ts` refuses a second declaration anywhere in `packages/*/src`. Re-export it, never restate it |
| which rungs a cache ladder has | `cache-vocabulary.ts` (`CACHE_TIERS`) | tier 0 for the same reason, one tier lower down the stack: `app.config.ts` picks tiers by name and `@ultimat3/cache` builds them by name, and until 2026-08-22 those were two different vocabularies — config accepted `memo \| lru \| shared \| isr \| cdn`, the ladder ordered `request-memo \| lru \| redis \| cdn`, nothing mapped one onto the other, and `cache: { tiers: ['isr'] }` typechecked and selected nothing (issue #293). `TIER_ORDER` IS this array, so read order and the config vocabulary cannot disagree. `isr` is a `RenderMode`, never a tier. Pinned in `type-pins.ts` and by `scripts/render-modes.ts` |
| which build of the APP this is | `app-version.ts` (`APP_VERSION`) | one reader, `dev` by default: `db` writes it into `x_migrations` and `jobs` into `x_backfills`, and `jobs` cannot reach `db` for the answer |
| the values | `env.ts` | `checkEnv().values` holds REAL secrets — anything that prints goes through `maskedEnvValues()` |
| `.env.example` | `env-example.ts` | a projection of the schema, never hand-maintained |
| loading `.env` | **Bun**, not us | `envFileCandidates()` documents the measured order; there is no `.env.staging` |
| how long to wait, and whether to wait at all | `backoff.ts` + `retry.ts` | one curve and one executor; `jitter` is REQUIRED on a retry policy and defaults to `none` on the arithmetic |
| N callers on one key | `single-flight.ts` | identity-checked eviction, optional injected deadline; `@ultimat3/cache`'s is this shape |
| how many at once | `flight-gate.ts` | hand-over on release, refusal past `maxQueued`, injectable `overflow:` refusal |
| whether an answer still applies | `generation-fence.ts` | `X_SUPERSEDED` / `isSuperseded`; nothing else in the tree had one |
| which HTTP statuses are worth repeating | `retryable-status.ts` | `>= 500` plus 408, 409, 425, 429 — the two byte-identical copies' set |
| how long this request has left | `request-budget.ts` (`Ctx.deadlineAt`, `REQUEST_TIMEOUT_HEADER`) | `@ultimat3/http`'s `startDeadline` is the one production writer of the instant; `traceHeaders()` is the one writer of the header. It lives here because the READER is tier 2 and the WRITER is a typed client in tier 0, and a second literal for the header name is a propagation that stops working the day either string is edited. A spent budget sends nothing rather than `0` — the far side ignores anything under 1ms and falls back to its own, which is the failure the header exists to prevent, one hop later |
| the five above, composed into one typed-client call | `client-flight.ts` + `client-wire.ts` | `@ultimat3/action` and `@ultimat3/query` both project a typed client and are both tier 3, so neither could import the other: it shipped as a byte-identical 288-line + 85-line copy in each, policed by a `client-twin.test.ts` in both. Both packages re-export these names, so their public surface is unchanged. Declares NO code of its own — `X_SUPERSEDED`, `X_TIMEOUT` and `X_FLIGHT_GATE_OVERLOADED` are already here |
| is this `unknown` a keyed record? | `json-object.ts` | `isJsonObject`, which was the same three terms in both those packages' `stable.ts`. A `Date` and a class instance PASS: it narrows a shape, it does not certify provenance |
| a value that must not be printed | `secret.ts` | redacted by VALUE; `revealSecret()` is the one way out, on purpose greppable |
| an `Intl` formatter cache | `intl-cache.ts` (`cachedFormatter`, `canonicalLocale`, `MAX_CACHED_FORMATTERS`) | a locale and a zone arrive from a request header, so the key must be canonical AND the cache bounded — never a second copy of either half |
| the committed encrypted values | `secrets.ts` (envelope) + `secrets-store.ts` (files, `installSecrets`) | plaintext is a flat map of ENV NAMES; there is no `secrets.get()` |

`installSecrets()` is the ONLY path from `secrets.enc.json` to an app value, and it lands in
`process.env` before `defineEnv` reads it — so a secret has one declaration (`envSchema`), one
`.env.example` row, one mask and one reader. A second accessor would be five second
implementations. The real environment always wins, which is what lets one image run in Compose and
on K8s off one committed file.

`intl-cache.ts` is tier 0 because two tier-1 packages need it and tier 1 may not import sideways.
It was `@ultimat3/time`'s, internal, until 2.0.0, when `@ultimat3/money`'s `formatMoney` was found
keyed raw on the caller's locale into an unbounded `Map` — 20,000 valid `en-US-x-*` tags from one
`Accept-Language` header retained +55.1 MB of RSS (measured `As of 2026-08`). Copying the FIFO into
`money` would have been a second answer to one question (axiom 1); `money → time` is a sideways
import `bun run boundaries` refuses. The bound and the canonical key are **two halves of one rule**
and live in one file for that reason: a canonical key bounds nothing (an unknown `-u-` extension
value survives canonicalization as a distinct string) and the cap alone lets one locale evict
itself under three spellings. Never build an `Intl` formatter on a caller string without both.

`secrets-errors.ts` registers its seven codes through `registerErrorCodes()` rather than joining
`CORE_CODE_TITLES` — the codes and the module that throws them ship together, and `registerErrorCodes`
is the one mechanism that raises `X_ERROR_CODE_DUPLICATE` if anything else claims one. Consequence
to know: a test that calls `resetErrorCodes()` drops these titles like any other package's, so take
`errorCodeSnapshot()` first. The envelope carries a `kid` (a domain-separated, truncated SHA-256 of
the master key) purely so *wrong key* and *edited file* are two codes and not one shrug — GCM alone
cannot tell them apart.

`schema-error-codes.ts` is the same shape a second time, for codes this package does not even own.
`@ultimat3/schema` is tier 0 like `core` and so can neither call `registerErrorCodes()` itself nor
import core to reach it — the four codes' titles are a deliberate, tested duplicate of
`SCHEMA_ERROR_CODES` in `packages/schema/src/errors.ts`, registered unconditionally at import time
so any process that imports core (not just `@ultimat3/cli`, which used to be the only registrant)
renders schema's real titles. Neither tier-0 package can check the duplicate against its source, so
the pin (`schema-error-codes-pin.test.ts`) lives in `@ultimat3/cli`, which may legally import both.

`timing-safe-equal.ts` holds the one constant-time string comparison `@ultimat3/auth` and
`@ultimat3/storage` both need — core is the lowest tier both can reach, so the shared code lives
here rather than in either package copying the other's file.

`canonical-json.ts` is the same shape for the hash every SHARING key in the framework is taken
over, `As of 2026-08`. `canonicalJson` is an INJECTIVE canonical form and `fingerprint` is
SHA-256/16 of it, and three tier-3 packages needed exactly this while none may import another:
`@ultimat3/action`'s `requestHash` and job dedupe key, `@ultimat3/query`'s `queryHash` (a
read-cache entry, a cursor scope, a live query id) and `@ultimat3/realtime`'s `qid`. Each kept its
own copy and the copies had **diverged in a way that leaked**: query's had no `Date` branch, so
`Object.keys(date)` was `[]`, every date rendered `{}`, and one cache key, one cursor scope and one
live window answered for every date window of a read — reachable straight off a query string, since
`coerceQuery` turns a `t.date` member into a real `Date`. Injective is the whole requirement, not a
formatting preference: every one of those keys decides which of two callers is served the other's
answer. So `NaN`, `±Infinity` and `-0` are bare tokens the quoting `string` branch cannot spell,
and a `Date`, a `Map` and a `Set` — the three values with no own enumerable key — are TAGGED. Never
add a fourth copy, and never make it parseable: `@ultimat3/action`'s `stableStringify` is the
DOCUMENT form for that (it publishes `openapi.json`), and it is a different function on purpose.

`decimal-order.ts` is the third instance of the same rule, over a value rather than a shape.
`compareDecimalText` is the exact ordering of two decimals however long the digits run — the order
Postgres gives a `numeric` or an `int8` over the TEXT `@ultimat3/entity`'s `bigint()` and
`decimal()` hand back, where `String(left) < String(right)` answers `["10","100","2","9"]` for
`["2","9","10","100"]` and cuts a keyset page where the database does not. It answers **`undefined`**
when either side is not a plain decimal, and that is the contract, not a convenience: a caller that
knows the column's declared kind asks (`@ultimat3/entity`'s `compareByKind`), and a caller that does
NOT — `@ultimat3/query`, whose `OrderKey` is a name and a direction — must never, because Postgres
orders a `text` column of digits lexically and a comparator guessing would trade one disagreement
with the SQL it printed for another.

`format-bytes.ts` is the same rule at its smallest, `As of 2026-08-22`: one `formatBytes(bytes)`,
1024-base, `b|kb|mb|gb`, for the byte count an error message carries. `@ultimat3/render` (t4) and
`@ultimat3/pwa` (t4) each had one and they had diverged — render's stopped at `kb`, so a 5 MiB route
read `5120kb` in `X_BUDGET_EXCEEDED` and `5mb` in the precache warning about the same bytes, and
`@ultimat3/cli`'s budget error imported render's. Deliberately NOT
`@ultimat3/ui`'s `formatBytes(bytes, locale)`, which is a different function and stays: that one is
`Intl`-formatted and DECIMAL (kB = 1000 B, which is what `Intl`'s unit means), for a human reading a
file picker, where this one must line up with a bundler's own KiB figures and must not move with the
reader's locale. **Not mechanised** — no gate refuses a third copy, unlike `render-modes.ts` for the
route vocabulary; a `formatBytes` reappearing in `packages/*/src` is caught by review only.

The **flight layer** is the same rule over control flow rather than over a value, `As of
2026-08-23`: `backoff.ts`, `retry.ts`, `single-flight.ts`, `flight-gate.ts`, `generation-fence.ts`
and `retryable-status.ts` — plus `client-flight.ts` and `client-wire.ts`, which compose them into
one typed-client call and arrived the same way the layer itself did, as two identical copies in two
packages that may not import each other. Measured before it existed — FOUR backoff curves
(`@ultimat3/jobs` equal-jitter, `@ultimat3/ai` full-jitter with `Math.random` inline and therefore
untestable, `@ultimat3/realtime` 0-based-attempt full-jitter, `@ultimat3/db` none at all), FIVE
retryability tables of which `packages/cache/src/purge-http.ts:19` and
`packages/mail/src/driver-resend.ts:27` were byte-identical in two packages that cannot import
each other, FOUR bounded pools and FOUR dedupers. `error-retry.ts` had declared the vocabulary and
**nothing consulted it before retrying**; `retry()` is the executor it never had, and
`classifyThrown` / `statedDelayMs` moved down here beside the table they read (`@ultimat3/jobs`'
`retry-classification.ts` is that pair one tier up and can delegate to it unchanged). Nothing in
the layer imports anything but this package, nothing runs at import time, and every source of
non-determinism — the roll, the sleep, the clock, the timer — is injected, because a schedule
provable only by waiting is a schedule no test pins.

Two rules that are not preferences. `backoffDelay` clamps to `max` **before** jitter: capping after
turns `full` into a distribution whose upper half is a single value at `max`, which is the
correlation jitter exists to remove. `createFlightGate` **hands** its slot to a waiter rather than
releasing it: decrementing first lets a caller arriving in the same tick past the ceiling while the
waiter's continuation is still a queued microtask — `@ultimat3/auth`'s `createKdfGate` states the
same rule, and `overflow:` is the seam that lets it keep throwing its own `X_OVERLOADED` while
delegating the mechanism. `X_FLIGHT_GATE_OVERLOADED` is core's own code and not auth's borrowed
one: `X_OVERLOADED` belongs to `@ultimat3/http` (tier 2), and tier 0 may not borrow upward.

**`client-flight.ts` INVERTS `retryDecision`'s unclassified default, and that inversion is the
point of it having a `transient:` parameter at all.** `retry.ts` sends a throw nobody classified
again until the attempts run out, which is right for a job and wrong for a client: `fetch` rejects
with a bare `TypeError` for a dead network and a `DOMException` named `AbortError` for the caller's
own cancellation, and nothing can tell them apart from the class alone — so inheriting the default
retries a caller's own abort. `@ultimat3/ai` and `@ultimat3/db` each declined the executor outright
over it; this is the third refusal, and the one that keeps the executor by supplying a predicate.
Never "simplify" it back to the default.

**`ClientFlight` must stay `import type`-only in both packages' `client.ts`, and that erasure is
the whole tree-shaking story.** `import { rpc } from '@ultimat3/action'` is 14,759 B minified for
the browser and 20,292 B with `createClientFlight` beside it; `queryClient` is 12,755 B against
17,912 B. A value import from `client.ts` would put `retry.ts`, `single-flight.ts`,
`generation-fence.ts`, `flight-gate.ts` and `backoff.ts` into every caller's chunk. Measure through
the PUBLIC specifier — `Bun.build`, `target: 'browser'`, `minify: true` — and expect ±376 B run to
run: `Bun.build` 1.4.0 drops this package's `schema-error-codes.ts` from some builds even though
`sideEffects` names it (issue #273), which is exactly the size of the schema error titles.

`mcp-exposure.ts` is the same shape for a declaration rather than an algorithm: `isMcpExposed` is
the ONE answer to "did this primitive opt into being an MCP tool?", asked by `action`, `query`
(t3), `mcp`, `ai`, `manifest` (t4) — five packages that cannot import each other, so core is the
only tier all of them reach. Three spellings of the same question shipped before it (`=== true`,
`!== false`, `?? true`), which published tools in `openapi.json` and `x.manifest.json` that no
surface would serve. Never add a second reader: `@ultimat3/cli`'s `mcp-exposure-pin.test.ts` is
what makes "one predicate" checkable, since no single package below tier 5 can. The one deliberate
exception is `@ultimat3/admin`'s own catalog, which is opt-OUT and says why in `mcp-tools.ts`.

Metrics mirror tracing exactly — `metrics.ts` is to `telemetry.ts` what a counter is to a span:
always on, no-op exporter by default, driver on the wire. `runtime-metrics.ts` is the only place
that names a series the deploy chart reads (`http_requests_total`, `connections`, `queue_depth`);
`SCALING_METRICS` keys them by `ScalingSignal` so `roles.ts` and `docker/helm` cannot drift.
Core declares the instruments and never calls them for another package's events. `As of 2026-08`
the recorders are wired, and there is exactly one call site per package — a second one anywhere is
the bug:

| Recorder | The one caller | Why that seam |
|---|---|---|
| `recordRequest` | `@ultimat3/http` `pipeline.ts`, the `finally` around `execute` | every request passes it once, error paths included |
| `recordConnection` | `@ultimat3/realtime` `socket.ts`, `SocketRegistry.add`/`remove` | the only definition of a live connection; close, idle sweep and drain all pass through it, so the gauge cannot leak |
| `recordQueueDepth` | `@ultimat3/jobs` `worker.ts`, throttled inside `tick()` | the worker is the only process that reads its own queue |
| `recordJob` | `@ultimat3/jobs` `worker.ts`, the outcome branch inside `tick()` | the loop is where the queue name is in scope; `JOB_OUTCOME_LABELS` maps the four outcomes onto three labels and drops `suspended`, because parking a run is control flow |
| `recordLeaseLost` | `@ultimat3/jobs` `heartbeat.ts`, once per lease that lapsed | the lease heartbeat is the only thing that knows a renewal stopped landing; deliberately not an `outcome` on `jobs_total`, because nothing failed and nothing finished — the queue simply re-delivered a job this process was still running |

Tracing has three parts and they are three files on purpose: `telemetry.ts` builds spans,
`sampler.ts` decides whether a trace is worth exporting, and `otlp*.ts` puts it on the wire.
`span.end()` returns early when `traceFlags & 1` is 0 — the bit is obeyed, not merely forwarded,
which is what stops an exporter from turning 40k rps into 40k rps of spans. `configureTelemetry`
takes a `Sampler`; the default reads `OTEL_TRACES_SAMPLER*` **at the first span, never at module
scope** (same call-time rule as `cursor.ts`'s secret). `resetTelemetry()` drops both.

**An empty `spanId` means "no inbound decision", and every reader must honour it, `As of
2026-08-22`.** `currentSpanContext()` synthesises `{ traceId, spanId: '', traceFlags: 1 }` from the
request context — a trace id this process minted, plus the header it would send onward. Handing
that to `Sampler.shouldSample` as a parent made `parentBasedRatioSampler` inherit a bit nobody sent,
so at ratio 0 a root span outside a request exported 0 and one inside exported 1 — and
`@ultimat3/http`'s `pipeline.ts` is `runWithContext` then `withSpan`, so **every HTTP root span was
exported at every ratio**. `startSpan` now narrows through `inboundParent()`: the trace id is
carried, the decision is not. It is the same discriminator `end()` already used to drop a synthetic
`parentSpanId`.

The OTLP exporters are built, not wrapped, and the case is in
[`docs/idea/18-build-vs-wrap.md`](../../docs/idea/18-build-vs-wrap.md): OTLP/HTTP JSON is `fetch`
plus `JSON.stringify`, while `@opentelemetry/api` would put a SECOND `Span` type in the framework
(axiom 1) and `sdk-node` would fight `context.ts` for the AsyncLocalStorage. `otlpTraceRequest` /
`otlpMetricsRequest` are pure so the wire format is a unit test, exactly as `sentryEnvelope` is.
**gRPC (`:4317`) is out of scope** — it needs HTTP/2 and protobuf, and both the `:4317` port and a
non-`http/json` `OTEL_EXPORTER_OTLP_PROTOCOL` throw `X_OTLP_PROTOCOL_UNSUPPORTED` naming `:4318`.
A boot that must not throw asks `tryOtlpEndpoint(signal)` first.

**Three OTLP variables, three codes, `As of 2026-08-22`** — `X_OTLP_ENDPOINT_INVALID`,
`X_OTLP_HEADERS_INVALID`, `X_OTLP_PROTOCOL_UNSUPPORTED`, one per variable an operator sets. The
headers one is not a duplicate of the endpoint one: `otlpHeaders` percent-decodes, so `%zz` in
`OTEL_EXPORTER_OTLP_HEADERS` used to take the process down with a bare `URIError` at exporter
construction, and raising the ENDPOINT code instead would send the first reader of
`x errors explain` to inspect a variable that is fine. A title is what an agent reads first, and an
accurate `cause:` does not rescue one that misdirects. The header **key** is in the cause, the fix
and `meta`; the **value** is in none of them — it is the collector's credential.

`error-reporter.ts` is the same shape a third time: `ErrorReporter`, a no-op default, a memory
reporter for tests, and a transport on the wire (`error-reporter-sentry.ts`, an optional separate
export — the DSN is the app's typed env, never a constant here). `reportError` never throws and
never awaits. **Four packages call it, seven call sites, `As of 2026-08`** — and unlike the
recorders it is not one per package, because `realtime` has two files that can see a throw:

| Package | Call site |
|---|---|
| `@ultimat3/http` | `stages.ts` — `status >= 500` only |
| `@ultimat3/jobs` | `execute.ts`, inside `executeJob`: the one frame still holding the thrown value, where the loop above it sees a message string |
| `@ultimat3/realtime` | `sync-node.ts` (three) and `sync-upgrade.ts` (one) |
| `@ultimat3/flags` | `runtime.ts` — `source: 'process'`, severity `warning` |

`configureErrorReporting({ release })` is fed the build id `serve.ts` already computed — never a
second deploy identity. Trace and span resolve as a **pair**, from one source and never field by
field: a caller-supplied `traceId` picking up the ambient `spanId` produced reports naming a span
in a different trace, which is worse than no span because it looks authoritative.

`METRICS_PATH` is served by `@ultimat3/cli`'s `metrics-endpoint.ts`, on `METRICS_PORT` (9090) and
**not** on the role's HTTP port: the chart's ingress routes `/` to `web`, so `/metrics` beside
`/healthz` would be the app's route patterns and error rates on the internet. Every role opens it,
including the three that open no other socket — `queue_depth` belongs to one of them.

```bash
bun test packages/core/src    # from the REPO ROOT, never from packages/core
bun run typecheck
```

**The root is not a preference.** `bunfig.toml`'s `preload = ["./scripts/test-setup.ts"]` is what
installs `@ultimat3/testing`'s matchers, and Bun reads `bunfig.toml` from the cwd — so `bun test`
run inside `packages/core` loads no preload and 17 tests in `secrets.test.ts` die on
`expect(...).rejects.toBeUltimateError is not a function`, which reads as this package's failure
and is the shell's. `.github/workflows/ci.yml`'s `package` job spawns `bun test packages/<pkg>`
with `cwd` at the root for the same reason (`scripts/coverage-gate.ts`).

`markReady()` means **bound**, and readiness means **usable** — two different facts since
`registerReadinessCheck(name, check)`. `/readyz` is ready only when the state is `ready` AND every
named check passes, and `HealthReport.checks` carries them by name because "alert on check
failures by check name" is not writable against a boolean. `HealthReport.registered` carries the
COUNT beside it, `As of 2026-08-22`: `checks: {}` reads identically for "every check passed" and
"nobody registered one", and only the second is a `/readyz` meaning no more than "the socket is
bound". Reported, never enforced — **an empty registry is still `ready`, and `/readyz` still
answers 200**: `Object.values({}).every(…)` is vacuously true, and that is deliberate so a role
with no dependency does not have to invent a check to boot. `registered` is the field a caller
reads to tell "all checks passed" from "there were none".

`readinessChecks()` builds its record through `Object.fromEntries`, never by assigning
`results[name]` — assignment to the one name `__proto__` sets the PROTOTYPE rather than adding a
key, so a check by that name disappeared from the report and a `failing` one answered 200. Checks are **synchronous** on purpose:
a probe that awaits a network call turns a slow dependency into a wedged endpoint and a restart
loop, so the owner of the dependency keeps a boolean fresh and this reads it. Liveness ignores
them — a database outage that failed `/healthz` would restart the whole fleet into the same
outage. The registration returns its unregister, same shape and same ownership rule as
`onShutdown`; `readinessCheckCount()` is the leak probe.

**`drain()`'s memo is published BEFORE the first hook runs, `As of 2026-08-22`, and that ordering
is the whole of the function.** A hook may call back into `drain()` and one does — `handle.stop()`
in `@ultimat3/http` is `drain('manual')`, and an `accept` hook is exactly where a server stops
listening — while `settleWithin` invokes a hook SYNCHRONOUSLY. `drainPromise = (async () => …)()`
had therefore not assigned when the first hook ran: the re-entrant call read `undefined`, started a
second whole drain and recursed **~4,700 deep** until the stack ran out, every level swallowed by
`settleWithin` as `shutdown hook failed`. The guard and the registration are now one synchronous
step (`jobs`' `worker.ts` states the same rule), with the phases in `runDrain`.

**The drain deadline is enforced, not merely computed, and there is no unbounded state.**
`ShutdownReason.deadlineAt` was always handed to every hook and **no hook has ever read it** —
`jobs`' worker awaits every in-flight job and `driver.close()`, `jobs`' scheduler awaits its round,
`realtime`'s `listenSyncNode` awaits `node.drain()`'s own grace, `http`'s `server.ts` awaits
`server.stop()` — so before 2026-08 `configureLifecycle({ deadlineMs: 100 })` bounded nothing:
measured, one 5-second `accept` hook drained in **5053ms**, state pinned at `draining`. `runPhase`
now races each hook against the time left before `deadlineAt` (`lifecycle-deadline.ts`'s
`settleWithin`, split out so the race cannot reach this file's state) and an overrun is
**ABANDONED** — the drain resolves, the later phases still run, and `installSignalHandlers` reaches
`process.exit(0)`. Merely logging would leave the kubelet to SIGKILL at the grace period, which is
the every-deploy job duplicate draining exists to prevent; the abandoned hook keeps running with
nobody reading it, and that cost is named in the log line rather than hidden. `settleWithin`
attaches a rejection handler unconditionally: an abandoned hook that rejects later has nobody left
awaiting it, and the unhandled rejection would kill the process the drain is ending cleanly.

Three rules follow and none is optional. **The budget is the WHOLE drain's**, read per hook off
`deadlineAt`, so a hook that spends it leaves none for the ones behind — the sum of the phases is
bounded, not each phase separately, which is what `terminationGracePeriodSeconds` means. A budget
already spent still lets a *synchronous* hook finish (a resolved promise settles on a microtask,
the 0ms timer on a macrotask), so closing a pool costs nothing it does not already have.
**`DEFAULT_DEADLINE_MS` (25s) applies whether or not an app sets one** — an opt-in deadline would
have left `worker`, `scheduler` and `sync` unbounded, i.e. a mechanism claiming more than it
enforces; abandoned at 25s a worker exits clean, its row's visibility lease lapses and another
worker re-claims it, which is what at-least-once already promises, and the alternative is the same
duplicate delivered by SIGKILL with no line naming what overran. The lever is a **larger** value —
`configureLifecycle({ deadlineMs: 600_000 })` for a 10-minute job — and the `X_SHUTDOWN_TIMEOUT`
`fix:` says so, because whoever reads it at 3am learns the knob from the line. **The budget is real
monotonic time (`systemClock`), never the injected `clock`**: `waitForIdle` sleeps on a real
`setTimeout`, so a frozen clock advanced an hour handed the drain a 16-minute grace period the
kubelet would never honour. `clock` still owns `uptimeMs`. `drainDeadlineMs()` is the one place the
budget is decided and the only thing a test can pin — 25s is above any drain a test can wait out.

`impersonate(actor, reason, fn)` is the ONE door through `withChildContext({ actor })`. It stamps
the caller onto the child as `Actor.onBehalfOf`, so `actorLabel` renders
`service:eng-7→user:cust-99@org-3` and a refund issued during a support session can never read as
the customer's. The non-blank-reason assert is `@ultimat3/entity`'s `crossTenant()` template
verbatim — two escapes from the framework's default posture should not look like two things. Do
not add a second impersonation path.

**`ERROR_DOCS_URL` replaced `ERROR_DOCS_BASE` + `errorDocsUrl(code)` `As of 2026-08-23`, and it is
a breaking change** — it lands in the next major, not in the released line. `https://ultimate.dev/errors/<code>` answered **404**, host included, on every error the
framework has ever thrown — including the first line a new agent reads (`x --json` →
`"docs":"https://ultimate.dev/errors/X_CLI_UNKNOWN_COMMAND"`). A dead link in every error is a
defect under axiom 4, and it is not "not built yet": `wiki/` is the only public documentation
surface there is. There is no per-code URL because there is no per-code ANCHOR — codes live in
`wiki/Error-Codes.md` as TABLE ROWS, and a `#X_DB_DRIFT` fragment would be a second dead
declaration rather than a fix for the first. So the function is gone rather than kept with an
ignored parameter, and `descriptor()` lost its `code` parameter with it. A package constructing an
`UltimateError` now OMITS `docs:` entirely and lets the constructor resolve the registered
descriptor — one URL, one place, instead of the fifteen packages that each spelled the base out.

Every `UltimateError` carries `retry` (`terminal | retryable | retry-after`), **defaulting to
`terminal`** — fail closed, because a client retrying on `status >= 500` hammers `X_DB_DRIFT` and
`X_TENANCY_UNSCOPED`, which are permanent config faults. `registerErrorRetry()` is the one
registration path and it refuses to reclassify a core code, the same way `registerErrorStatus`
refuses to remap one. A new code in any package should be classified beside its declaration.

Two readers of that table, and picking the wrong one is a live defect. `retryFor(code)` answers
*what to do* and fails closed; `declaredErrorRetry(code)` answers *what somebody declared* and is
`undefined` when nobody did. `retry` on the instance is `init.retry ?? retryFor(code)`, so every
unclassified error already reads `terminal` — a caller deciding whether to STOP work in flight
(`@ultimat3/jobs`' executor) must read `declaredErrorRetry`, or it dead-letters attempt 1 of every
job in every app whose codes nobody classified. An instance `retry: 'terminal'` on an **unregistered**
code is indistinguishable from the default and is therefore read as unclassified; registering the
code is the one way to have it honoured.

Gotchas:
- `exactOptionalPropertyTypes` is on — declare optional fields as `x?: T | undefined`.
- `noPropertyAccessFromIndexSignature` is on — `ctx.services['mail']`, not `.mail`.
- `Ctx` carries a string index signature so apps can augment `CtxServices` for `ctx.posts`. The
  cost is a real axiom-3 hole: `ctx.anything` type-checks as `unknown`, so a service nobody
  declared and nobody installed reads as a value rather than a build error (`examples/dummy`
  shipped `ctx.storage.ensureBucket()` against a method no package has). Deleting the signature
  is the fix and a breaking change; until then `ctx.services['mail']` is the honest late-bound
  path and a declared augmentation is the only typed one. **Measured 2026-08:** deleting the
  signature compiles core clean on its own, and the augmentation seam survives untouched — an
  augmentation adds NAMED members and `Ctx extends CtxServices` picks them up with no index
  signature at all. What is unmeasured is the rest of the tree: the change is only a build error
  where an app reads an undeclared service, which is the point, but `examples/dummy` ships one
  such read and it would land on the app gate's ratchet. Land it as its own change, alone, with a
  full `bun run verify` — never folded into another branch.
- **`Ctx extends CtxFacts, CtxServices`, and `createContext` holds the framework's ONE irreducible
  assertion** (`As of 2026-08-24`). Different hole from the bullet above, and the note there —
  "an augmentation adds NAMED members and `Ctx extends CtxServices` picks them up with no index
  signature at all" — is exactly why: those NAMED members are then REQUIRED of every value typed
  `Ctx`, and no framework function can obtain them. They arrive through `init.services` (a
  `ServiceBag`, string-indexed) and through `installedServices()`, which returns the same. So
  `createContext` cannot type-check its own literal against `Ctx`, and neither could
  `@ultimat3/http`'s `createRequestContext`, which failed to compile inside `examples/dummy` with
  `TS2739: missing posts, orgs` while this repo's own gate — augmenting nothing — stayed green.

  `CtxFacts` is everything the FRAMEWORK sets; `Ctx` is that plus `CtxServices`. Structurally
  identical for a reader, and everything for a constructor. It bought two deletions: the `preview`
  assertion is gone (that value is honestly a `CtxFacts`, which is also what a `ServiceFactory`
  receives — a factory has never been able to read a sibling service and the type now says so),
  and `@ultimat3/http` has **no assertion at all**, because `createRequestContext` composes
  `createContext()` instead of building a second context beside it.

  **One `as Ctx` remains and four alternatives were built and measured before it was kept.**
  `Partial<CtxServices>` removes it and makes `ctx.posts` `PostRepo | undefined` for every app —
  true, and a breaking change to the documented seam. Typing `CtxInit.services` as `CtxServices`
  moves the proof to the caller and breaks every internal `createContext()` in an app's program,
  because an app typechecks this tree's sources through its project references. A generic
  `createContext<S>` returns a context no framework caller can pass where a `Ctx` is wanted. An
  overload whose implementation signature returns the looser type compiles only through
  TypeScript's documented bivariance hole — the same assertion, laundered. The file header carries
  this list; the structural repair is a major and belongs with the index-signature deletion above.
- Tests that touch the registry, the lifecycle or the listener table must call
  `resetErrorCodes()` / `resetLifecycle()` / `resetListeners()`.
- `onShutdown`'s return value is the unregister, and every caller that can be started twice owns
  it — `@ultimat3/http`'s `server.ts`, `@ultimat3/realtime`'s `listenSyncNode`, `@ultimat3/jobs`'
  worker, `@ultimat3/cli`'s `hold.ts`. `shutdownHookCount()` is the test-only probe, the same
  shape as `idleWaiterCount()`: a count that climbs across a start/stop cycle is a leak.
- The error-code registry is process-global and every package fills it once, at import time. A
  test that resets it must take `errorCodeSnapshot()` first and call the returned undo in
  `afterAll` — a reset that is not handed back strips the titles of every package imported before
  that file, and their errors render the humanised fallback (`X_DB_DRIFT: db drift`) for the rest
  of the run. That is a load-order flake: green locally, red on whichever CI ordering hits it.
- Tests that call `configureCursorSigning()` must restore the previous secret, or call
  `resetCursorSigning()` — the only way back to "unconfigured", which restoring a literal cannot
  express. The secret itself is read inside `sign()`, never at module scope: `openSecrets()` runs
  during boot, so a module-scope read signed a whole process's cursors with the dev key while
  `ULTIMATE_CURSOR_SECRET` was set and `x doctor` merely warned. Same call-time rule as
  `@ultimat3/auth`'s `oauth-cookie.ts` / `oauth-exchange.ts`; new secrets follow it.
- `PRIMITIVE_KINDS` is the executable copy of the eight-primitive rule — `PrimitiveKind` derives
  from it, so the list and the type cannot drift. A ninth entry fails `registrar.test.ts`, which
  is the point: a new capability arrives as a factory over an existing primitive (`llm()` returns
  an `action`), never as a new kind.
