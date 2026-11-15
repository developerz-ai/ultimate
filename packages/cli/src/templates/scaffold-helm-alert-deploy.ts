// The chart's rules past the request path: latency, the Postgres server (connections, long
// transactions, autovacuum, replication-slot WAL), the framework schema a rollout must apply first,
// and the volumes a namespace's claims fill. Joined into `CHART_ALERTS`; type-only imports, so no cycle.

import type { AlertScope, ChartAlert } from './scaffold-helm-alert-rules';

type Rule = Omit<ChartAlert, 'anchor'>;

/** `docs/ops/06-runbooks.md`'s heading for the rule: its name, lower-cased. */
const rule = (alert: Rule): ChartAlert => ({ ...alert, anchor: alert.alert.toLowerCase() });

/** 1 GiB of WAL held for one slot: minutes of a busy primary, hours of a quiet one. */
const SLOT_RETAINED_BYTES = 1_073_741_824;

const max = (s: AlertScope, series: string, extra = ''): string =>
  `max by (${s.by}${extra}) (${s.series(series)})`;

export const DEPLOY_ALERTS: readonly ChartAlert[] = [
  rule({
    alert: 'UltimateRequestLatency',
    threshold: 1,
    // Release-wide, never per route: a mechanism's floor, not the app's latency objective — an app
    // with one sets its own threshold, or a per-route rule of its own.
    expr: (s) =>
      `histogram_quantile(0.95, sum by (${s.by}, le) ` +
      `(rate(${s.series('http_request_duration_seconds_bucket')}[5m]))) > ${s.threshold(1)}`,
    for: '10m',
    severity: 'warning',
    summary: 'The p95 of request duration is above the threshold, in seconds',
  }),
  rule({
    alert: 'UltimateConnectionsNearMax',
    threshold: 0.8,
    expr: (s) =>
      `max by (${s.by}) (${s.series('db_server_connections')} / ` +
      `${s.series('db_server_max_connections')}) > ${s.threshold(0.8)}`,
    for: '10m',
    severity: 'warning',
    summary: "The Postgres server's open connections are near its max_connections",
  }),
  rule({
    alert: 'UltimateLongTransaction',
    threshold: 300,
    expr: (s) => `${max(s, 'db_longest_transaction_seconds')} > ${s.threshold(300)}`,
    for: '5m',
    severity: 'warning',
    summary: 'A transaction has been open longer than the threshold, holding back vacuum and locks',
  }),
  rule({
    alert: 'UltimateAutovacuumLag',
    threshold: 2,
    expr: (s) => `${max(s, 'db_autovacuum_backlog_ratio')} > ${s.threshold(2)}`,
    for: '30m',
    severity: 'warning',
    summary:
      'A table holds more dead tuples than its autovacuum trigger, and is not being vacuumed',
  }),
  rule({
    alert: 'UltimateReplicationSlotRetention',
    threshold: SLOT_RETAINED_BYTES,
    expr: (s) =>
      `${max(s, 'db_replication_slot_retained_bytes', ', slot')} > ${s.threshold(SLOT_RETAINED_BYTES)}`,
    for: '15m',
    severity: 'warning',
    summary: 'A replication slot holds more WAL on the primary than the threshold, in bytes',
  }),
  rule({
    alert: 'UltimateSchemaUnapplied',
    expr: (s) =>
      `count by (${s.by}, ${s.component}) (${s.series('framework_schema_applied')} == 0) > 0`,
    for: '10m',
    severity: 'critical',
    summary: "A role's build has no framework schema applied: the migrate step has not run",
  }),
  rule({
    alert: 'UltimateVersionSkew',
    expr: (s) => `${max(s, 'framework_schema_major_skew')} > 0`,
    for: '30m',
    severity: 'warning',
    summary: 'Roles run a different major than the newest applied framework schema',
  }),
  rule({
    alert: 'UltimateVolumeNearFull',
    threshold: 0.85,
    // The kubelet's series, per claim in the release's namespace: the chart mounts no claim, so the
    // volumes this reads are its neighbours' — the database's, most often.
    expr: (s) =>
      `max by (namespace, persistentvolumeclaim) (${s.namespaced('kubelet_volume_stats_used_bytes')} / ` +
      `${s.namespaced('kubelet_volume_stats_capacity_bytes')}) > ${s.threshold(0.85)}`,
    for: '15m',
    severity: 'warning',
    summary: "A persistent volume in the release's namespace is fuller than the threshold",
  }),
];
