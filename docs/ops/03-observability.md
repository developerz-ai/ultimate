# Observability

Alert on what a user feels. Page only on what a human must act on **now**. Everything else is a
dashboard.

## What Ultimate emits today

`As of 2026-08`, verified against this repo — not assumed.

| Signal | State | Consequence |
|---|---|---|
| Structured JSON logs, one line per event | **shipped** — [`packages/core/src/logger.ts`](../../packages/core/src/logger.ts) | works today: collect stdout, no app change |
| `/healthz` and `/readyz`, both returning a JSON body with named checks | **shipped** — [`packages/core/src/lifecycle.ts`](../../packages/core/src/lifecycle.ts) | works today: probes and blackbox checks |
| OTel-shaped spans, trace context propagated as `traceparent` | **shipped as a seam** — [`packages/core/src/telemetry.ts`](../../packages/core/src/telemetry.ts) | the default exporter is a no-op; `noopExporter` and `memoryExporter` are the only ones that ship |
| An OTLP span exporter | **not yet implemented** | to get traces off the box you must implement `SpanExporter` and register it |
| `/metrics` in the Prometheus text format, on every role | **shipped** — [`packages/cli/src/metrics-endpoint.ts`](../../packages/cli/src/metrics-endpoint.ts), served on `METRICS_PORT` (9090), **not** the app's port | scrape it; see [Scrape config](#scrape-config) |
| Error reporting: caught server faults, with code, cause and `fix:` | **shipped as a seam** — [`packages/core/src/error-reporter.ts`](../../packages/core/src/error-reporter.ts), wired for HTTP, jobs and realtime | the default reporter is a no-op; set `SENTRY_DSN` to switch the shipped transport on |
| `x logs` | listed **planned** in `x --help` | — |

`As of 2026-08` the six series every process emits are declared in
[`packages/core/src/runtime-metrics.ts`](../../packages/core/src/runtime-metrics.ts), and each has
exactly one emitter:

| Series | Type | Labels | Emitted by |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route` (PATTERN), `status` (CLASS) | the HTTP pipeline, once per request, error paths included |
| `http_request_duration_seconds` | histogram | same three | same call |
| `connections` | gauge | none | the sync node's socket table, `+1`/`-1` |
| `queue_depth` | gauge | `queue` | the worker, throttled to one read per 15s |
| `jobs_total` | counter | `queue`, `outcome` (`ok`\|`failed`\|`dead`) | the worker's outcome path |
| `job_leases_lost_total` | counter | `queue` | the worker's lease heartbeat, once per job whose window lapsed |

Labels are deliberately low-cardinality: the route **pattern** and the status **class**, never a
concrete path, a user id or a job name. A label an attacker chooses is a label that decides how
much memory your monitoring stack allocates.

**Read this before enabling autoscaling.** [`docker/helm/values.yaml`](../../docker/helm/values.yaml)
declares per-role HPAs targeting custom pod metrics named `rps`, `connections` and `queue_depth`. A
`Pods`-type HPA metric needs an emitter, a scrape **and** a custom metrics adapter that turns the
scraped series into the metric name the HPA asks for. The chart now ships the first two —
container port `metrics` on every serving role, a Service that publishes it, and a `ServiceMonitor`
behind `serviceMonitor.enabled` — but **not** the adapter, and `rps` in particular is a rate the
adapter has to derive (`rate(http_requests_total[1m])`); no process emits a series with that name.
Until prometheus-adapter (or equivalent) is installed and configured, those HPAs still read
`<unknown>`. Either wire the adapter first, or set `roles.<role>.autoscaling.enabled: false` and
pin `replicas`.

## What you get with zero app changes

Cluster-level exporters see everything that matters for the failure modes that actually happen. None
of the alerts in the baseline table below need a line of app instrumentation.

| Source | Gives you |
|---|---|
| kube-state-metrics | pod waiting reasons, deployment replica counts, node readiness, CronJob success times |
| node-exporter | node CPU, memory, disk, load |
| kubelet volume stats | PVC fullness |
| your ingress controller | request rate and status-code ratios per service |
| cert-manager | certificate expiry timestamps |
| a log shipper (DaemonSet) | every pod's stdout, labelled with namespace, pod, container |

Ultimate's logs are already JSON, so the log store parses them into queryable fields without a
parsing stage.

## Signal paths

| Signal | Path | Retention (real production values) |
|---|---|---|
| Metrics | pod → `ServiceMonitor` → Prometheus scrape | 15d, size-capped at 15GiB on a 20Gi volume |
| Logs | pod stdout → shipper DaemonSet → log store | 30d, in S3-compatible object storage |
| Traces | app OTLP → collector `:4318` / `:4317` → trace store | 7d, same object store, different prefix |
| Alerts | Prometheus evaluates a rule → Alertmanager routes → chat/pager | n/a |

Size the metrics volume **above** the retention cap. A busy period fills the disk before the
time-based GC ever runs; `retentionSize` below the volume size is what stops that.

Two things about OTLP that cost people an afternoon: the endpoint port does not switch the wire
protocol — most SDKs default to OTLP/HTTP, so `:4317` also needs
`OTEL_EXPORTER_OTLP_PROTOCOL=grpc` — and in-cluster collector endpoints are plaintext, so gRPC also
needs the insecure flag.

## Scrape config

The chart ships it. Turn it on:

```bash
helm upgrade --install <release> docker/helm --set serviceMonitor.enabled=true
```

That renders one `ServiceMonitor` for the release —
[`docker/helm/templates/servicemonitor.yaml`](../../docker/helm/templates/servicemonitor.yaml) —
selecting every role's Service by `app.kubernetes.io/name` + `instance`, scraping the port **named**
`metrics` at `/metrics`. `targetLabels: [app.kubernetes.io/component]` carries the role onto every
series, which is what an alert and a metric adapter key on.

| Decision | Why |
|---|---|
| Off by default | a cluster with no Prometheus operator has no `ServiceMonitor` CRD, and `helm install` fails on an unknown kind rather than skipping it |
| Its own port (`metricsPort`, 9090), not the app's | `ingress.yaml` routes `/` to web, so `/metrics` on 3000 would be your route patterns and error rates on the internet |
| A Service for **every** role, headless for the ones that take no traffic | `worker`, `scheduler` and `replicator` open no HTTP socket, and `queue_depth` belongs to one of them — a ServiceMonitor needs a Service to select |
| The port **by name**, never the integer | an operator who moves `metricsPort` must not have to remember a second place; the ingress selects `http` by name for the same reason, which is what keeps `/metrics` off the internet |

Discover `ServiceMonitor` objects cluster-wide rather than by a release label; a monitor that
silently does not match its operator's selector looks identical to one that works. If your operator
uses a `serviceMonitorSelector`, put the labels it matches in `serviceMonitor.labels`.

Verify before believing it:

```bash
helm template <release> docker/helm --set serviceMonitor.enabled=true | grep -A3 'name: metrics'
kubectl port-forward deploy/<release>-ultimate-worker 9090:9090 && curl -s localhost:9090/metrics
```

## Error reporting

Every server fault the framework catches goes through one `ErrorReporter`
([`packages/core/src/error-reporter.ts`](../../packages/core/src/error-reporter.ts)), carrying the
error contract intact: stable `X_*` code, cause, and the runnable `fix:` — so whoever is paged
reads the command next to the failure instead of a stack trace.

| Surface | Call site | Reported |
|---|---|---|
| HTTP | the `error-map` stage of the pipeline | `status >= 500` only. A 404 or a 422 is the caller's mistake and the problem document already said so |
| jobs | `executeJob`'s failure path | a retry as `warning`, a dead letter as `error`. `x jobs run` takes the same path |
| realtime | the sync node's frame handler and its detached presence writes | everything that is not a client fault (`X_TOPIC_FORBIDDEN`, `X_SUBSCRIPTION_LIMIT`, `X_PROTOCOL_VERSION`, `X_LIVE_QUERY_UNKNOWN`, `X_CURSOR_STALE`, `X_REBASE_CONFLICT`, `X_FORBIDDEN`, `X_UNAUTHENTICATED`) |

The default reporter is a **no-op**, so an unconfigured app and every test pay nothing and page
nobody. There is no `x serve` command — a container runs the scaffolded `apps/web/server.ts`,
whose boot (`configureReporting` in
[`packages/cli/src/serve.ts`](../../packages/cli/src/serve.ts)) switches the reporter on when the
environment carries a DSN:

```bash
SENTRY_DSN=https://<publicKey>@<your-monitor-host>/<projectId>
```

The framework ships the *interface* plus one transport that speaks the documented Sentry **envelope**
wire format — the same relationship `metrics-text.ts` has to Prometheus. It names no host, no
organisation and no vendor endpoint: the DSN is your app's typed env, pointing at whatever you run
(the protocol has several self-hostable implementations). A malformed DSN fails the boot with
`X_ERROR_REPORTER_DSN_INVALID`, because a monitor that was never connected looks exactly like an app
that never failed.

Every event is tagged with `release` = the deploy's **build id** — the same value
`x-ultimate-build` carries and the same one `apps/web/server.ts`'s boot computed, never a second
identity — plus `environment`, the `X_*` code, the source (`http`/`job`/`realtime`) and the role.
Group on the code.

To send somewhere else, implement `ErrorReporter` and call `configureErrorReporting({ reporter })`
in the app entry. `memoryErrorReporter()` is the one to use in tests.

## The baseline alert set

Every expression below is running in production. The `for:` durations are the ones that survived
contact with real deploys — they are not round numbers picked for looks.

| Alert | Expression | For | Severity |
|---|---|---|---|
| NodeNotReady | `kube_node_status_condition{condition="Ready",status!="true"} == 1` | 5m | critical |
| NodeReadinessMetricsMissing | `absent(kube_node_status_condition{condition="Ready"})` | 15m | critical |
| PodCrashLoopBackOff | `max_over_time(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}[5m]) == 1` | 10m | warning |
| PodImagePullFailing | `max_over_time(kube_pod_container_status_waiting_reason{reason=~"ImagePullBackOff\|ErrImagePull"}[5m]) == 1` | 10m | critical |
| DeploymentNoAvailableReplicas | `(kube_deployment_status_replicas_available == 0) and (kube_deployment_spec_replicas > 0)` | 10m | critical |
| PVCFillingUp | `kubelet_volume_stats_available_bytes / kubelet_volume_stats_capacity_bytes < 0.15` | 10m | warning |
| ScrapeTargetDown | `up == 0` | 30m | warning |
| CertificateExpiringSoon | `cert_expiry_seconds > 0 and cert_expiry_seconds - time() < 7*24*3600` | 1h | warning |
| Ingress5xxSpike | `sum(rate(<ingress>_requests_total{code=~"5.."}[5m])) / sum(rate(<ingress>_requests_total[5m])) > 0.01` | 5m | warning |
| BackupCronJobStale | `time() - kube_cronjob_status_last_successful_time{cronjob=~"..."} > 26*3600` | — | warning |
| BackupCronJobNeverSucceeded | `(kube_cronjob_created{...} < time() - 26*3600) unless on (namespace, cronjob) kube_cronjob_status_last_successful_time{...}` | 1h | critical |
| AlertsSuppressedTooLong | `max(alertmanager_alerts{state="suppressed"}) > 0` | 2h | critical |
| AlertmanagerFailedNotifications | `rate(alertmanager_notifications_failed_total[5m]) > 0` | 10m | critical |

### Why each of those is shaped the way it is

Each row below is a rule that used to be simpler and cost an outage.

**Name the thing you actually measure.** "Node down" sourced from `up{job="node-exporter"} == 0`
proves only *"Prometheus failed to scrape node-exporter"*. A default-deny network policy blocked
Prometheus egress; no node was ever down, but the alert fired, **could not self-clear**, and its
cluster-wide inhibition rule silently muted a critical zero-replicas alert for **seven days**. Source
node readiness from kube-state-metrics, which is scraped over the API server — a genuinely
independent path. The kubelet's own metrics are not independent: same egress, same policy, same
blindness.

**Smooth flickering series or the `for` clock never advances.** The kubelet's restart backoff gives a
crash-looping pod a brief `Running` window every few minutes, and a 30s scrape catches the
`CrashLoopBackOff` reason only about a tenth of the time. Each missed scrape drops the series and
**resets the `for` clock from zero**. Observed: a real crashloop, ten replicas, forty-five minutes,
never fired. `max_over_time(...[5m])` holds the series true across the flicker.

**Then double the `for`.** The `[5m]` smoothing holds the series true for five minutes *past* the last
bad sample. At `for: 5m` the effective grace collapses to about one scrape interval, which pages on a
pod that has already been healthy for four minutes. `for: 10m` is what represents five minutes of
real sustained fault.

**Guard the trivially-true case.** Zero available replicas pages forever on a deployment deliberately
scaled to zero — hence `and kube_deployment_spec_replicas > 0`. A never-issued certificate exports an
expiry timestamp of `0`, and `0 - time()` is enormously negative, so it false-fires until it first
issues — hence `> 0`.

**Aggregate churning labels out of the alert's identity.** If a rule's output labels include something
that flips during the incident — `health_status` cycling Degraded → Progressing → Degraded on each
retry — the series *fingerprint* changes, the pending alert resolves, and the `for` clock restarts.
The alert can run indefinitely on an actively-failing app without ever firing. `max_over_time` does
not help: it is evaluated per series, so a churned-away series still resets. `max by (name, namespace)`
collapses the variants into one stable series.

**Add an `absent()` companion to any alert whose source metric can vanish.** If kube-state-metrics
stops being scraped, the node-readiness series goes absent and the node alert cannot fire *at all* —
a real outage would page nobody. Make the blind spot explicit and page on it. Rate it `critical`,
because a broad node-level inhibition would mute it at `warning`.

**`strategy: Recreate` spends your entire noise budget on every deploy.** Recreate terminates all pods
before starting new ones, so available replicas is zero for the whole rollout and the zero-replicas
alert goes `pending` on every single deploy. It stays silent only because rollouts finish inside the
`for` window — an assumption, not a guarantee, and the margin is thinnest exactly where a migration
runs inside the rollout. Ultimate's chart uses `RollingUpdate` with `maxUnavailable: 0` and runs
migrations in a pre-deploy hook, so this does not bite it. It will bite anything you set to Recreate.

**Verify every metric name against a live scrape.** A wrong metric name is not an error; it is an
alert that silently never fires. Internal collector telemetry in particular may or may not carry a
`_total` suffix depending on a compatibility default, and guessing wrong produces a rule that looks
correct in review and does nothing forever.

## Alerts about alerting

The failure nobody plans for is the alerting path itself.

| Failure | What it looks like | Countermeasure |
|---|---|---|
| The chat relay pod crash-loops | Every webhook delivery fails, silently. Nobody is paged, about anything. | alert on `alertmanager_notifications_failed_total`, and route **that one alert** through an independent delivery path — a native integration rather than the relay |
| A routing config object references a secret that cannot resolve | The operator validates each config object **as a unit** and drops the **whole object** — every receiver in it — leaving only the null receiver. One placeholder in an unused receiver took the main channel down with it. | give any channel you cannot afford to lose its **own** config object; accept that the shared catch-all also matches and the alert posts twice. A duplicate post is cheaper than a silent drop |
| An inhibition rule that cannot clear | A broad "while X fires, suppress all warnings" rule becomes a permanent cluster-wide mute when X is stuck. | alert on suppression itself — `alertmanager_alerts{state="suppressed"}` for 2h. Nothing else watches it; delivery monitoring does not see a mute |
| The whole cluster is down | Nothing in-cluster can page anyone. | an off-cluster dead-man: write a freshness object to shared storage every minute *only while* the alerting brain answers healthy; an off-cluster watcher pages when that object goes stale |
| A dead-man's-switch job whose designed state is "failing" | Reusing a generic backup-freshness rule for it produced a **critical** page reading "backup has never succeeded" for twelve days while every real backup ran fine. | give it its own rule, its own wording, and a severity that matches the actual risk |

## Backup freshness needs two rules, not one

`kube_cronjob_status_last_successful_time` **does not exist until the first success**. A staleness
rule built on it is blind to a job that has never succeeded — never fired, or failing since creation.
The companion rule keys off metric *absence* (`unless on (namespace, cronjob)`) and detects it about
a day later. Slow, but it is the difference between "we have no backups" being noticed and not.

## Alerts on the app's own metrics

`As of 2026-08` the six series above are emitted and scrapable, so these are writable today.
`queue_depth` and `jobs_total` together are what tell a drained queue from a queue nothing is
claiming — depth alone cannot. `job_leases_lost_total` deserves a rule of its own at any non-zero
rate: each point is a job the queue re-delivered while this process was still running it.

| Role | Alert on | Because |
|---|---|---|
| `worker` | oldest unclaimed job age, not queue length | length says nothing about whether anything is draining |
| `sync` | connections per pod against the per-pod ceiling | a websocket costs memory while idle; request rate is blind to it |
| `scheduler` | leader lock unheld for longer than one tick interval | a standby that never promotes looks identical to a healthy cluster |
| `replicator` | replication slot lag, and slot inactive | an inactive slot silently accumulates WAL until the database's disk fills |
| `web` | `/readyz` check failures by check name | the body already names each check; do not collapse it to a boolean |
| all | build-ID skew across live pods | a half-finished rollout serving two versions is the shape most version-skew bugs take |

## Routing

| Setting | Value | Why |
|---|---|---|
| Group by | `alertname`, `namespace`, `severity` | one crash-looping deployment collapses into one message, not one per pod |
| Group wait | 30s | let the fan-out arrive before posting |
| Group interval | 5m | — |
| Repeat interval | 12h | long enough not to nag, short enough not to be forgotten |
| The always-firing canary | route to a null receiver | it exists to prove the pipeline, not to notify |
