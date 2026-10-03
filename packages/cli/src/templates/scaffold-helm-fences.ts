// What a compromised pod of the scaffolded chart can reach: its `/tmp`, bounded, and its ports,
// fenced by one NetworkPolicy per role. The framework chart's own (`docker/helm/`), mirrored —
// `scaffold-helm-parity.test.ts` holds the two to each other.

import type { GeneratedFile, NameSet } from './naming';

const volumes = (app: NameSet): string => `{{/*
The writable scratch every pod mounts at /tmp — the root filesystem is read-only. Bounded, because
an emptyDir with no sizeLimit is node disk: one role filling /tmp evicts its NEIGHBOURS for disk
pressure, where with a limit the kubelet evicts that pod alone.
*/}}
{{- define "${app.kebab}.tmpVolume" -}}
- name: tmp
  emptyDir:
    sizeLimit: {{ required "tmp.sizeLimit is unset — set it in your values (e.g. 512Mi): an unbounded /tmp is node disk" (default dict .Values.tmp).sizeLimit | quote }}
{{- end -}}
`;

const networkPolicy = (app: NameSet): string => `{{/*
One NetworkPolicy per enabled role: \`http\` (web, sync) from networkPolicy.httpFrom, \`metrics\`
(every role) from networkPolicy.metricsFrom, nothing else. A \`from\` that renders empty is omitted,
which Kubernetes reads as "any source". Egress is filtered only when networkPolicy.egress lists
rules — the database, NATS and object store are your addresses, so list DNS too. Serving roles
only: the migrate Job is a pre-install hook that runs before this exists, and opens no port.
*/}}
{{- if .Values.networkPolicy.enabled }}
{{- range $role, $cfg := .Values.roles }}
{{- if $cfg.enabled }}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "${app.kebab}.fullname" $ }}-{{ $role }}
  labels:
    {{- include "${app.kebab}.labels" $ | nindent 4 }}
    app.kubernetes.io/component: {{ $role }}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/instance: {{ $.Release.Name }}
      app.kubernetes.io/component: {{ $role }}
  policyTypes:
    - Ingress
    {{- if $.Values.networkPolicy.egress }}
    - Egress
    {{- end }}
  ingress:
    {{- if $cfg.port }}
    - ports:
        - port: http
          protocol: TCP
      {{- with $.Values.networkPolicy.httpFrom }}
      from: {{- toYaml . | nindent 8 }}
      {{- end }}
    {{- end }}
    - ports:
        - port: metrics
          protocol: TCP
      {{- with $.Values.networkPolicy.metricsFrom }}
      from: {{- toYaml . | nindent 8 }}
      {{- end }}
  {{- with $.Values.networkPolicy.egress }}
  egress: {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
{{- end }}
{{- end }}
`;

/** The bounded /tmp helper and the per-role NetworkPolicy, as two files of the chart's templates. */
export function helmFenceFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'docker/helm/templates/_volumes.tpl', contents: volumes(app) },
    { path: 'docker/helm/templates/networkpolicy.yaml', contents: networkPolicy(app) },
  ];
}
