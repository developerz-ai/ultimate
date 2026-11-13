// The monitoring objects every Ultimate chart ships: the scrape object and the alert rules. The
// rules are one table (`scaffold-helm-alert-rules.ts`), rendered here as the chart's PrometheusRule
// template and as plain rule groups for a loader outside Kubernetes.
import type { GeneratedFile, NameSet } from './naming';
import type { AlertScope, ChartAlert } from './scaffold-helm-alert-rules';
import { budgetOf, CHART_ALERTS, DEFAULT_OBJECTIVE } from './scaffold-helm-alert-rules';

/** Where `runbook_url` points unless `alerts.runbookBase` says otherwise. */
export const RUNBOOK_BASE =
  'https://github.com/developerz-ai/ultimate/blob/main/docs/ops/06-runbooks.md';

const matchers = (own: string, extra?: string): string =>
  [own, extra].filter((part) => part !== undefined && part !== '').join(',');

/**
 * The chart's scope: one release in one namespace, the two labels the ServiceMonitor's
 * `targetLabels` and the operator put on every series. A threshold reads the rule's value.
 */
export const K8S_SCOPE: AlertScope = {
  series: (name, extra) =>
    `${name}{${matchers('namespace="{{ $.Release.Namespace }}",app_kubernetes_io_instance="{{ $.Release.Name }}"', extra)}}`,
  by: 'namespace, app_kubernetes_io_instance',
  component: 'app_kubernetes_io_component',
  // The operator's own target label: one pod, whichever role it runs.
  target: 'pod',
  threshold: (fallback) => `{{ ternary $r.threshold ${fallback} (hasKey $r "threshold") }}`,
  budget: budgetOf('{{ $objective }}'),
};

const plainScope = (own: string, objective: number): AlertScope => ({
  series: (name, extra) => {
    const inner = matchers(own, extra);
    return inner === '' ? name : `${name}{${inner}}`;
  },
  by: 'job',
  component: 'instance',
  target: 'instance',
  threshold: (fallback) => String(fallback),
  budget: budgetOf(String(objective)),
});

/**
 * The rules as one plain Prometheus rule group, defaults in place, scoped by `own` matchers, the
 * burn-rate rules against `objective` (percent).
 */
export function alertRuleGroups(own = '', objective: number = DEFAULT_OBJECTIVE): string {
  const scope = plainScope(own, objective);
  const rules = CHART_ALERTS.map(
    (a) => `      - alert: ${a.alert}
        expr: >-
          ${a.expr(scope)}
        for: ${a.for}
        labels:
          severity: ${a.severity}
        annotations:
          summary: ${JSON.stringify(a.summary)}
          runbook_url: ${JSON.stringify(`${RUNBOOK_BASE}#${a.anchor}`)}
`,
  ).join('');
  return `groups:\n  - name: ultimate\n    rules:\n${rules}`;
}

/** One rule of the chart template: every field a value under `alerts.rules.<alert>` may replace. */
const chartRule = (
  a: ChartAlert,
): string => `        {{- $r := index $rules "${a.alert}" | default dict }}
        {{- if ne (toString $r.enabled) "false" }}
        - alert: ${a.alert}
          expr: >-
            ${a.expr(K8S_SCOPE)}
          for: {{ $r.for | default "${a.for}" }}
          labels:
            severity: {{ $r.severity | default "${a.severity}" }}
          annotations:
            summary: ${JSON.stringify(a.summary)}
            runbook_url: {{ printf "%s#${a.anchor}" $base | quote }}
        {{- end }}
`;

/**
 * The `enabled` switch both monitoring objects share: `auto` (and a values file with no such block)
 * renders when the cluster serves the operator's kind, `true` forces it, `false` declines it.
 */
const operatorGate = (
  key: string,
  kind: string,
): string => `{{- $cfg := .Values.${key} | default dict }}
{{- $mode := toString (ternary $cfg.enabled "auto" (hasKey $cfg "enabled")) }}
{{- if not (has $mode (list "auto" "true" "false")) }}
{{- fail (printf "${key}.enabled is %q — set it to auto (render when the cluster serves monitoring.coreos.com/v1/${kind}), true or false" $mode) }}
{{- end }}
{{- if or (eq $mode "true") (and (eq $mode "auto") (.Capabilities.APIVersions.Has "monitoring.coreos.com/v1/${kind}")) }}`;

const alertRulesTemplate = (chart: string): string => `{{/*
The alert rules for this release's own series, written from @ultimat3/cli's rule table. Each rule
reads alerts.rules.<alert> for threshold, for, severity and enabled; its runbook_url is
alerts.runbookBase plus the rule's anchor; the burn-rate rules read alerts.objective (percent).
Rendered by capability, like servicemonitor.yaml.
*/}}
${operatorGate('alerts', 'PrometheusRule')}
{{- $objective := float64 (ternary $cfg.objective ${DEFAULT_OBJECTIVE} (hasKey $cfg "objective")) }}
{{- if not (and (gt $objective 0.0) (lt $objective 100.0)) }}
{{- fail (printf "alerts.objective is %v — set it to the percent of requests answered without a 5xx, above 0 and below 100, e.g. 99.9" $objective) }}
{{- end }}
{{- $rules := $cfg.rules | default dict }}
{{- $base := $cfg.runbookBase | default "${RUNBOOK_BASE}" }}
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ include "${chart}.fullname" . }}
  labels:
    {{- include "${chart}.labels" . | nindent 4 }}
    {{- with $cfg.labels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
spec:
  groups:
    - name: {{ include "${chart}.fullname" . }}.ultimate
      rules:
${CHART_ALERTS.map(chartRule).join('')}{{- end }}
`;

const serviceMonitorTemplate = (chart: string): string => `{{/*
Prometheus-operator discovery for the scrape listener every serving role opens, rendered by
capability: serviceMonitor.enabled auto (the default, and a values file with no such block) renders
it when the cluster serves the kind, so a cluster without the operator still installs. ONE object
for the release: every role's Service publishes the same \`metrics\` port name. targetLabels carry
the role and the release onto every series, which is what alert-rules.yaml and an HPA key on.
*/}}
${operatorGate('serviceMonitor', 'ServiceMonitor')}
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: {{ include "${chart}.fullname" . }}
  labels:
    {{- include "${chart}.labels" . | nindent 4 }}
    {{- with $cfg.labels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ include "${chart}.name" . }}
      app.kubernetes.io/instance: {{ .Release.Name }}
  targetLabels:
    - app.kubernetes.io/component
    - app.kubernetes.io/instance
  endpoints:
    # The Service port NAME, never the integer: moving metricsPort moves nothing here.
    - port: metrics
      path: /metrics
      interval: {{ $cfg.interval | default "15s" }}
      scrapeTimeout: {{ $cfg.scrapeTimeout | default "10s" }}
{{- end }}
`;

/**
 * The chart's two monitoring templates. The framework chart's copies (\`docker/helm/templates/\`)
 * are these bytes for the chart named \`ultimate\`, held by \`scaffold-helm-parity.test.ts\`.
 */
export function helmMonitoringFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    {
      path: 'docker/helm/templates/servicemonitor.yaml',
      contents: serviceMonitorTemplate(app.kebab),
    },
    { path: 'docker/helm/templates/alert-rules.yaml', contents: alertRulesTemplate(app.kebab) },
  ];
}
