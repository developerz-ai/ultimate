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

{{/* The container spec for a role. `role` is the only thing that varies. */}}
{{- define "ultimate.container" -}}
{{- $role := .role -}}
{{- $cfg := .cfg -}}
{{- $root := .root -}}
- name: {{ $role }}
  image: {{ include "ultimate.image" $root }}
  imagePullPolicy: {{ $root.Values.image.pullPolicy }}
  securityContext: {{- toYaml $root.Values.securityContext | nindent 4 }}
  env:
    - name: ROLE
      value: {{ $role | quote }}
    {{- if $cfg.port }}
    - name: PORT
      value: {{ $cfg.port | quote }}
    {{- end }}
    {{- range $key, $value := $root.Values.env }}
    - name: {{ $key }}
      value: {{ $value | quote }}
    {{- end }}
  envFrom:
    - secretRef:
        name: {{ $root.Values.existingSecret }}
  {{- if $cfg.port }}
  ports:
    - name: http
      containerPort: {{ $cfg.port }}
  readinessProbe:
    httpGet: { path: /readyz, port: http }
    periodSeconds: 5
  livenessProbe:
    httpGet: { path: /healthz, port: http }
    periodSeconds: 15
  {{- end }}
  resources: {{- toYaml $cfg.resources | nindent 4 }}
  volumeMounts:
    - name: tmp
      mountPath: /tmp
{{- end -}}
