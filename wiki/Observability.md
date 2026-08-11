# Observability

Metrics, spans, and structured logs — all in `@ultimat3/core`, all dependency-free.

v1.1.0 `As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)).

Counter, gauge and histogram sit on the OpenTelemetry data model, aggregate in process, and are read through one `collectMetrics()`. The wire format is a **driver**: `MetricExporter` is the seam, the default is a no-op, and `metricsText()` renders the Prometheus/OpenMetrics scrape body. The framework ships **no OTLP client** — pointing `OTEL_EXPORTER_OTLP_ENDPOINT` at a collector means supplying a `MetricExporter` that speaks it, or scraping with an agent that does.

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
| Answered outside the request pipeline | no auth stage, no rate limit, no locale — a saturated or draining process must still be able to say how saturated it is. Same shape as `/healthz` |

## The series autoscaling reads

Declared in `runtime-metrics.ts`, so the role table, the Helm chart and the scrape cannot drift apart.

| Instrument | Name | Kind | Unit | Labels |
|---|---|---|---|---|
| `requests` | `http_requests_total` | counter | `{request}` | `method`, `route`, `status` — the status **class**, e.g. `2xx` |
| `requestDuration` | `http_request_duration_seconds` | histogram | `s` | same three |
| `connections` | `connections` | gauge | `{connection}` | none |
| `queueDepth` | `queue_depth` | gauge | `{job}` | `queue` |
| `jobs` | `jobs_total` | counter | `{job}` | `queue`, `outcome` (`ok \| failed \| dead`) |

`SCALING_METRICS` maps each `ScalingSignal` to its series: `rps` → `http_requests_total`, `ws-connections` → `connections`, `queue-depth` → `queue_depth`; `singleton`, `run-once` and `per-database` map to `null`, because a role pinned at one replica has nothing to scale on. **`rps` is derived from the monotonic counter** — a rate is not a series, so nothing exports one.

Recorders: `recordRequest({ method, route, status, durationMs })`, `recordConnection(delta)`, `recordQueueDepth(queue, depth)`, `recordJob(queue, outcome)`.

Three of the four are wired `As of 2026-08`, each in the package that owns the event:

| Recorder | Called from | Note |
|---|---|---|
| `recordRequest` | `packages/http/src/pipeline.ts` — a `finally` around `execute` | counts every request exactly once, including a finalize stage that throws on its own. The label is the route **pattern** (`/posts/:id`), never the concrete path; unmatched paths collapse to one `unmatched` series, so a scanner hitting `/wp-admin` and `/.env` cannot mint series |
| `recordConnection` | `packages/realtime/src/socket.ts` — `SocketRegistry.add` / `remove` | the only definition of a live connection on a node. Decrements only on a real delete, so a double close cannot drive the gauge negative, and the idle sweep now routes through `remove()` — that was the one leaking path |
| `recordQueueDepth` | `packages/jobs/src/worker.ts` — top of `tick()` | throttled to 15s, not per poll: `driver.stats()` aggregates the whole jobs table, and a scrape reads it every ~15s anyway. Records `ready` only — a job parked until Tuesday is not backlog. A `stats()` failure is logged and never costs a tick |
| `recordJob` | **nothing yet** | `jobs_total` is declared and not emitted |

CPU autoscaling is wrong for `sync` and `worker`: a node holding 80k idle sockets is near-zero CPU and near-capacity, and a worker blocked on a slow HTTP call is idle CPU with a growing backlog. That is why the two custom series exist → [Deployment](Deployment).

## Spans and logs

| Concern | Where |
|---|---|
| Tracing | always on, not a flag. `otel.endpoint` absent means spans are still recorded and exported nowhere → [Configuration](Configuration) |
| Head sampling | `otel.sampling`, default `0.1`; errors are always sampled |
| Log level | `LOG_LEVEL`, default `info` |
| Secret redaction | a `Secret` is redacted by value before every other branch, at any depth → [Configuration](Configuration) |
| Request context | the ALS context carries the request id every log line and span inherits |

Running an app for real — the PaaS → Compose → Kubernetes ladder, secrets, dashboards, datastore sizing, DR and runbooks — is the operations manual: [`docs/ops/`](https://github.com/developerz-ai/ultimate/tree/main/docs/ops), and specifically [`docs/ops/03-observability.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/ops/03-observability.md). Recommendations only; the framework depends on none of it.
