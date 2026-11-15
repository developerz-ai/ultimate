// The one Grafana dashboard every Ultimate chart ships: requests, latency by route, statements,
// pool, jobs, realtime and the process, over the series the framework declares. One column of
// full-width panels, so a phone reads it as it is. The JSON and its ConfigMap are generated here;
// `docker/helm/` holds these bytes for the chart named `ultimate`.
import { DASHBOARD_PANELS, type DashboardPanel } from './chart-dashboard-panels';
import type { GeneratedFile, NameSet } from './naming';

export type { DashboardPanel, DashboardTarget } from './chart-dashboard-panels';
export { DASHBOARD_PANELS } from './chart-dashboard-panels';

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

/**
 * The dashboard as Grafana's JSON model, two-space indented, one trailing newline. `panels` is a
 * seam for a codemod's test, which re-renders an older release's panel list.
 */
export function dashboardJson(panels: readonly DashboardPanel[] = DASHBOARD_PANELS): string {
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
    panels: panels.map((panel, index) => ({
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
