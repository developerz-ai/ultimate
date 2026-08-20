# 🧱 @ultimat3/core

Tier 0. The foundation every other Ultimate package imports and none of them may bypass.
Zero dependencies, zero `@ultimat3/*` imports.

| Owns | Module |
|---|---|
| `UltimateError`, the 3-line rendering, `--json` shape | `errors.ts` |
| rendering an app's value into a `cause` / `fix` without throwing | `error-render.ts` |
| code → `{ title, docs }` registry, `registerErrorCodes()` | `error-codes.ts` |
| `Result<T, E>` for boundaries where throwing is wrong | `result.ts` |
| request context on `AsyncLocalStorage` | `context.ts` |
| `Actor` (`user \| service \| agent \| anonymous`) | `actor.ts` |
| acting as another actor, with an origin and a reason | `impersonate.ts` |
| is an error worth retrying? one classification per code | `error-retry.ts` |
| typed env validated at boot | `env.ts` |
| `.env.example` rendered from that schema, and its drift check | `env-example.ts` |
| named environments + `ULTIMATE_ENV` resolution | `environment.ts` |
| a value that cannot be printed by accident | `secret.ts` |
| the committed encrypted secrets envelope, AES-256-GCM | `secrets.ts` |
| the two secrets files, and decrypted values → `defineEnv` | `secrets-store.ts` |
| `defineConfig()` for `app.config.ts` | `config.ts` |
| runtime roles + `ROLE` resolution | `roles.ts` |
| `Clock` — the only source of "now" | `clock.ts` |
| UUIDv7, nanoid, branded ids | `ids.ts` |
| structured JSON logging + redaction | `logger.ts` |
| OTel-shaped spans, always on, no-op by default | `telemetry.ts` |
| the sampling decision, and `OTEL_TRACES_SAMPLER*` | `sampler.ts` |
| OTLP/HTTP JSON: endpoint, headers, value encoding | `otlp.ts` |
| `SpanExporter` on the wire, batched | `otlp-span-exporter.ts` |
| `MetricExporter` on the wire | `otlp-metric-exporter.ts` |
| `reportError` + the `ErrorReporter` seam, no-op by default | `error-reporter.ts` |
| that seam on the wire, Sentry's envelope and DSN | `error-reporter-sentry.ts` |
| OTel-shaped counter / gauge / histogram, same seam | `metrics.ts` |
| the `/metrics` scrape body | `metrics-text.ts` |
| the series every process emits, incl. what the chart scales on | `runtime-metrics.ts` |
| graceful drain, `/healthz`, `/readyz` | `lifecycle.ts` |
| the sockets this process opened, so a self-request is not egress | `listeners.ts` |
| `defineService('orgs', …)` → `ctx.orgs`, rebuilt per actor | `service.ts` |
| the registrar table one same-tier package reaches another through | `registrar.ts` |
| decode → resize → encode, the one image pipeline (over `Bun.Image`) | `image/` |
| `assertNever`, `invariant` | `assert.ts` |

## Errors are instructions

```ts
throw new UltimateError({
  code: 'X_DB_DRIFT',
  cause: 'table "posts" has column "publish_at" not present in any migration',
  fix: 'x db gen "add publish_at"',
});
```

```text
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

`format()` is always 3 lines (`format({ docs: true })` adds a 4th). `toJSON()` is the `--json`
form: `{ code, title, cause, fix, docs, retry, meta, stack }`. The title comes from the registry, so
the terminal, the browser overlay and `--json` cannot drift.

`retry` is `terminal | retryable | retry-after`, and it **defaults to `terminal`** — a client that
retried on `status >= 500` hammered `X_DB_DRIFT` and `X_TENANCY_UNSCOPED`, which are permanent
config faults, during the incident they were already causing. Classify the codes your package or
app throws once, beside the module that declares them:

```ts
registerErrorRetry({ X_OAUTH_EXCHANGE_FAILED: 'retryable', X_RATE_LIMITED: 'retry-after' });
```

Core's own classifications are closed, exactly as `registerErrorStatus`'s framework table is: a
second, different registration for one code throws `X_ERROR_RETRY_INVALID`.

**Two readers, and the difference is load-bearing.** `retryFor(code)` answers *what to do* and
fails closed — `terminal` for a code nobody classified. `declaredErrorRetry(code)` answers *what
somebody actually declared*, and is `undefined` when nobody did. `UltimateError.retry` is
`init.retry ?? retryFor(code)`, so every unclassified error already carries `terminal`: a caller
deciding whether to stop work already in flight reads `declaredErrorRetry`, and the job executor
that read `retryFor` instead would dead-letter attempt 1 of every job in every app whose codes
nobody has classified. An instance-level `retry: 'terminal'` on an **unregistered** code is
indistinguishable from that default and is read as unclassified — register the code
(`registerErrorRetry({ X_YOUR_CODE: 'terminal' })`), which is the one way.

| Code | Subclass |
|---|---|
| `X_CONFIG_INVALID` | `ConfigInvalidError` |
| `X_ENV_MISSING` | `EnvMissingError` |
| `X_NOT_IMPLEMENTED` | `NotImplementedError` |
| `X_INTERNAL` | `InternalError` |

Your package declares its own codes in `src/errors.ts` and registers them once:
`registerErrorCodes({ X_DB_DRIFT: { title: 'schema differs from migrations' } })`.
Registering a code twice throws `X_ERROR_CODE_DUPLICATE`.

`isUltimateError()` is duck-typed on `Symbol.for('ultimate.error')`, not `instanceof` — that is
how `@ultimat3/schema` (tier 0, cannot import core) still produces matching errors.

### A value you did not produce goes through the renderer

An error factory may never throw while formatting its own message: the caller then catches a
`TypeError` instead of the refusal, `error.code === 'X_…'` matches nothing, and an HTTP surface
answers 500 where the mapped status belonged. `JSON.stringify` throws on a bigint and on a cycle
and RUNS any `toJSON` the value carries; `` `${value}` `` throws on a symbol and on a hostile
`toString`. Both are reachable from app data.

```ts
import { renderCauseValue, renderFixLiteral, UltimateError } from '@ultimat3/core';

declare const kind: unknown;
declare const value: unknown;

throw new UltimateError({
  code: 'X_ID_INVALID',
  cause: `expected a ${renderCauseValue(kind)} UUIDv7, received ${renderCauseValue(value)}`,
  fix: `pass an id produced by typedId<${renderFixLiteral(kind, '<kind>')}>()`,
});
```

| Helper | For | Degrades to |
|---|---|---|
| `renderCauseValue(value)` | a `cause`, which only has to describe | `a object that cannot be rendered` |
| `renderFixLiteral(value, placeholder)` | a `fix`, which has to parse and run | the placeholder you name |
| `renderThrowable(value)` | a caught value: an `Error`'s own words, anything else rendered | `renderCauseValue(value)` |
| `isThrownError(value)` | `value instanceof Error` where the test itself may throw | `false` |
| `stringField(value, key)` | one string field off a caught value | `undefined` |

The last two are the READ side, and the reason they exist is that the renderers above them were
being reached past an unguarded probe. `catch (error)` hands you a value the framework did not
build: `error instanceof Error` runs a `Proxy`'s `getPrototypeOf` trap, and
`typeof error.code === 'string'` — the structural check every surface uses to recognise an
`UltimateError` that crossed a worker, a subprocess or a socket — is a getter call. Either one
throws one line *before* the total renderer that was meant to make the path safe.

```ts
const code = stringField(error, 'code') ?? 'X_TRANSPORT_UNAVAILABLE';
const cause = stringField(error, 'cause') ?? renderThrowable(error);
```

`stringField` answers `undefined` for absent, wrong type and threw, because all three mean the
same thing to the caller: this value did not supply the field, so use the default.

Enforced, not documented: `x verify`'s `errors` step fails with `X_ERROR_RENDER_UNSAFE` when a
parameter typed `unknown` reaches a `cause:` or `fix:` through `JSON.stringify`, `String()` or a
bare interpolation (`scripts/error-render.ts`).

## Context

```ts
const ctx = createContext({ actor: agentActor({ id: 'mcp-1', scopes: ['post:publish'] }) });
await runWithContext(ctx, async () => {
  const { actor, locale, tz, logger } = useContext();   // throws X_NO_CONTEXT outside
  await withChildContext({ locale: 'es' }, () => render());
});
```

Concurrent requests never leak into each other. `ctx.logger` carries `requestId` + `traceId`
automatically; so does the root `logger` while a context is active. Add typed services by
augmenting `CtxServices`; reach late-bound ones with `useService<T>('mail')`.

A service that reads the actor (`ctx.posts`, scoped to `ctx.actor.orgId`) registers once with
`defineService('posts', (ctx) => ({ ... }))`, at import time. `createContext` and
`withChildContext` then build it fresh, bound to whichever actor they are constructing a ctx
for — importing the module that calls `defineService` is the registration, the same convention
`registerActions` uses. Passing `services: { posts: ... }` to `createContext` still works and
wins over a registered factory of the same name, for a test that wants to hand in a mock.

A factory runs again on **every** `createContext` / `withChildContext` call and is never cached,
because it closes over the ctx (actor, clock, tz) it was built for. `withChildContext` drops a
factory-managed name from what it carries forward on purpose: only an ad hoc service nobody
registered survives an actor swap unrebuilt.

## Actor facts — the app's own authz vocabulary, on the framework's actor

Roles and an org id answer a columnar question ("same tenant?"). They cannot answer a relational
one ("a friend of the author?"), and a policy predicate is synchronous, so it may not go and
fetch one. Resolve the graph ONCE per request and hand it to the actor every surface already
carries:

```ts
declare module '@ultimat3/core' {
  interface ActorFacts { readonly viewer: Viewer }   // declared once, app-wide
}

// at the request boundary, where the await already happens
const actor = withFacts(userActor({ id: user.id, roles: [user.role] }), { viewer });

// in a predicate, on any surface — HTTP, MCP, admin, a job
can('post:read', ({ row, actor }) => row !== null && canSee(actorFact(actor, 'viewer'), row));
```

| Rule | Why |
|---|---|
| `actorFact(actor, key)` takes `Actor \| null` | that is exactly what a predicate is handed |
| every fact is `T \| undefined` | nothing can prove one was resolved — a job, a test and a token exchange mint actors too, so an absent fact is a **denial** the compiler makes you write |
| `facts` is optional on `Actor` | additive: an actor literal written before the seam is still an `Actor` |
| the framework declares no fact | `ActorFacts` is the app's; core only owns the seam. `type-pins.ts` pins the machinery against a local sample rather than augmenting the real interface |

Not a second authz path: the facts ride the actor the policy layer already reads, so no surface
package learns the app's vocabulary and one `Policy` object still answers everywhere. Facts are
request-scoped and never logged — `actorLabel()` stays id-only.

## Env fails once, completely

```ts
export const env = defineEnv({
  DATABASE_URL: { type: 'url', secret: true },
  PORT:         { type: 'port', default: 3000 },
  REGION:       { type: 'enum', values: ['us', 'eu'] },
  SENTRY_DSN:   { type: 'url', required: false },
  NATS_URL:     { type: 'url', role: 'sync' },   // only required for ROLE=sync
});
```

Every missing or malformed key is listed in one `X_ENV_MISSING`. `secret: true` keys are
redacted in logs and masked in `checkEnv()` output; `describeEnv()` emits declarations only,
safe for `x.manifest.json`. Omit `required` for required — `required: false` is the only
loosening. Never declare an env var for *which deploy this is* — that is `ULTIMATE_ENV`, below.

`.env.example` is a **projection** of that schema, never a second list:
`renderEnvExample(schema)` writes it, `assertEnvExample(schema, text)` fails with
`X_ENV_EXAMPLE_DRIFT` when a declared key has no line — the failure that otherwise arrives as
somebody else's `X_ENV_MISSING` on a variable nobody documented.

Loading `.env` is **Bun's**, not ours. `envFileCandidates()` states what it does, measured:
`.env` → `.env.<mode>` → `.env.local`, with `.env.local` skipped under test, and the mode being
`production`, `test` or **`development` for everything else — `staging` included**. There is no
`.env.staging`; a staging deploy carries real environment variables.

## One environment, one key

```ts
resolveEnvironment();      // 'development' | 'test' | 'staging' | 'production'
tryResolveEnvironment();   // the same, `undefined` instead of a throw for an unrecognised value
isProduction();            // exact; nothing else counts
isLocal();                 // development or test — never staging
```

`tryResolveEnvironment` is for a caller that must *answer* rather than fail — a `robots.txt` render
is the case: `ULTIMATE_ENV` is not in the env schema, so nothing validates it at boot, and a typo
would otherwise 500 the one response whose body was already going to be `Disallow: /`. It names no
fallback of its own; the caller does.

`ULTIMATE_ENV` is the key, `NODE_ENV` the fallback (platforms already set it). Values are
`NODE_ENV`'s spellings plus `staging` — `prod` and `dev` are typos, not aliases, and
`ULTIMATE_ENV=prod` is `X_ENVIRONMENT_INVALID`. An unrecognised `NODE_ENV` is *not* an error: it
is not our key. This is the twin of `roles.ts` — `ROLE` says what the process does,
`ULTIMATE_ENV` says which deploy it belongs to.

## A secret is redacted by value, not by name

```ts
const dsn = secret(process.env.DATABASE_URL ?? '', 'DATABASE_URL');
logger.info('boot', { dsn });        // {"dsn":"[redacted]"}
connect(revealSecret(dsn));          // the one greppable way out
```

`redactKeys()` catches a secret travelling under a name someone remembered to list. A `Secret`
box catches the other case: `String()`, template literals, `+`, `JSON.stringify`, `console.log`,
the logger and an error's `meta` all render `[redacted]`, whatever key it sits under. It is
frozen and everything but `label` is non-enumerable, so `{ ...dsn }` cannot spread the value back
out. There is no vault integration and there will not be one — that is a platform primitive
(axiom 7); a `Secret` plus the platform's own secret store is the whole design.

## Encrypted secrets are env values that arrive early

```ts
// app.config.ts
await installSecrets();                       // secrets.enc.json → process.env, real env wins
export const envSchema = {
  SESSION_SECRET: { type: 'string', secret: true },
} satisfies EnvSchema;
export const env = defineEnv(envSchema);
```

`secrets.enc.json` is committed; `.secrets.key` is not, and `ULTIMATE_SECRETS_KEY` is read before
it so a container is handed its key by the platform. The plaintext is a flat map of environment
variable names to values, so a secret keeps **one** declaration (`envSchema`), one `.env.example`
row, one mask (`maskedEnvValues`), one redaction entry and one reader (`env.SESSION_SECRET`).
There is deliberately no `secrets.get()`: a second accessor would mint values with no declaration,
no type and no mask, and each of those five would need a second implementation. `x secrets` is the
only writer.

| Envelope | |
|---|---|
| Cipher | AES-256-GCM through WebCrypto, 128-bit tag, a fresh 12-byte IV per seal |
| Key | 32 CSPRNG bytes, hex. No KDF — the key is the key |
| AAD | `v`, `alg` and `kid`, so a downgraded header fails the tag rather than changing how the body is read |
| `kid` | a domain-separated, truncated SHA-256 of the master key. Safe to commit, and what makes *wrong key* (`X_SECRETS_KEY_MISMATCH`) a different code from *edited file* (`X_SECRETS_TAMPERED`) |

A missing file is not an error — an app may declare no secrets. A file with **no key to open it**
is `X_SECRETS_KEY_MISSING` and fatal: a process that booted past its secrets authenticates against
nothing and still reports healthy.

## Time, ids, telemetry, drain

- Never call `Date.now()`. Take a `Clock`; tests pass `frozenClock('2026-07-26T10:00:00Z')`.
- `uuid()` is UUIDv7: time-prefixed, monotonic within a millisecond, never backwards on clock
  skew. `typedId<'post'>()` brands it so a post id cannot be passed where a user id is wanted.
- `withSpan('action.publishPost', fn)` is free until `configureTelemetry({ exporter })`.
  Traces cross process boundaries via `traceparent()` / `parseTraceparent()`, whose ids come from
  `traceId()` / `spanId()` — **never `uuid()`**, whose dashed 36 characters every collector
  rejects. `isTraceId()` / `isSpanId()` are the one definition of the valid shape.
- **Sampling is honoured, not just propagated.** `startSpan` takes the parent's bit when there is
  one, else asks the `Sampler`; `span.end()` exports nothing when the bit is 0. The default reads
  `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` at the first span, and
  `configureTelemetry({ sampler })` replaces it.
- **The OTLP exporters ship**, speaking OTLP/HTTP JSON, no dependency:
  `otlpSpanExporter({ endpoint })` (batched, with `flush()` / `shutdown()`) and
  `otlpMetricExporter({ endpoint })`. Both default to `OTEL_EXPORTER_OTLP_ENDPOINT`;
  `tryOtlpEndpoint('traces')` answers `undefined` when nobody configured one, so a boot can skip
  the exporter instead of throwing. **gRPC (`:4317`) is out of scope** and says so with
  `X_OTLP_PROTOCOL_UNSUPPORTED`.
- Metrics are the same shape one signal over: `counter()`, `gauge()`, `histogram()`, aggregated
  in process, free until `configureMetrics({ exporter })`. See below.
- `onShutdown(name, hook, { phase })` with phases `accept → inflight → close` under one
  deadline; `readyzPayload()` flips to 503 the moment draining starts, `healthzPayload()` stays
  200 until stopped. It **returns an unregister**, and a caller that starts and stops more than
  once has to keep it: a discarded one is a hook per `start()`, each retaining the resource it
  was going to drain, and the next drain runs every one of them against a torn-down copy.
  `shutdownHookCount()` is the test-only probe that makes the leak assertable.
- Anything that opens a socket calls `markListening(server.url.origin)` and releases it on close.
  That is what tells the sealed test network a loopback request is this process, not egress.

## Metrics: same seam as tracing, one signal over

```ts
const published = counter('posts_published_total', { description: 'posts published' });
published.add(1, { plan: 'pro' });

gauge('queue_depth', { observe: () => pending() });   // read at scrape time, never stale
histogram('render_duration_seconds').record(ms / 1000);

metricsText();          // the /metrics body, at METRICS_PATH, METRICS_CONTENT_TYPE
collectMetrics();       // the same numbers as data, for a MetricExporter
```

| | |
|---|---|
| Kinds | `counter` (monotonic sum), `gauge` (`record` / `add`, or an async `observe`), `histogram` (explicit bounds, OTel's default latency set) |
| Temporality | cumulative, as OTel defines it — a read never resets a counter, so two scrapers cannot steal each other's samples |
| Names | lowercase `snake_case`, the intersection every exposition format accepts. Dotted OTel names survive OTLP and die at a Prometheus scrape |
| Attributes | `string \| number \| boolean` only — each distinct set is a stored series, so a user id here is an outage |
| Cardinality | enforced, not advised: `maxSeries` per instrument (default `DEFAULT_MAX_SERIES`), and past it every new label set folds into one `otel_metric_overflow="true"` series with `X_METRIC_CARDINALITY` logged once, naming the instrument |
| Async gauges | an `observe()` that throws, or answers a non-finite number, costs that instrument its point and **nothing beside it** — `X_METRIC_VALUE_INVALID` logged once, naming the instrument. Unguarded it took the whole `/metrics` body down with it, and `startMetricExport`'s timer callback raised where nothing can catch it |
| Driver seam | `MetricExporter`, defaulting to a no-op. `memoryMetricExporter()` for tests, `startMetricExport(ms)` for a periodic push, `otlpMetricExporter()` for a collector |

`runtime-metrics.ts` holds the series every process emits, and `SCALING_METRICS` maps each
`ScalingSignal` from `roles.ts` to the one that carries it — so the role table, the chart and the
process cannot drift apart:

| Role scales on | Series | Instrument |
|---|---|---|
| `rps` | `http_requests_total` | counter; `rps` is a **rate** the adapter derives (`rate(http_requests_total[1m])`), never a stored number |
| `ws-connections` | `connections` | gauge, `+1`/`-1` |
| `queue-depth` | `queue_depth` | gauge, by `queue` label |

`As of 2026-08` all three are emitted and scraped. One call site per package — `recordRequest`
from `@ultimat3/http`'s pipeline, `recordConnection` from `@ultimat3/realtime`'s socket table,
`recordQueueDepth` from `@ultimat3/jobs`' worker loop — and `@ultimat3/cli` serves `metricsText()`
at `METRICS_PATH` on `METRICS_PORT` (9090), for every role rather than only the ones that open an
HTTP socket. Labels are route **patterns**, status **classes** and queue names: nothing
per-user, per-id or attacker-chosen ever becomes a series.

## Error reporting: the third seam, same shape as the other two

A no-op by default, one transport on the wire, one memory double for tests — `telemetry.ts` and
`metrics.ts`' shape a third time. What a monitor receives is the framework's error contract
verbatim, so it groups on `code` and shows `fix` to whoever is paged.

**An Ultimate app installs nothing.** `@ultimat3/cli`'s `serve.ts` calls
`configureErrorReporting` at boot from one env var — `SENTRY_DSN`, unset meaning the no-op stays
and nobody is paged — and passes the build id it already computed as `release`. The call below is
for a host that boots something other than `runRole`.

```ts
import { configureErrorReporting, reportError, sentryErrorReporter } from '@ultimat3/core';

declare const sentryDsn: string;
declare const buildId: string;
declare const failure: unknown;

configureErrorReporting({
  reporter: sentryErrorReporter({ dsn: sentryDsn }),   // config, never a constant in this package
  release: buildId,                                    // the id `x-ultimate-build` carries
});

reportError(failure, { source: 'http', severity: 'error', scope: { operation: 'POST /api/posts' } });
```

| | |
|---|---|
| `reportError(error, { source, severity?, scope? })` | never throws, never awaits. A monitor that is down must not turn one failure into two |
| `ERROR_SOURCES` | `http` `job` `realtime` `cli` `process` — closed. A new surface adds a member, never a string of its own |
| `ErrorSeverity` | `warning` `error` `fatal`. `warning` is a failure the framework already recovered from — a retry, not a dead letter |
| `ErrorScope` | `requestId` `traceId` `spanId` `role` `operation` `actorId` `extra`. `operation` is a route **pattern** or a job name, never a concrete path or a row id |
| `ErrorReport` | `code` `title` `cause` `fix` `docs` + `meta` `stack` `resource` `environment` `release` `scope`, and the thrown value under `error` |
| `configureErrorReporting({ reporter, clock, release, environment, enabled })` | the one install point; `resetErrorReporting()` puts the no-op back |
| Reporters | `noopErrorReporter` (default), `memoryErrorReporter()` (`.events`, `.reset()`), `sentryErrorReporter({ dsn, fetch?, clientName? })` |
| Wire, testable alone | `parseSentryDsn(dsn)` → `{ publicKey, envelopeUrl, … }`, `sentryEnvelope(report, { dsn, eventId })` → the envelope body. Pure, exactly as `otlpTraceRequest` is |
| `errorReport(error, options)` | the normalisation on its own, for a transport's test or a surface that enriches before sending |

`As of 2026-08` four packages call `reportError`, seven call sites in all: `@ultimat3/http`'s
`stages.ts` (`status >= 500` only), `@ultimat3/jobs`' `executeJob` — the one frame still holding the
thrown value — `@ultimat3/realtime`'s `sync-node.ts` and `sync-upgrade.ts`, and `@ultimat3/flags`'
`runtime.ts` (`source: 'process'`, severity `warning`). Trace and span resolve as a **pair** from
one source: a caller-supplied `traceId` never picks up the ambient `spanId`, because a report
claiming a span from a different trace sends whoever is paged somewhere authoritative and wrong.

`ErrorReporterDsnInvalidError` (`X_ERROR_REPORTER_DSN_INVALID`) is the only code this seam owns —
raised at `parseSentryDsn`, at configuration, never at a report.

## One cursor, everywhere

```ts
encodeCursor({ scope, key: ['2026-01-01T00:00:00.000Z'], id: 'p_9' }); // base64url(body).hmac
decodeCursor(cursor, scope);                                          // or X_CURSOR_INVALID
```

Keyset pagination is the repo's, the read primitive's and the admin's — so the codec is here,
signed once and verified once, and a second one anywhere is the regression `cursor.ts` exists to
prevent. `scope` binds a cursor to one read: the entity plus its filters and sort order for a repo
page, `queryHash(name, input)` for a `query`, the resource for the admin. It is a **required**
argument to `decodeCursor` on purpose — an optional check is one a call site can forget, and a
forgotten one pages a listing with another read's cursor. Replaying one is `X_CURSOR_INVALID`,
never a silently wrong page.

| | |
|---|---|
| Signature | truncated HMAC-SHA256, compared in constant time |
| Secret | `configureCursorSigning()` at boot, else `ULTIMATE_CURSOR_SECRET`. **Read when a cursor is signed, never at import** — an app whose `openSecrets()` sets the variable during boot would otherwise sign every cursor with the dev key. Rotating it invalidates every open cursor |
| Signed, not encrypted | the client already has these rows; what it must not do is *invent* a position |
| `usesDevCursorSecret()` | true while the shipped dev key is in use |
| `resetCursorSigning()` | test seam: forget `configureCursorSigning` and fall back to the environment |

## One bounded cache for every `Intl` formatter

```ts
import { cachedFormatter, canonicalLocale } from '@ultimat3/core';

const cache = new Map<string, Intl.NumberFormat>();

export function euroFormatter(locale: string): Intl.NumberFormat {
  // `EN-us` and `en-latn-us` collapse to one key, so one locale cannot evict itself.
  const tag = canonicalLocale(locale) ?? locale;
  return cachedFormatter(
    cache,
    `${tag}|EUR`,
    () => new Intl.NumberFormat(tag, { style: 'currency', currency: 'EUR' }),
  );
}
```

A locale arrives from `Accept-Language` and a zone from `x-timezone`, so an unbounded `Map` keyed
on that string is **memory the client chooses**. Measured `As of 2026-08`: 4,096 casings of one
zone name retained 31 MB, and 20,000 valid `en-US-x-*` tags through `formatMoney` retained 55.1 MB.
The bound
(`MAX_CACHED_FORMATTERS`, 512, FIFO) and the canonical key are two halves of one rule and neither
is sufficient alone — an unknown `-u-` extension value survives canonicalization as a distinct
string, and the cap alone lets one locale evict itself under three spellings. A miss costs one
`Intl` construction, never a wrong answer, which is what makes the bound safe. It lives here rather
than in `@ultimat3/time` because `@ultimat3/money` needs it too and tier 1 may not import sideways.

## One image pipeline, everywhere

```ts
probeImage(bytes);                                     // { format, width, height, mimeType }
await transformImageBytes(bytes, { width: 640, format: 'webp', quality: 80 });
await blurDataUrl(bytes);                              // ThumbHash PNG data: URI, the LQIP
```

`storage` variants, `seo` `<picture>` sources and `pwa` icons are the same three steps —
decode, resize, encode — with different numbers, so there is one implementation and no second
scaler for an icon to grow a halo in. The codecs are **`Bun.Image`** — statically-linked
libjpeg-turbo / libspng / libwebp with SIMD resize kernels, in the runtime. Still zero
dependencies: no `sharp`, no native module.

Every terminal is `async`, because the pipeline runs on a worker thread. `probeImage` stays
synchronous: it reads a header and never decodes, which is also why it measures SVG and AVIF that
no codec here reads.

| | |
|---|---|
| Decode | PNG, JPEG, WebP, GIF. `canDecode()` publishes the real list |
| Encode | PNG, JPEG, WebP. `canEncode()` publishes the real list |
| Probe only | AVIF and SVG — measured from the header so `width`/`height` still inline and CLS stays 0 |
| Anything else | `X_IMAGE_UNSUPPORTED`, naming the format and pointing at an `ImageTransformDriver` |
| Ceiling | `MAX_IMAGE_PIXELS` (64MP), passed to the decoder as `maxPixels` and refused from the header **before** a byte is allocated |
| Determinism | same bytes + same spec → same output bytes, **on every platform** |

**AVIF and HEIC are refused everywhere, deliberately.** `Bun.Image` can reach them through an OS
codec (ImageIO on macOS, WIC on Windows), and this pipeline sets `Bun.Image.backend = 'bun'` on
every call to forbid exactly that: the static codecs and the Highway geometry kernels are what make
a laptop and a Linux node produce the same bytes, and `variantKey` is content-addressed. A variant
that re-encoded differently per platform is a cache that never hits. Producing AVIF means a CDN or
a custom `ImageTransformDriver`.

`transformImageBytes` has two paths and picks by geometry. When the resampled artwork IS the output
box it is one `Bun.Image` call, source bytes to encoded bytes. When it is not — a letterbox, a
`padding`, a `cover` crop — the artwork comes back as PNG and `canvas.ts` composites it, because
`Bun.Image` resamples but has no compositor and the PWA maskable safe zone is a composite.
`png-pixels.ts` is the raw-pixel seam that hop needs, 8-bit RGBA only; anything else is
`X_IMAGE_UNSUPPORTED` naming `transformImageBytes`.

Adding a format is an entry in `DECODABLE_FORMATS` / `ENCODABLE_FORMATS` and a branch in
`withFormat` — never a second dispatch. An unencodable `format` is refused from the spec alone,
before the source is decoded, so a request nothing can write never expands 64 megapixels first.

`Bun.Image` rejects with `ERR_IMAGE_*` on `error.code`. `imageFromBunError` is the ONE place that
is read, mapping it onto `X_IMAGE_UNSUPPORTED` / `X_IMAGE_TOO_LARGE` / `X_IMAGE_DECODE_FAILED`; no
caller branches on a Bun code.

Two files in `image/` are past the 200-line target and neither splits without inventing a seam:
`probe.ts` is one algorithm per format over header bytes, and `fixtures.ts` is data. The 500-line
hard ceiling applies to both. Everything else in `image/` is under the target — deleting the
hand-rolled JPEG and PNG codecs is what put it there.

`image/fixtures.ts` is byte-exact output from Pillow and ffmpeg on purpose: a codec that only round
trips against itself proves nothing. Never regenerate a fixture with our own encoder.
