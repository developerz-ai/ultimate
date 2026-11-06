{{/* Shared naming and the one container spec every role renders. */}}

{{- define "docs-site.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
helm create's rule: a release whose name already contains the chart's is the full name on its own.
x deploy --method helm names the release after the app, which IS the chart name, so without it
every object would be docs-site-docs-site-web.
*/}}
{{- define "docs-site.fullname" -}}
{{- $name := include "docs-site.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
repository:tag, and NOT a single "image" string: x deploy --method helm passes
--set-string image.repository=... --set-string image.tag=..., because replacing the map with a
string makes every workload below fail on .repository and deploy nothing. toString on both halves:
a plain --set image.tag=1234567 is an int64, which printf renders as %!s(int64=1234567).
*/}}
{{- define "docs-site.image" -}}
{{- $repository := required "image.repository is empty — set it to the registry path your CI pushes the app image to: --set-string image.repository=ghcr.io/<org>/<app>, or x deploy --method helm --image ghcr.io/<org>/<app>:<tag>" .Values.image.repository -}}
{{- printf "%s:%s" (toString $repository) (toString (default .Chart.AppVersion .Values.image.tag)) -}}
{{- end -}}

{{- define "docs-site.labels" -}}
app.kubernetes.io/name: {{ include "docs-site.name" . }}
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
{{- define "docs-site.container" -}}
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
  image: {{ include "docs-site.image" $root | quote }}
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
    {{- /*
    The sync node's page origin, from the one place this chart already knows it. Undeclared, a node
    reached over plain http behind this Ingress admits BOTH spellings of its host — the plain-http
    page included. env.APP_URL wins when set; an APP_URL kept in the Secret is shadowed for this
    role, so pages served from another host than the Ingress's must say so in env.
    */}}
    {{- if and (eq $role "sync") $root.Values.ingress.enabled (not (hasKey $root.Values.env "APP_URL")) }}
    - name: APP_URL
      value: {{ printf "%s://%s" (ternary "https" "http" $root.Values.ingress.tls) $root.Values.ingress.host | quote }}
    {{- end }}
    {{- range $key, $value := $root.Values.env }}
    - name: {{ $key }}
      value: {{ $value | quote }}
    {{- end }}
  {{- /*
  The Secret a role reads, per role: roles.<role>.existingSecret (or migrate.existingSecret) names a
  narrower one than the release-wide existingSecret, so the migrate Job's schema-owning credential
  need not sit on a web pod. Both unset is a render error, not a pod with no configuration.
  */}}
  envFrom:
    - secretRef:
        name: {{ required (printf "no Secret for role %s — set existingSecret, or roles.%s.existingSecret, in your values" $role $role) (default $root.Values.existingSecret $cfg.existingSecret) }}
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
  listener is their only port — so they take liveness on it, and readiness on /readyz of that same
  listener: 503 until the role has started and from the first instant of a drain, so a rollout
  never counts a worker that has not started its role yet. The replicator reads /readyz?deep=1:
  503 while the replication stream is down, so the pod shows 0/1 instead of a healthy pod feeding
  nothing. Their headless Service publishes not-ready addresses, so a not-ready pod is still
  scraped.

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
  readinessProbe:
    {{- if eq $role "replicator" }}
    httpGet: { path: '/readyz?deep=1', port: metrics }
    periodSeconds: 10
    {{- else }}
    httpGet: { path: /readyz, port: metrics }
    periodSeconds: 5
    {{- end }}
  livenessProbe:
    httpGet: { path: /metrics, port: metrics }
    periodSeconds: 15
    failureThreshold: 4
  {{- /*
  The worker's retire, on by default: roles.worker.retireSeconds > 0. The preStop sends PID 1 SIGUSR2 —
  the framework's retire: stop claiming, finish every held job however long it takes, abort
  nothing, then drain and exit 0 — and waits until PID 1 is gone, so the SIGTERM that follows finds
  nothing left to cut off. It re-sends the signal every 5 s while it waits: PID 1 has no default
  signal action, so a preStop that lands before the boot arms the listener is dropped by the kernel
  (the pod then idles to its grace); a repeat joins the retire in flight. bun -e, never kill/sleep: bun is the image's ENTRYPOINT (exec form, so it
  IS PID 1). The kubelet counts the preStop against the grace period, so retireSeconds is added to
  it and is the longest a retire may take.
  */}}
  {{- if and (eq $role "worker") (gt (int $cfg.retireSeconds) 0) }}
  lifecycle:
    preStop:
      exec:
        command:
          - bun
          - -e
          - "process.kill(1, 'SIGUSR2'); const end = Date.now() + {{ int $cfg.retireSeconds }} * 1000; for (let n = 1; Date.now() < end; n++) { try { process.kill(1, n % 5 === 0 ? 'SIGUSR2' : 0); } catch { break; } await Bun.sleep(1000); }"
  {{- end }}
  {{- end }}
  resources: {{- toYaml $cfg.resources | nindent 4 }}
  volumeMounts:
    - name: tmp
      mountPath: /tmp
{{- end -}}

{{/*
A role's terminationGracePeriodSeconds, in the order the kubelet's budget is spent: the preStop
sleep (web and sync, 1.30+), the worker's retire (roles.worker.retireSeconds), the
readiness grace (web and sync — every other role drains with none), the drain budget (app.config.ts drain.deadlineMs, every role;
the worker's is drain.workerDeadlineSeconds instead when > 0, from drain.workerDeadlineMs) and the teardown margin.
Defaults: 45s web/sync (40s below 1.30), 35s the rest. x deploy --method helm sets
drain.deadlineSeconds, drain.workerDeadlineSeconds and drain.readinessGraceSeconds from app.config.ts.
*/}}
{{- define "docs-site.terminationGracePeriodSeconds" -}}
{{- $drain := .root.Values.drain -}}
{{- $total := add (int $drain.deadlineSeconds) (int $drain.teardownMarginSeconds) -}}
{{- if eq .role "worker" -}}
{{- if gt (int $drain.workerDeadlineSeconds) 0 -}}
{{- $total = add (int $drain.workerDeadlineSeconds) (int $drain.teardownMarginSeconds) -}}
{{- end -}}
{{- $total = add $total (int .cfg.retireSeconds) -}}
{{- end -}}
{{- if .cfg.port -}}
{{- $total = add $total (int $drain.readinessGraceSeconds) -}}
{{- if semverCompare ">=1.30-0" .root.Capabilities.KubeVersion.Version -}}
{{- $total = add $total (int $drain.preStopSleepSeconds) -}}
{{- end -}}
{{- end -}}
{{- $total -}}
{{- end -}}
