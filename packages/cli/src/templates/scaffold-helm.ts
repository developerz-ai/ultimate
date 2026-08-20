// The chart `x deploy --method helm` runs, written by `x new`. The other method's topology file
// (`docker/docker-compose.prod.yml`) has always been scaffolded; a deploy method whose artifact
// only exists in a repository the app never had is a command that cannot run.
//
// This file is the chart's INPUTS — Chart.yaml and values.yaml. The objects they render are
// scaffold-helm-templates.ts.

import type { GeneratedFile, NameSet } from './naming';
import { helmTemplateFiles } from './scaffold-helm-templates';

/**
 * `appVersion` is the default image tag (`image.tag: ""` below), so it must name a tag that can
 * exist. `x deploy --image <ref>` overrides both keys, which is the path that actually ships.
 */
const chart = (app: NameSet): string => `apiVersion: v2
name: ${app.kebab}
description: One image, N roles. Per-role deployments for ${app.kebab}.
type: application
version: 0.1.0
appVersion: "0.1.0"
kubeVersion: ">=1.27.0-0"
`;

const values = (
  app: NameSet,
): string => `# One image for every role; ROLE is the only difference between the workloads.
image:
  repository: ${app.kebab}
  tag: ""            # defaults to .Chart.AppVersion; x deploy --image sets this and repository
  pullPolicy: IfNotPresent

# Non-secret configuration. Secrets come from an existing Secret, never from this file:
#   kubectl create secret generic ${app.kebab}-secrets --from-literal=DATABASE_URL=...
env:
  NODE_ENV: production

existingSecret: ${app.kebab}-secrets   # DATABASE_URL, NATS_URL, S3_*, AUTH_SECRET

# The scrape listener every serving role opens, on its own port and never the app's: the ingress
# routes / to web, so /metrics beside /healthz on 3000 is /metrics on the internet. This is
# METRICS_PORT in the container; move one and the other follows.
metricsPort: 9090

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 65532
  seccompProfile: { type: RuntimeDefault }

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: [ALL] }

# The release phase. Runs to completion before any serving role starts.
migrate:
  enabled: true
  backoffLimit: 1
  resources:
    requests: { cpu: 100m, memory: 128Mi }
    limits: { memory: 512Mi }

# One entry per role this chart may run. \`port\` is the port the role LISTENS on, not the value of
# PORT: they differ for sync, which binds PORT + 1, and the chart derives the env from this number
# so there is only ever one to move.
#
# Autoscaling is off until you wire a metrics adapter — each \`metric\` below is a Pods metric the
# role exports, and an HPA with no adapter behind it reads <unknown> and holds at minReplicas.
roles:
  web:
    enabled: true
    replicas: 2
    port: 3000
    resources:
      requests: { cpu: 200m, memory: 256Mi }
      limits: { memory: 512Mi }
    autoscaling:
      enabled: false
      minReplicas: 2
      maxReplicas: 30
      metric: rps               # requests per second
      targetAverageValue: "50"

  sync:
    enabled: true
    replicas: 2
    port: 3001
    resources:
      requests: { cpu: 200m, memory: 512Mi }
      limits: { memory: 1Gi }
    autoscaling:
      enabled: false
      minReplicas: 2
      maxReplicas: 40
      metric: connections       # concurrent websockets per pod
      targetAverageValue: "2000"

  worker:
    enabled: true
    replicas: 2
    resources:
      requests: { cpu: 200m, memory: 256Mi }
      limits: { memory: 1Gi }
    autoscaling:
      enabled: false
      minReplicas: 1
      maxReplicas: 50
      metric: queue_depth       # jobs waiting, exported by the worker role
      targetAverageValue: "100"

  scheduler:
    enabled: true
    # Fixed 1, and a second replica is safe but pointless: leadership is an expiring row in
    # x_scheduler_leader, so the extra pod stands by.
    replicas: 1
    resources:
      requests: { cpu: 50m, memory: 128Mi }
      limits: { memory: 256Mi }

  replicator:
    enabled: false              # exactly one per database; enable when the change feed is in use
    replicas: 1
    resources:
      requests: { cpu: 100m, memory: 256Mi }
      limits: { memory: 512Mi }

ingress:
  enabled: false
  className: nginx
  host: ${app.kebab}.example.com
  tls: true
`;

/**
 * The chart for a new app: five kinds of object, all of them core Kubernetes. A ServiceMonitor and
 * a PodDisruptionBudget are deliberately absent — the first needs a CRD `helm install` fails on
 * where no Prometheus operator is installed, and both are cluster policy rather than app topology.
 */
export function helmFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'docker/helm/Chart.yaml', contents: chart(app) },
    { path: 'docker/helm/values.yaml', contents: values(app) },
    ...helmTemplateFiles(app),
  ];
}
