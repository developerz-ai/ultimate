// The panel table of the Grafana dashboard every Ultimate chart ships: requests, latency, statements,
// pool, jobs, realtime, the process, the Postgres server and the framework schema, over the series
// the framework declares. `chart-dashboard.ts` renders it as Grafana's JSON model.

export interface DashboardTarget {
  readonly expr: string;
  /** Grafana's legend template, `{{label}}` interpolated per series. */
  readonly legend: string;
}

export interface DashboardPanel {
  readonly title: string;
  /** Grafana's unit id: `reqps`, `s`, `bytes`, `percentunit`, `short`. */
  readonly unit: string;
  readonly targets: readonly DashboardTarget[];
}

/** One release in one namespace — the two labels the ServiceMonitor puts on every series. */
const SCOPE = 'namespace="$namespace",app_kubernetes_io_instance="$release"';
const RATE = '[$__rate_interval]';

const s = (name: string, extra?: string): string =>
  `${name}{${extra === undefined ? SCOPE : `${SCOPE},${extra}`}}`;

const p = (q: number, name: string, by: string): string =>
  `histogram_quantile(${String(q)}, sum by (${by}, le) (rate(${s(`${name}_bucket`)}${RATE})))`;

export const DASHBOARD_PANELS: readonly DashboardPanel[] = [
  {
    title: 'Requests per second, by status class',
    unit: 'reqps',
    targets: [
      { expr: `sum by (status) (rate(${s('http_requests_total')}${RATE}))`, legend: '{{status}}' },
    ],
  },
  {
    title: 'Latency p95, by route',
    unit: 's',
    targets: [{ expr: p(0.95, 'http_request_duration_seconds', 'route'), legend: '{{route}}' }],
  },
  {
    title: '5xx share of requests',
    unit: 'percentunit',
    targets: [
      {
        expr: `sum(rate(${s('http_requests_total', 'status="5xx"')}${RATE})) / sum(rate(${s('http_requests_total')}${RATE}))`,
        legend: '5xx',
      },
    ],
  },
  {
    title: 'Statement p95, by operation',
    unit: 's',
    targets: [
      {
        expr: p(0.95, 'db_client_operation_duration_seconds', 'db_operation_name'),
        legend: 'p95 {{db_operation_name}}',
      },
    ],
  },
  {
    title: 'Database pool, by pod',
    unit: 'short',
    targets: [
      { expr: `sum by (pod) (${s('db_pool_in_use')})`, legend: 'in use {{pod}}' },
      { expr: `sum by (pod) (${s('db_pool_waiting')})`, legend: 'waiting {{pod}}' },
      { expr: `sum by (pod) (${s('db_pool_max')})`, legend: 'max {{pod}}' },
    ],
  },
  {
    title: 'Jobs per second, by queue and outcome',
    unit: 'short',
    targets: [
      {
        expr: `sum by (queue, outcome) (rate(${s('jobs_total')}${RATE}))`,
        legend: '{{queue}} {{outcome}}',
      },
    ],
  },
  {
    title: 'Queue: oldest ready job and dead letters',
    unit: 's',
    targets: [
      { expr: `max by (queue) (${s('queue_oldest_ready_seconds')})`, legend: 'oldest {{queue}}' },
      { expr: `max by (queue) (${s('queue_dead_jobs')})`, legend: 'dead {{queue}}' },
    ],
  },
  {
    title: 'Job duration p95, by queue',
    unit: 's',
    targets: [{ expr: p(0.95, 'job_duration_seconds', 'queue'), legend: '{{queue}}' }],
  },
  {
    title: 'Realtime: connections and dropped frames',
    unit: 'short',
    targets: [
      { expr: `sum by (pod) (${s('connections')})`, legend: 'connections {{pod}}' },
      {
        expr: `sum(rate(${s('channel_frames_dropped_total')}${RATE}))`,
        legend: 'frames dropped/s',
      },
    ],
  },
  {
    title: 'Memory: RSS over the container limit, by pod',
    unit: 'percentunit',
    targets: [
      {
        expr: `max by (pod) (${s('process_resident_memory_bytes')} / ${s('process_memory_limit_bytes')})`,
        legend: '{{pod}}',
      },
    ],
  },
  {
    title: 'CPU seconds per second, by pod',
    unit: 'short',
    targets: [
      { expr: `sum by (pod) (rate(${s('process_cpu_seconds_total')}${RATE}))`, legend: '{{pod}}' },
    ],
  },
  {
    title: 'Event-loop lag p99, by pod',
    unit: 's',
    targets: [{ expr: p(0.99, 'process_event_loop_lag_seconds', 'pod'), legend: '{{pod}}' }],
  },
  {
    title: 'Restarts in the last hour, by role',
    unit: 'short',
    targets: [
      {
        expr: `sum by (app_kubernetes_io_component) (changes(${s('process_start_time_seconds')}[1h]))`,
        legend: '{{app_kubernetes_io_component}}',
      },
    ],
  },
  {
    title: 'Postgres: client connections against max_connections',
    unit: 'short',
    targets: [
      { expr: `max(${s('db_server_connections')})`, legend: 'connections' },
      { expr: `max(${s('db_server_max_connections')})`, legend: 'max_connections' },
    ],
  },
  {
    title: 'Postgres: longest open transaction',
    unit: 's',
    targets: [{ expr: `max(${s('db_longest_transaction_seconds')})`, legend: 'longest' }],
  },
  {
    title: 'Postgres: autovacuum backlog, the worst table (1 = due)',
    unit: 'short',
    targets: [{ expr: `max(${s('db_autovacuum_backlog_ratio')})`, legend: 'dead / trigger' }],
  },
  {
    title: 'Postgres: WAL retained, by replication slot',
    unit: 'bytes',
    targets: [
      {
        expr: `max by (slot) (${s('db_replication_slot_retained_bytes')})`,
        legend: '{{slot}}',
      },
    ],
  },
  {
    title: 'Framework schema: unapplied and major skew, by role',
    unit: 'short',
    targets: [
      {
        expr: `count by (app_kubernetes_io_component) (${s('framework_schema_applied')} == 0)`,
        legend: 'unapplied {{app_kubernetes_io_component}}',
      },
      {
        expr: `max by (app_kubernetes_io_component) (${s('framework_schema_major_skew')})`,
        legend: 'skew {{app_kubernetes_io_component}}',
      },
    ],
  },
];
