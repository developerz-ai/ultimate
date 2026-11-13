// The one Grafana dashboard every Ultimate chart ships: requests, latency by route, statements,
// pool, jobs, realtime and the process, over the series the framework declares. One column of
// full-width panels, so a phone reads it as it is. The JSON and its ConfigMap are generated here;
// `docker/helm/` holds these bytes for the chart named `ultimate`.
import type { GeneratedFile, NameSet } from './naming';

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
];

/** The stable uid a provisioned dashboard keeps across upgrades, so a bookmark survives. */
export const DASHBOARD_UID = 'ultimate-app';
export const DASHBOARD_FILE = 'docker/helm/dashboards/ultimate-app.json';

/** Every panel and variable reads the dashboard's own datasource variable. */
const DATASOURCE = { type: 'prometheus', uid: '$datasource' } as const;

const variable = (name: string, query: string) => ({
  name,
  type: 'query',
  datasource: DATASOURCE,
  query: { query, refId: name },
  refresh: 2,
  includeAll: false,
  multi: false,
});

const PANEL_HEIGHT = 8;

/** The dashboard as Grafana's JSON model, two-space indented, one trailing newline. */
export function dashboardJson(): string {
  const model = {
    uid: DASHBOARD_UID,
    title: 'Ultimate app',
    tags: ['ultimate'],
    timezone: 'utc',
    schemaVersion: 39,
    editable: true,
    time: { from: 'now-6h', to: 'now' },
    templating: {
      list: [
        { name: 'datasource', type: 'datasource', query: 'prometheus' },
        variable('namespace', 'label_values(process_info, namespace)'),
        variable(
          'release',
          'label_values(process_info{namespace="$namespace"}, app_kubernetes_io_instance)',
        ),
      ],
    },
    panels: DASHBOARD_PANELS.map((panel, index) => ({
      id: index + 1,
      type: 'timeseries',
      title: panel.title,
      datasource: DATASOURCE,
      // One full-width column: the grid is 24 wide, and a phone shows it unchanged.
      gridPos: { x: 0, y: index * PANEL_HEIGHT, w: 24, h: PANEL_HEIGHT },
      fieldConfig: { defaults: { unit: panel.unit }, overrides: [] },
      targets: panel.targets.map((target, at) => ({
        refId: String.fromCharCode(65 + at),
        expr: target.expr,
        legendFormat: target.legend,
      })),
    })),
  };
  return `${biomeJson(model)}\n`;
}

const SCALAR = String.raw`(?:"(?:[^"\\\n]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)`;
const SCALAR_ARRAY = new RegExp(String.raw`\[\n\s+(${SCALAR}(?:,\n\s+${SCALAR})*)\n\s*\]`, 'g');

/**
 * `JSON.stringify` at two spaces, with an array of scalars on one line — how Biome formats JSON, so
 * the file `x new` writes passes the app's own `biome check`. Objects stay expanded, as Biome keeps
 * them.
 */
function biomeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    SCALAR_ARRAY,
    (_all, items: string) => `[${items.split(/,\n\s+/).join(', ')}]`,
  );
}

const configMapTemplate = (chart: string): string => `{{/*
The chart's Grafana dashboard (dashboards/ultimate-app.json, written from @ultimat3/cli's panel
table), as a ConfigMap a Grafana sidecar provisions by label. Opt-in: dashboard.enabled. The JSON
is read with .Files.Get, never templated: its legends use Grafana's own double-brace syntax.
*/}}
{{- $cfg := .Values.dashboard | default dict }}
{{- if eq (toString $cfg.enabled) "true" }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "${chart}.fullname" . }}-dashboard
  labels:
    {{- include "${chart}.labels" . | nindent 4 }}
    {{- toYaml ($cfg.labels | default (dict "grafana_dashboard" "1")) | nindent 4 }}
  {{- with $cfg.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
data:
  ultimate-app.json: |-
{{ .Files.Get "dashboards/ultimate-app.json" | indent 4 }}
{{- end }}
`;

/** The dashboard and the template that ships it. */
export function helmDashboardFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: DASHBOARD_FILE, contents: dashboardJson() },
    {
      path: 'docker/helm/templates/dashboard-configmap.yaml',
      contents: configMapTemplate(app.kebab),
    },
  ];
}
