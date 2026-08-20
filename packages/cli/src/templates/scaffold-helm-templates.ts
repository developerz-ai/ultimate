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

{{- define "${app.kebab}.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "${app.kebab}.name" .) | trunc 63 | trimSuffix "-" -}}
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
`;

const deployments = (app: NameSet): string => `{{/*
One Deployment per enabled role, from one image. terminationGracePeriodSeconds matches the
framework's SIGTERM drain: in-flight requests, open websockets and running job steps finish.
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
      {{/* At least the framework's drain deadline (25s by default), which is what
      X_SHUTDOWN_TIMEOUT's fix line tells an operator. Raise this WITH configureLifecycle({
      deadlineMs }), never instead of it: the drain abandons its hooks at its own deadline. */}}
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
          - path: /_x/sync
            pathType: Prefix
            backend:
              service:
                name: {{ include "${app.kebab}.fullname" . }}-sync
                port: { name: http }
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
A Pods metric needs a metrics adapter in the cluster; without one the HPA reads <unknown> and
holds at minReplicas, which is why these are opt-in rather than a default nobody wired.
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
  metrics:
    - type: Pods
      pods:
        metric:
          name: {{ $cfg.autoscaling.metric }}
        target:
          type: AverageValue
          averageValue: {{ $cfg.autoscaling.targetAverageValue | quote }}
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
