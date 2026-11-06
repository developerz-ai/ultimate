# Observability

Metrics, spans, and structured logs — all in `@ultimat3/core`, all dependency-free.

`As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)).

Counter, gauge and histogram sit on the OpenTelemetry data model, aggregate in process, and are read through one `collectMetrics()`. The wire format is a **driver**: `MetricExporter` is the seam, the default is a no-op, and `metricsText()` renders the Prometheus/OpenMetrics scrape body. An **OTLP client ships** `As of 2026-08`: `otlpMetricExporter()` and `otlpSpanExporter()` speak OTLP/HTTP JSON over `fetch` and read `OTEL_EXPORTER_OTLP_ENDPOINT` (and the `_METRICS_`/`_TRACES_ENDPOINT`, `_HEADERS`, `_PROTOCOL` variants), with no new dependency. Two limits: **gRPC on `:4317` is refused** with `X_OTLP_PROTOCOL_UNSUPPORTED` and will stay refused — HTTP/2 plus protobuf is a dependency and a second wire format, so point the collector's HTTP receiver at `:4318` — and there is **no logs signal**. Scraping `metricsText()` with an agent remains equally supported.

## Instruments

```ts
import { counter, gauge, histogram } from '@ultimat3/core';

const signups = counter('signups_total', { unit: '{signup}', description: 'completed signups' });
const inflight = gauge('inflight_requests');
const latency = histogram('external_call_seconds', { unit: 's', bounds: [0.1, 0.5, 1, 5] });

signups.add();                            // value defaults to 1
signups.add(3, { plan: 'pro' });
inflight.record(12);
inflight.add(-1);
latency.record(0.42, { host: 'stripe' });
```

| Kind | Methods | Notes |
|---|---|---|
| `counter(name, options?)` | `add(value = 1, attributes = {})` | cumulative and monotonic — a negative delta throws `X_METRIC_VALUE_INVALID` |
| `gauge(name, options?)` | `record(value, attributes = {})`, `add(delta, attributes = {})` | the kind for a number that can fall. `options.observe` supplies a pull callback |
| `histogram(name, options?)` | `record(value, attributes = {})` | `options.bounds` overrides `DEFAULT_HISTOGRAM_BOUNDS` |

`DEFAULT_HISTOGRAM_BOUNDS` is `0.005 0.01 0.025 0.05 0.075 0.1 0.25 0.5 0.75 1 2.5 5 7.5 10` — seconds, so an HTTP or RPC duration needs no bounds of its own.

Defaults when omitted: `unit: '1'`, `description: ''`.

| Failure | Code |
|---|---|
| a name that is not lowercase `snake_case`, or one name declared as two kinds | `X_METRIC_NAME_INVALID` |
| `NaN`, `Infinity`, or a counter decremented | `X_METRIC_VALUE_INVALID` |

Dotted OTel names survive OTLP but not a Prometheus scrape, and the autoscaler reads the scrape — which is why the name rule is `^[a-z_][a-z0-9_]*$` and not a suggestion.

## Attributes

`Readonly<Record<string, string | number | boolean>>`. Every distinct attribute set is its own series, so an attribute carrying an id or a raw path is an unbounded-cardinality bug, not a richer metric.

## Reading them

```ts
import { collectMetrics, configureMetrics, exportMetrics, startMetricExport } from '@ultimat3/core';

collectMetrics();                            // a MetricCollection: { at, resource, metrics }
configureMetrics({ exporter: myExporter });  // install the seam
exportMetrics();                             // collect + hand to the exporter, once
const stop = startMetricExport(60_000);      // periodic; the timer is unref'd. Default 60s
```

| Type | Shape |
|---|---|
| `MetricExporter` | **one** method: `export(collection: MetricCollection): void` |
| `MetricCollection` | `{ at, resource, metrics }` — `at` is epoch ms from the configured clock, metrics sorted by name |
| `ReadableMetric` | `{ descriptor, points }` |
| `MetricDescriptor` | `{ name, kind, unit, description }`, `unit` in UCUM |
| `MetricPoint` | `{ attributes, value }` |
| `HistogramPoint` | adds `count`, `min`, `max`, `bounds`, `buckets` — `buckets` is one longer than `bounds`, the last being the `+Inf` overflow |

Temporality is **cumulative**. Shipped exporters: `noopMetricExporter` (the default) and `memoryMetricExporter()` for tests. `resetMetrics()` restores the defaults and clears the series while keeping declarations — test-only.

## The Prometheus body

```ts
import { METRICS_CONTENT_TYPE, METRICS_PATH, metricsText } from '@ultimat3/core';

METRICS_PATH;          // '/metrics'
METRICS_CONTENT_TYPE;  // 'text/plain; version=0.0.4; charset=utf-8'
metricsText();         // the whole scrape body, from a fresh collectMetrics()
```

The body always opens with a `target_info` gauge carrying the service identity, then per metric a `# HELP`, a `# TYPE`, and its points. A non-trivial unit is appended to the help text as `<description> (<unit>)`. Histograms render cumulative `_bucket` series including `le="+Inf"`, then `_sum` and `_count`. Labels are sorted alphabetically; `\`, `"` and newline are escaped; `+Inf` / `-Inf` / `NaN` are spelled out.

`/metrics` is mounted by **every role**, on its own port — `METRICS_PORT`, default `9090` — not on the role's HTTP port. `startMetricsEndpoint` in `packages/cli/src/metrics-endpoint.ts` starts first and stops last, so `x dev` and production behave identically.

| Decision | Why |
|---|---|
| A separate port, not beside `/healthz` | the Helm ingress routes `/` `Prefix` to the web Service with no path exclusion, so `/metrics` on 3000 publishes your route patterns, request volumes and error rates to the internet. Nothing in the chart fronts 9090, so it is cluster-internal by construction rather than by an exclusion somebody has to remember |
| Every role, not just `web` | `worker`, `scheduler` and `replicator` open no HTTP socket at all — a separate listener is the only thing they can ever be scraped on, and `queue_depth` belongs to `worker` |
| Its own env var, not `PORT + n` | moving the app port must not silently move the port Prometheus is configured against, and the roles that set no `PORT` still need one |
| `x dev` with no `METRICS_PORT` moves off a taken port | two apps on one laptop both default to 9090: the second binds a free port, logs `ultimate metrics port taken`, and reports the real URL in `x dev --json`'s `metrics`. A declared `METRICS_PORT`, and every container, refuses with `X_PORT_IN_USE` — a scraper was told that port |
| Answered outside the request pipeline | no auth stage, no rate limit, no locale — a saturated or draining process must still be able to say how saturated it is. Same shape as `/healthz` |

## The series autoscaling reads

Declared in `runtime-metrics.ts`, so the role table, the Helm chart and the scrape cannot drift apart.

| Instrument | Name | Kind | Unit | Labels |
|---|---|---|---|---|
| `requests` | `http_requests_total` | counter | `{request}` | `method`, `route`, `status` — the status **class**, e.g. `2xx` |
| `requestDuration` | `http_request_duration_seconds` | histogram | `s` | same three |
| `connections` | `connections` | gauge | `{connection}` | none |
| `queueDepth` | `queue_depth` | gauge | `{job}` | `queue` |
| `queueDemand` | `queue_demand` | gauge | `{job}` | `queue` |
| `jobs` | `jobs_total` | counter | `{job}` | `queue`, `outcome` (`ok \| failed \| dead`) |
| `leasesLost` | `job_leases_lost_total` | counter | `{job}` | `queue` |

`SCALING_METRICS` maps each `ScalingSignal` to its series: `rps` → `http_requests_total`, `ws-connections` → `connections`, `queue-demand` → `queue_demand`; `singleton`, `run-once` and `per-database` map to `null`, because a role pinned at one replica has nothing to scale on. **`rps` is derived from the monotonic counter** — a rate is not a series, so nothing exports one. **`queue_demand` is what the worker must hold**: running on a serving worker, plus due rows on an unpaused queue. `queue_depth` is what waits, and stays for the backlog alert: 10 jobs held read `queue_depth` 0 and `queue_demand` 10, and an HPA on the first shrank the fleet mid-job. Every serving worker publishes the same `queue_demand`, so the adapter rule is `max by (queue) (queue_demand)`, never `sum`; a draining worker publishes 0, since its loop has stopped and a frozen value would win that `max` for its whole retire. `JobDriver.demand()` is required of every driver; Redis keeps no worker registry, so it counts every running row.

Recorders: `recordRequest({ method, route, status, durationMs })`, `recordConnection(delta)`, `recordQueueDepth(queue, depth)`, `recordJob(queue, outcome)`, `recordLeaseLost(queue)`.

All five are wired `As of 2026-08`, each in the package that owns the event:

| Recorder | Called from | Note |
|---|---|---|
| `recordRequest` | `packages/http/src/pipeline.ts` — a `finally` around `execute` | counts every request exactly once, including a finalize stage that throws on its own. The label is the route **pattern** (`/posts/:id`), never the concrete path; unmatched paths collapse to one `unmatched` series, so a scanner hitting `/wp-admin` and `/.env` cannot mint series |
| `recordConnection` | `packages/realtime/src/socket.ts` — `SocketRegistry.add` / `remove` | the only definition of a live connection on a node. Decrements only on a real delete, so a double close cannot drive the gauge negative. Every eviction — a closed socket, the idle sweep, a drain — goes through `sync-node`'s `teardown`, which releases the live subscriptions and the channel topics, **then** calls `remove()`, and **then** starts `presence.leave()`. The leave is last and is deliberately not awaited: the write is on the bus and the close callback is synchronous, so the gauge is already correct while the leave is still in flight. Until 2.0.0 `drain()` called `remove()` directly and released none of the three, so a rolling restart left every drained socket in the shared presence set until TTL — every room rendered each user twice |
| `recordQueueDepth` | `packages/jobs/src/worker.ts` — top of `tick()` | throttled to 15s, not per poll: `driver.stats()` aggregates the whole jobs table, and a scrape reads it every ~15s anyway. Records `ready` only — a job parked until Tuesday is not backlog. A `stats()` failure is logged and never costs a tick |
| `recordJob` | `packages/jobs/src/worker.ts` — the outcome branch of a finished job | labelled by queue and outcome only; a label per job name is unbounded in the app's own vocabulary. `suspended` is deliberately unmapped — parking a run with `step.sleep` is control flow, and counting it would make the failure ratio meaningless |
| `recordLeaseLost` | `packages/jobs/src/heartbeat.ts` — once per job whose lease lapsed | the worker could not renew the visibility window for longer than the window itself, so the queue is free to hand that job to another worker while this one still runs it. One point = one job that ran twice. Alert on any non-zero rate |

### What every process reports about itself

Declared in `process-metrics.ts` and `packages/db/src/pool-gauge.ts`, started by the scrape listener — so every role that can be scraped answers them, `worker` and `scheduler` included. `As of 2026-10`.

| Name | Kind | Unit | Labels | Reads |
|---|---|---|---|---|
| `process_resident_memory_bytes` | gauge | `By` | none | RSS — what the container is charged for |
| `process_heap_used_bytes` | gauge | `By` | none | JavaScript heap in use, uncollected garbage included; Bun may report it a few percent above `process_heap_total_bytes` |
| `process_heap_total_bytes` | gauge | `By` | none | heap the engine has reserved |
| `process_external_memory_bytes` | gauge | `By` | none | buffers, strings and compiled code held outside the heap |
| `process_cpu_seconds_total` | counter | `s` | none | user + system CPU; the boot's share is counted at start |
| `process_event_loop_lag_seconds` | histogram | `s` | none | how late a 1,000 ms timer fired, one sample a second |
| `process_start_time_seconds` | gauge | `s` | none | Unix time the process started |
| `process_info` | gauge | `1` | `role` | always 1; `role` is `ROLE`, or `x dev`'s roles joined by `+` |
| `db_pool_max` | gauge | `{connection}` | none | connections this process may open, summed over its pools |
| `db_pool_in_use` | gauge | `{connection}` | none | connections running a statement or pinned by a transaction |
| `db_pool_waiting` | gauge | `{statement}` | none | statements and pins queued because the pool is at `max` |

- **Cost**: one unref'd timer wake a second — 0.12 millicore measured, on top of the 1.8 an idle Bun process spends — and ~12 µs per reading (`process.memoryUsage()` + `process.cpuUsage()`); a scrape reads the gauges at collection time.
- **No GC count, no heap object count.** Bun exposes neither cheaply: `bun:jsc`'s `heapStats()` runs a full collection to answer — 9 ms on a process holding only the framework.
- **The pool series are derived from demand.** `Bun.SQL` publishes no occupancy, so `client.ts` counts every statement from send to settle and every pin from ask to release: demand up to `max` is in use, the rest is waiting. `db_pool_max - db_pool_in_use` is the headroom; there is no idle count.
- **`queue_wake_live`** (gauge, `worker` only): 1 once a notification has crossed the worker's `LISTEN` session, 0 while jobs start on the poll alone — a transaction-pooling proxy disables the wake without an error.
- **What grows?** `process_resident_memory_bytes` rising with `process_heap_used_bytes` flat is memory outside the heap (`process_external_memory_bytes`, or the allocator); both rising is a retained structure.

### The one series a `sync` node adds

| Instrument | Name | Kind | Unit | Labels |
|---|---|---|---|---|
| `channelFramesDropped` | `channel_frames_dropped_total` | counter | `{frame}` | **none** |

Declared in `packages/realtime/src/socket.ts`, not in `runtime-metrics.ts`: that file is the series every Ultimate process emits and the chart scales on, and this one exists only where channels do.

**No labels, on purpose.** A topic is client-chosen — `topic()` admits any `[A-Za-z0-9_-]+` segment — so a per-topic label is unbounded series one socket can mint. The topic goes in the log line instead: `channel.frames_dropped` at `warn`, with `{ topic, dropped, total }`.

**It is a data-loss counter, not a saturation one.** Nothing replays a channel frame: a topic has no cursor and no re-snapshot, so a frame backpressure refused is gone → [Realtime](Realtime). Alert on any non-zero rate. The live-query path is the one that repairs, and its drops are invisible here by design. `SocketRegistry.droppedChannelFrames` is the same number in process, for a test or a benchmark that cannot scrape.

CPU autoscaling is wrong for `sync` and `worker`: a node holding 80k idle sockets is near-zero CPU and near-capacity, and a worker blocked on a slow HTTP call is idle CPU with a growing backlog. That is why the two custom series exist → [Deployment](Deployment).

## The database, on demand

`x db diagnostics --json` (`As of 2026-11`) answers what the series cannot: who blocks whom (`data.blockers.rows[].blockedBy`), what each session is doing, the slowest statements (`pg_stat_statements`, when an operator installed it), unused and invalid indexes, `NOT VALID` constraints, dead tuples and the last autovacuum. Facts only, exit 0; `/readyz` stays the one-`select 1` probe. Read-only, 2 s per statement, no user table read, literals printed as `?`; whoever runs it sees the redacted SQL of every session on the app's database role → [CLI reference](CLI-Reference#x-db). The same report is `dbDiagnostics()` from `@ultimat3/db`.

## Spans and logs

| Concern | Where |
|---|---|
| Tracing | always on, not a flag. `otel.endpoint` absent means spans are still recorded and exported nowhere → [Configuration](Configuration) |
| Head sampling | `otel.sampling`, default `0.1`; errors are always sampled |
| OTLP delivery | a 429, 502, 503, 504 or a transport failure is retried, 3 attempts with full jitter and `Retry-After` honoured, inside the exporter's `timeoutMs` (default 10 s, the whole export); any other status is one POST. One `otlp export rejected`/`failed` line per batch, with `attempts`. A collector that accepted and then answered 503 receives that batch twice; span ids dedupe it |
| Error grouping | `errorFingerprint(report)`: 16 hex over `code`, `source`, `scope.operation`, plus the top application frame (function and root-relative path, no line) for `X_INTERNAL`. Never the cause or an id, so two throws differing in a row id are one group, and a deploy is not a new one. The Sentry envelope sends it as `fingerprint` |
| Log level | `LOG_LEVEL`, default `info` |
| Secret redaction | a `Secret` is redacted by value before every other branch, at any depth → [Configuration](Configuration) |
| Request context | the ALS context carries the request id every log line and span inherits |
| Live queries | the realtime client puts a `traceparent` on the `subscribe` frame (`LiveClient({ traceparent })`); the snapshot that subscribe causes is the span `live.snapshot <query>`, a CHILD of it, and a re-read a change forces is `live.rerun <query>`, which LINKS to it and parents on the change. A value that is not a valid W3C header is ignored, never refused: telemetry never fails a subscribe. The page boot sends none (`As of 2026-11`): a browser holds no trace |
| Request span name | `GET /r/:token` — the route PATTERN, never the concrete URL (a token in a path would reach every collector); `http.route` carries the same pattern, and an unmatched request is named by its method alone with `http.route: unmatched` (`As of 22.6.0`) |

## Browser failures

`app.config.ts` `clientErrors: { enabled: true }` (`As of 30.0`, off by default) sends a failure on an `app/` page to the same `ErrorReporter` a server failure reaches, as `source: 'browser'` and code `X_CLIENT_ERROR`. `site/` documents never carry it; the admin ships no script.

| Concern | Rule |
|---|---|
| Doors | window `error` (only a `filename` on this origin; `Script error.` with no stack dropped), `unhandledrejection` (dropped when its stack names only other origins), an island whose `mount()` rejected (the `data-x-failed` marker, watched by a `MutationObserver` — the hydration runtime swallows that rejection, so no window event fires) |
| Script | `/x-client-errors.js`, 1,961 B (962 B gzip) `As of 2026-11-03`, in `<head>` with `defer`. Served `app/` documents only: the static export `budget.js` is weighed on never names it, so no route figure moves. The build is the document's `x-ultimate-build` meta (else the tag's `data-build`), read at send time. Never throws, never reports its own failure |
| Caps | 5 reports per document, one per distinct path and message — reset when the client router swaps a page in (`ultimate:navigated`); one report per failed island element, so one carried across a swap is not re-reported; message 1,000, stack 8,000, path 2,048 characters; body 32 KiB |
| Route | `POST /_client-errors`, `204` on acceptance. `403 X_CSRF_BLOCKED` without proof of same origin (`sec-fetch-site`, then `Origin` — a request with neither is refused too); a path with a query, a fragment, whitespace or a control character is refused; `401` anonymous unless `clientErrors.anonymous: true`; `422 X_BODY_INVALID` for a body over the cap, an unknown key or a field out of shape; `429` past `clientErrors.perMinute` per actor or address, on the app's rate-limit store. A refusal is never reported |
| Report | `cause` = the browser's message; `stack` = the browser's stack, as sent (no source maps); `meta.clientBuild` beside the server's `release` tells a stale tab from a bug; `meta.kind`, `meta.island`; `scope.operation` = the matched `app/` route pattern, plus the island id when a page of this build declares that island — any other id is filed with no operation, so an invented id makes no new group; `scope.extra.path` = the path, never the query string. `errorFingerprint` groups on these: one island's fault on every `/posts/:id` is one group |
| Credential | none in the browser: the tab posts to its own origin and the server forwards through the configured reporter |
| Static export | no route to receive a report, so no exported document names the script and `x build` warns |
| Not on this route | source maps, a filter DSL — an app's own rules belong in its wrapped `ErrorReporter`. Timings are their own door, below |

## Real-user timings

`clientErrors.vitals: { enabled: true }` (`As of 2026-11`, off by default) measures what a user waited for, with no library: `PerformanceObserver` in the browser, one beacon per page view.

| Concern | Rule |
|---|---|
| Config | `enabled` (default `false`), `sampleRate` (share of page views, 0–1, default `0.1`, decided once per view), `surfaces` (default `['app']`; `'site'` opts the static path in by name). A rate out of range or an unlisted surface refuses the config |
| Timings | `lcp`, `fcp`, `inp`, `ttfb` (ms from navigation start) and `cls` (largest session window). CLOSED: any other name is dropped |
| Script | `/x-client-vitals.js`, 1,202 B (633 B gzip) `As of 2026-11-06`, `defer` in `<head>`, on documents of a listed surface only |
| Beacon | `navigator.sendBeacon('/_client-vitals')` on the first hide (`visibilitychange` → hidden, or `pagehide`), naming the path the view LOADED at |
| Route | `POST /_client-vitals`. Same origin or dropped; body ≤ 4 KiB; 60 beacons a minute per address; anonymous — no actor on a timing. EVERY outcome is `204`, so a probe learns nothing |
| Metrics | `web_vital_seconds{route, metric}` (histogram, seconds) and `web_vital_cls{route}`. `route` is the matched route PATTERN on a listed surface, never the URL; an unmatched path records nothing. A timing past 60 s, a CLS past 10 or a negative value is dropped |
| Budgets | charged, never exempted: an `app/` route is weighed as served and pays the script; a `site/` page is exported carrying it when `site` is listed. On a static host its beacons go nowhere, and `x build` warns |
| Storage | none. The metric is the record |

## Error groups

`errorGroupsSink` (`@ultimat3/admin/error-groups`, `As of 2026-11`) is an `ErrorReporter` that folds every report into its `errorFingerprint` group in `x_error_groups` — first seen, last seen, count, a redacted sample — and `/admin/errors` lists them (`errorGroupsPages`, permission `errors:read`).

```ts
import { errorGroupsSink, postgresErrorGroupsStore } from '@ultimat3/admin/error-groups';
import { chainErrorReporters, configureErrorReporting, installedErrorReporter } from '@ultimat3/core';
import { job, t } from '@ultimat3/jobs';

// The app's own: which tracker, which title. Enqueued once per NEW group, fleet-wide.
export const openErrorIssue = job({
  input: t.object({
    fingerprint: t.string,
    code: t.string,
    source: t.string,
    operation: t.nullable(t.string),
    message: t.string,
    firstSeen: t.string,
  }),
  idempotencyKey: ({ fingerprint }) => `error-issue:${fingerprint}`,
  tenant: 'none',
  retry: { attempts: 3, backoff: 'exponential' },
  async run({ input }) {
    console.log('new error group', input.fingerprint);
  },
});

export const errorGroups = postgresErrorGroupsStore();
const sink = errorGroupsSink({ store: errorGroups, onNewGroup: openErrorIssue });
configureErrorReporting({ reporter: chainErrorReporters(installedErrorReporter(), sink) });
```

| Concern | Rule |
|---|---|
| Composing | `chainErrorReporters(...)` from `@ultimat3/core`: every member gets every report, one that throws costs only itself, chains flatten. The container chains its `SENTRY_DSN` transport AFTER whatever the app installed — never over it |
| "New", once | the upsert's `xmax = 0` decides, so N replicas reporting one new fault enqueue `onNewGroup` once. Which tracker, title and assignee are the app's job |
| Transactions | written outside the request's transaction: a rollback never erases its own error |
| Load | `perMinute` store writes per process (default 120); past it, reports are counted and written as one later. A failed write is logged and never re-enters the reporter |
| Table | `x_error_groups`, applied at boot with every framework table (`@ultimat3/admin/schema`). Retention is the app's: `errorGroupsPurgeTarget(store, { olderThanMs })`, no default |
| Stores | `postgresErrorGroupsStore()` for a fleet; `memoryErrorGroupsStore()` for tests — it forgets at restart and counts per replica |

Running an app for real — the PaaS → Compose → Kubernetes ladder, secrets, dashboards, datastore sizing, DR and runbooks — is the operations manual: [`docs/ops/`](https://github.com/developerz-ai/ultimate/tree/main/docs/ops), and specifically [`docs/ops/03-observability.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/ops/03-observability.md). Recommendations only; the framework depends on none of it.
