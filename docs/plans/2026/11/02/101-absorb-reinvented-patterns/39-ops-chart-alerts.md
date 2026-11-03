# 39 — Alert rules an app gets from its chart

> Part of [`overview.md`](overview.md). Depends on: [`33-ops-worker-roll.md`](33-ops-worker-roll.md) (`queue_demand`, if a rule reads it). Tier: 5 (`cli`), chart.

## Why
`docs/ops/03-observability.md:283-305` tells an operator what to alert on and ships none of it. Two adopters copied rules by hand. Worse than the deferred row said: the chart `x new` writes has **no scrape object at all**. `scaffold-helm-parity.test.ts:2` records that the framework chart "adds a ServiceMonitor" and `helmTemplateFiles` (`scaffold-helm-templates.ts:463-472`) lists none, so an app's metrics are unscraped unless its author notices.
Recorded objection: off by default, hand-copied. Answers: on by capability, not by flag; the scaffold writes them; one command backfills an existing app.

## Decisions
| Question | Answer |
|---|---|
| Default | `auto`: render when the cluster has the operator's API (`.Capabilities.APIVersions.Has "monitoring.coreos.com/v1/PrometheusRule"`). Answers the reason `serviceMonitor` is off today (`values.yaml:65`): an unknown kind fails `helm install`. `true` forces and may fail; `false` declines |
| Scrape object | same `auto` for `serviceMonitor.enabled`, framework chart and scaffold. Rules with nothing scraping are "no data" forever |
| Existing `enabled: false` | still off. A deliberate value is honoured |
| Missing values keys | the template reads `.Values.alerts | default dict`, so dropping in one file works with an app's old `values.yaml` |
| Existing apps | the chart is app-owned. `x doctor` lists the two missing files, and `x g chart-alerts` writes them. Never rewrites an app's chart |
| Thresholds | defaults a value overrides per rule. A latency target or error rate is business; a stalled queue, a dead letter and a lost lease are not, so only the rows below ship, with thresholds overridable (axiom 8) |
| Non-Kubernetes | `x g chart-alerts --print` emits the plain rule groups for any rule loader; compose apps get the same rows. One source: the template helper reads one data table in the generator |
| A renamed metric | a test holds each `expr`'s series to the declared metric list, so a rename is a build error (axiom 3) |

| Rule | Expression | Default |
|---|---|---|
| `UltimateQueueStalled` | `queue_oldest_ready_seconds > s` | 300 s, for 5 m |
| `UltimateDeadLetters` | `queue_dead_jobs > 0` | for 5 m |
| `UltimateLeaseLost` | `rate(job_leases_lost_total[5m]) > 0` | for 5 m |
| `UltimateFramesDropped` | `rate(channel_frames_dropped_total[5m]) > 0` | for 5 m |
| `UltimateServerErrors` | 5xx share of `http_requests_total` by `status="5xx"` over 5 m | 5%, for 10 m |
| `UltimateTargetDown` | `up{…} == 0` per `app_kubernetes_io_component` | for 5 m |

Each carries `runbook_url` from `alerts.runbookBase`, default the `docs/ops/06-runbooks.md` anchor, and `severity`. Scoped by namespace and release.

## Files to change
- `packages/cli/src/templates/scaffold-helm-alerts.ts` (new) — the rule table and both renderers.
- `packages/cli/src/templates/scaffold-helm-templates.ts:463-472` — adds `servicemonitor.yaml`, `alert-rules.yaml`; `scaffold-helm.ts` — `values.yaml` keys.
- `docker/helm/templates/alert-rules.yaml` (new), `docker/helm/templates/servicemonitor.yaml:14`, `docker/helm/values.yaml:65-72` — `auto`.
- `packages/cli/src/templates/scaffold-helm-parity.test.ts` — behaviour parity for both files, and its header line.
- `packages/cli/src/cmd-generate*` — `x g chart-alerts`; `packages/cli/src/cmd-doctor*` — the two rows. `wiki/CLI-Reference.md`, `llms.txt`.
- `scripts/chart-alerts.test.ts` (new) — the series check. `.github/workflows/ci.yml:476-511` — helm renders with and without `--api-versions`.
- `docs/ops/03-observability.md:283-305`, `docs/ops/06-runbooks.md` — the table points at the chart; each rule gets an anchor. `wiki/Error-Codes.md`.

## Steps
1. `bun run new-error-code` below.
2. Rule table in TypeScript, rendered to both chart template and plain groups; the Go-template bodies come from it, so no second copy.
3. Framework chart: same file, held by the parity test.
4. `targetLabels` on the scrape object carries the component, as `servicemonitor.yaml:31` already does; `alerts.labels` matches an operator's rule selector, as `serviceMonitor.labels` does.
5. Series check: extract identifiers from each `expr`; each must be a name passed to `counter(` or `gauge(` in `packages/*/src`, or be `up`.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_CHART_ALERT_SERIES_UNKNOWN` (repository guard, off-socket) | a rule reads a series no package declares | rename the rule's series in `scaffold-helm-alerts.ts` to the one declared. `bun run new-error-code X_CHART_ALERT_SERIES_UNKNOWN --package cli --title '…' --cause '…' --fix '…'` |

## Tests
- `scripts/chart-alerts.test.ts`: rename a series in the table and it fails; every rule has a `for` and a runbook anchor that exists.
- `packages/cli/src/templates/scaffold-helm-parity.test.ts`: both files, by rendered lines.
- `ci.yml` `helm` job: `helm template` plain renders neither kind; with `--api-versions monitoring.coreos.com/v1/PrometheusRule` and `/ServiceMonitor` renders both; `enabled: false` renders neither; an old `values.yaml` renders.
- `packages/cli/src/cmd-doctor*.test.ts`: a chart missing them gets the row and the fix. `bun test scripts/chart-alerts.test.ts`

## Semver
Minor. New rules appear on the next `helm upgrade` of a framework-chart install on a cluster with the operator, stated in `CHANGELOG.md`: a chart moving from no scrape to scraping is the point. An app's own chart changes only on `x g chart-alerts`.

## Done when
- `x new` plus `helm template --api-versions …` renders scrape and rules with no edit.
- `helm install` on a cluster without the CRDs still succeeds.
- `bun run verify` and `scaffold-smoke` green.

## Risks
- **Not exercised:** a live cluster. Expressions are checked for series names, not evaluated; the deploy-proof job in [`33-ops-deploy-proof.md`](33-ops-deploy-proof.md) is where evaluating them could live.
- `.Capabilities` under `helm template` answers from `--api-versions`, so a GitOps pipeline rendering offline gets neither: state it in `values.yaml` beside `auto`.
