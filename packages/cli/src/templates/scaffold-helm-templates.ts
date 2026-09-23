// The Kubernetes objects the scaffolded chart renders: one Deployment and one Service per enabled
// role, the release-phase Job, an optional ingress and an optional per-role autoscaler.
// Split from scaffold-helm.ts, which holds the chart's INPUTS (Chart.yaml, values.yaml).

import type { GeneratedFile, NameSet } from './naming';

const helpers = (
  app: NameSet,
): string => `{{/* Shared naming and the one container spec every role renders. */}}

{{- define "${app.kebab}.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
helm create's rule: a release whose name already contains the chart's is the full name on its own.
x deploy --method helm names the release after the app, which IS the chart name, so without it
every object would be ${app.kebab}-${app.kebab}-web.
*/}}
{{- define "${app.kebab}.fullname" -}}
{{- $name := include "${app.kebab}.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
repository:tag, and NOT a single "image" string: x deploy --method helm passes
--set image.repository=... --set image.tag=..., because replacing the map with a string makes
every workload below fail on .repository and deploy nothing.
*/}}
{{- define "${app.kebab}.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "${app.kebab}.labels" -}}
app.kubernetes.io/name: {{ include "${app.kebab}.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ default .Chart.AppVersion .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
The container spec for a role. ROLE is the only thing that varies, exactly as in
docker-compose.prod.yml: one image, one entry point, N processes.

migrate is the one role that opens no socket at all — it applies migrations and exits — so it
declares no port and no scrape target.
*/}}
{{- define "${app.kebab}.container" -}}
{{- $role := .role -}}
{{- $cfg := .cfg -}}
{{- $root := .root -}}
{{- $scraped := ne $role "migrate" -}}
{{/*
roles.<role>.port is the port the role LISTENS on — the one number a Service, an ingress backend
and two probes can all use. PORT is a different number for exactly one role: the sync node binds
PORT + 1, so a sync container told PORT=3001 opens 3002 and the readiness probe polls a socket
nobody bound. Derived here rather than stated twice in values.yaml, where the two would drift.
*/}}
{{- $envPort := $cfg.port -}}
{{- if and $cfg.port (eq $role "sync") -}}
{{- $envPort = sub (int $cfg.port) 1 -}}
{{- end -}}
- name: {{ $role }}
  image: {{ include "${app.kebab}.image" $root }}
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
  Probes follow the role, because the roles do not agree on what they open. web and sync serve
  HTTP and get both. worker, scheduler and replicator open no HTTP socket at all — the scrape
  listener is their only port — so they take liveness on it and NO readiness: nothing routes to
  them, and a readiness flap would drop the pod out of the Service and so out of the scrape.

  Every one of them takes a startupProbe too, because no listener opens early: the server builds
  the app's islands before any role binds a port, and a liveness probe counting from container
  start restarts a pod that is merely booting. 30 x 5s = 150s of boot, then the ordinary checks.
  */}}
  {{- if $cfg.port }}
  startupProbe:
    httpGet: { path: /healthz, port: http }
    periodSeconds: 5
    failureThreshold: 30
  readinessProbe:
    httpGet: { path: /readyz, port: http }
    periodSeconds: 5
  livenessProbe:
    httpGet: { path: /healthz, port: http }
    periodSeconds: 15
  {{- /*
  Holds SIGTERM back while the pod is already out of its Service's endpoints, so a proxy that has
  not caught up still reaches a listener that answers. lifecycle.preStop.sleep exists from
  Kubernetes 1.30 and this chart's floor is 1.27, so it renders only where the API server knows it;
  below that the framework's own readiness grace (/readyz at 503, listener still open) covers it.
  */}}
  {{- if semverCompare ">=1.30-0" $root.Capabilities.KubeVersion.Version }}
  lifecycle:
    preStop:
      sleep: { seconds: {{ $root.Values.drain.preStopSleepSeconds | int }} }
  {{- end }}
  {{- else if $scraped }}
  startupProbe:
    httpGet: { path: /metrics, port: metrics }
    periodSeconds: 5
    failureThreshold: 30
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
`;

const deployments = (app: NameSet): string => `{{/*
One Deployment per enabled role, from one image. terminationGracePeriodSeconds covers the preStop
sleep, the framework's readiness grace and its SIGTERM drain: in-flight requests, open websockets
and running job steps finish.
*/}}
{{- range $role, $cfg := .Values.roles }}
{{- if $cfg.enabled }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "${app.kebab}.fullname" $ }}-{{ $role }}
  labels:
    {{- include "${app.kebab}.labels" $ | nindent 4 }}
    app.kubernetes.io/component: {{ $role }}
spec:
  {{/* Ask whether the block EXISTS before reading through it: scheduler and replicator declare
  none, and without the guard the whole chart fails to render. */}}
  {{- if not (and $cfg.autoscaling $cfg.autoscaling.enabled) }}
  replicas: {{ $cfg.replicas }}
  {{- end }}
  selector:
    matchLabels:
      app.kubernetes.io/instance: {{ $.Release.Name }}
      app.kubernetes.io/component: {{ $role }}
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }
  template:
    metadata:
      labels:
        {{- include "${app.kebab}.labels" $ | nindent 8 }}
        app.kubernetes.io/component: {{ $role }}
    spec:
      {{/* No role in this image calls the Kubernetes API — ROLE comes from the env and everything
      else from app.config.ts. Mounting the token anyway hands a JWT for this namespace to any
      code that reaches the filesystem, which for a web role is one path traversal. */}}
      automountServiceAccountToken: false
      securityContext: {{- toYaml $.Values.podSecurityContext | nindent 8 }}
      {{/* Spent in order: the preStop sleep (drain.preStopSleepSeconds, 1.30+), the framework's
      readiness grace (5s outside local environments) and its drain deadline (25s, which is what
      X_SHUTDOWN_TIMEOUT's fix line names) — 35s, so 45 leaves 10s before SIGKILL. Raise this WITH
      configureLifecycle({ deadlineMs, readinessGraceMs }), never instead of it: the drain
      abandons its hooks at its own deadline. */}}
      terminationGracePeriodSeconds: 45
      containers:
        {{- include "${app.kebab}.container" (dict "role" $role "cfg" $cfg "root" $) | nindent 8 }}
      volumes:
        - name: tmp
          emptyDir: {}
{{- end }}
{{- end }}
`;

const service = (app: NameSet): string => `{{/*
One Service per enabled role. The roles that take no traffic still get one, HEADLESS: it exists so
a scrape target and a DNS name exist, and a headless Service allocates no ClusterIP, so nothing
about it invites traffic it would not answer.
*/}}
{{- range $role, $cfg := .Values.roles }}
{{- if $cfg.enabled }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ include "${app.kebab}.fullname" $ }}-{{ $role }}
  labels:
    {{- include "${app.kebab}.labels" $ | nindent 4 }}
    app.kubernetes.io/component: {{ $role }}
spec:
  type: ClusterIP
  {{- if not $cfg.port }}
  clusterIP: None
  {{- end }}
  selector:
    app.kubernetes.io/instance: {{ $.Release.Name }}
    app.kubernetes.io/component: {{ $role }}
  ports:
    {{- if $cfg.port }}
    - name: http
      port: 80
      targetPort: http
    {{- end }}
    - name: metrics
      port: {{ $.Values.metricsPort | int }}
      targetPort: metrics
{{- end }}
{{- end }}
`;

const migrateJob = (app: NameSet): string => `{{/*
The release phase, as a pre-install / pre-upgrade hook: ROLE=migrate applies every pending
migration under an advisory lock and exits, before any serving role starts. Same image, same entry
point — there is no second migration engine and no toolchain in the container.
*/}}
{{- if .Values.migrate.enabled }}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "${app.kebab}.fullname" . }}-migrate
  labels:
    {{- include "${app.kebab}.labels" . | nindent 4 }}
    app.kubernetes.io/component: migrate
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "-5"
    helm.sh/hook-delete-policy: before-hook-creation
spec:
  backoffLimit: {{ .Values.migrate.backoffLimit }}
  template:
    metadata:
      labels:
        {{- include "${app.kebab}.labels" . | nindent 8 }}
        app.kubernetes.io/component: migrate
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext: {{- toYaml .Values.podSecurityContext | nindent 8 }}
      containers:
        {{- include "${app.kebab}.container" (dict "role" "migrate" "cfg" .Values.migrate "root" .) | nindent 8 }}
      volumes:
        - name: tmp
          emptyDir: {}
{{- end }}
`;

const ingress = (
  app: NameSet,
): string => `{{/* Standard ingress, no vendor edge primitives. Off by default: the host is yours to name. */}}
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "${app.kebab}.fullname" . }}
  labels:
    {{- include "${app.kebab}.labels" . | nindent 4 }}
spec:
  ingressClassName: {{ .Values.ingress.className }}
  {{- if .Values.ingress.tls }}
  tls:
    - hosts: [{{ .Values.ingress.host | quote }}]
      secretName: {{ include "${app.kebab}.fullname" . }}-tls
  {{- end }}
  rules:
    - host: {{ .Values.ingress.host | quote }}
      http:
        paths:
          {{- /* The path the sync node actually serves. Routing /_sync instead sends every
          websocket to the web role, which answers no upgrade. */}}
          {{- /* Only when the sync role runs: a rule naming a Service the chart did not render is an
          ingress that 503s every websocket instead of letting it reach nothing at all. */}}
          {{- if .Values.roles.sync.enabled }}
          - path: /_x/sync
            pathType: Prefix
            backend:
              service:
                name: {{ include "${app.kebab}.fullname" . }}-sync
                port: { name: http }
          {{- end }}
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ include "${app.kebab}.fullname" . }}-web
                port: { name: http }
{{- end }}
`;

const hpa = (app: NameSet): string => `{{/*
Per-role autoscalers, off until you turn one on. Each role scales on the signal that predicts ITS
saturation — CPU is a lagging proxy for all three and scales the wrong thing at the wrong time.
Either metric type needs a metrics adapter in the cluster; without one the HPA reads <unknown> and
holds at minReplicas, which is why these are opt-in rather than a default nobody wired.

autoscaling.type says whose number it is. Pods (the default) is a per-pod series — rps, open
sockets — averaged across pods. External is ONE series for the whole role, divided by the replica
count: queue_depth is that shape, because every worker publishes the same global backlog, and read
as Pods it asked for N times the workers the queue needed. Any other type fails the render.
*/}}
{{- range $role, $cfg := .Values.roles }}
{{- if and $cfg.enabled $cfg.autoscaling $cfg.autoscaling.enabled }}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "${app.kebab}.fullname" $ }}-{{ $role }}
  labels:
    {{- include "${app.kebab}.labels" $ | nindent 4 }}
    app.kubernetes.io/component: {{ $role }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "${app.kebab}.fullname" $ }}-{{ $role }}
  minReplicas: {{ $cfg.autoscaling.minReplicas }}
  maxReplicas: {{ $cfg.autoscaling.maxReplicas }}
  {{- $type := default "Pods" $cfg.autoscaling.type }}
  {{- if not (has $type (list "Pods" "External")) }}
  {{- fail (printf "roles.%s.autoscaling.type is %q — set it to Pods (a per-pod series) or External (one series for the whole role, e.g. queue_depth)" $role $type) }}
  {{- end }}
  metrics:
    {{- if eq $type "External" }}
    - type: External
      external:
        metric:
          name: {{ $cfg.autoscaling.metric }}
        target:
          type: AverageValue
          averageValue: {{ $cfg.autoscaling.targetAverageValue | quote }}
    {{- else }}
    - type: Pods
      pods:
        metric:
          name: {{ $cfg.autoscaling.metric }}
        target:
          type: AverageValue
          averageValue: {{ $cfg.autoscaling.targetAverageValue | quote }}
    {{- end }}
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
    scaleDown:
      stabilizationWindowSeconds: 300
{{- end }}
{{- end }}
`;

/** The chart's `templates/` directory, in the order a reader meets it. */
export function helmTemplateFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'docker/helm/templates/_helpers.tpl', contents: helpers(app) },
    { path: 'docker/helm/templates/deployments.yaml', contents: deployments(app) },
    { path: 'docker/helm/templates/service.yaml', contents: service(app) },
    { path: 'docker/helm/templates/migrate-job.yaml', contents: migrateJob(app) },
    { path: 'docker/helm/templates/ingress.yaml', contents: ingress(app) },
    { path: 'docker/helm/templates/hpa.yaml', contents: hpa(app) },
  ];
}
