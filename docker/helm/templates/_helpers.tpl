{{/* Shared naming and pod plumbing. One image, one env block, one security context. */}}

{{- define "ultimate.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ultimate.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "ultimate.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ultimate.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "ultimate.labels" -}}
app.kubernetes.io/name: {{ include "ultimate.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ default .Chart.AppVersion .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
The container spec for a role. `role` is the only thing that varies.

`migrate` is the one role that opens no socket at all — it applies migrations and exits — so it
declares no port and no scrape target. Every OTHER role opens the metrics listener, including the
three that serve no HTTP: `queue_depth` belongs to `worker`, and a pod with no container port
named `metrics` is a ServiceMonitor with nothing to scrape and an HPA pinned at <unknown>.
*/}}
{{- define "ultimate.container" -}}
{{- $role := .role -}}
{{- $cfg := .cfg -}}
{{- $root := .root -}}
{{- $scraped := ne $role "migrate" -}}
{{/*
`roles.<role>.port` is the port the role LISTENS on — the only number a Service, an ingress backend
and two probes can all use. `PORT` is a different number for exactly one role: the sync node binds
`PORT + 1` (packages/cli/src/dev-roles.ts), so a sync container told `PORT=3001` opens 3002 and the
readiness probe polls a socket nobody bound, forever. Derived here rather than stated a second time
in values.yaml, where the two numbers would drift.
*/}}
{{- $envPort := $cfg.port -}}
{{- if and $cfg.port (eq $role "sync") -}}
{{- $envPort = sub (int $cfg.port) 1 -}}
{{- end -}}
- name: {{ $role }}
  image: {{ include "ultimate.image" $root }}
  imagePullPolicy: {{ $root.Values.image.pullPolicy }}
  securityContext: {{- toYaml $root.Values.securityContext | nindent 4 }}
  env:
    - name: ROLE
      value: {{ $role | quote }}
    {{- if $cfg.port }}
    - name: PORT
      value: {{ $envPort | quote }}
    {{- end }}
    {{- if $scraped }}
    - name: METRICS_PORT
      value: {{ $root.Values.metricsPort | quote }}
    {{- end }}
    {{- range $key, $value := $root.Values.env }}
    - name: {{ $key }}
      value: {{ $value | quote }}
    {{- end }}
  envFrom:
    - secretRef:
        name: {{ $root.Values.existingSecret }}
  {{- if or $cfg.port $scraped }}
  ports:
    {{- if $cfg.port }}
    - name: http
      containerPort: {{ $cfg.port }}
    {{- end }}
    {{- if $scraped }}
    - name: metrics
      containerPort: {{ $root.Values.metricsPort | int }}
    {{- end }}
  {{- end }}
  {{/*
  Probes follow the role, because the roles do not agree on what they open. `web` and `sync` serve
  HTTP and get both probes on it. `worker`, `scheduler` and `replicator` open NO HTTP socket at all
  (packages/cli/src/metrics-endpoint.ts) — the scrape listener is the only port they have — so they
  had no probe of any kind and a wedged worker was never restarted by anything. Probing `/readyz` on
  them would have been the mirror-image bug: a port the role never opens, which is exactly what made
  sync's readiness probe meaningless.

  Liveness only for those three, never readiness: nothing routes to them, and a readiness flap would
  drop the pod out of the Service's Endpoints and so out of the Prometheus scrape — losing the
  `queue_depth` series precisely when the worker is busiest. `startRoles` opens the metrics listener
  FIRST, before any role, so it is up early; `failureThreshold: 4` at 15s means ~60s of no event
  loop before a restart, not a boot-time restart loop.
  */}}
  {{- if $cfg.port }}
  readinessProbe:
    httpGet: { path: /readyz, port: http }
    periodSeconds: 5
  livenessProbe:
    httpGet: { path: /healthz, port: http }
    periodSeconds: 15
  {{- else if $scraped }}
  livenessProbe:
    httpGet: { path: /metrics, port: metrics }
    periodSeconds: 15
    failureThreshold: 4
  {{- end }}
  resources: {{- toYaml $cfg.resources | nindent 4 }}
  volumeMounts:
    - name: tmp
      mountPath: /tmp
{{- end -}}
