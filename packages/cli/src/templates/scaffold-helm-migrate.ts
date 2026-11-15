// The scaffolded chart's release phase: the one migrate Job, ordered before every role under helm,
// under Argo CD, and as an ordinary object under an applier that ignores both. Split from
// scaffold-helm-templates.ts; `docker/helm/templates/migrate-job.yaml` is the framework's copy.

import type { GeneratedFile, NameSet } from './naming';

export const MIGRATE_JOB_PATH = 'docker/helm/templates/migrate-job.yaml';

const migrateJob = (app: NameSet): string => `{{/*
The release phase: ROLE=migrate applies every pending migration under an advisory lock and exits,
before any serving role starts. Same image, same entry point — there is no second migration engine
and no toolchain in the container. ONE Job, ordered by whichever applier renders it:

  helm (and Flux's helm-controller)  a pre-install / pre-upgrade / pre-rollback hook: no role is
                                     touched until it has succeeded. On a rollback it is the OLDER
                                     build's migrate, which refuses a ledger a newer build left
                                     destructive rows in (X_MIGRATION_ROLLBACK_DESTRUCTIVE) before
                                     any role is rolled back onto it
  Argo CD                            a Sync hook in wave -1. Its own annotation wins over the Helm
                                     one Argo would otherwise map to PreSync — the phase that runs
                                     before EVERY wave, so a database the same sync creates was
                                     waited on forever. Put that database and the Secret the Job
                                     reads in wave -2 or lower; every role sits in wave 0
  an applier that ignores both       an ordinary object, applied beside the roles. Its name hashes
  (kubectl apply, a rendered tree)   the image, the migrate block and the chart version, so a new
                                     image is a new Job rather than an immutable-field refusal of
                                     the whole apply (an env change alone is still refused: change
                                     migrate.*, or delete the Job); the roles wait for the stamp it
                                     leaves, unready, and maxUnavailable: 0 keeps the old pods
                                     serving meanwhile

No init container on any role: a per-pod migrate is a second mechanism, run once per pod, and it
only ever ordered the Deployment that carried it. Deleted once it succeeds (hook-succeeded, which
Argo CD honours too); a failed one stays for kubectl logs until migrate.ttlSecondsAfterFinished (a day)
collects it. A retry of the same image replaces it sooner; a new image's Job has another name and
never does.
*/}}
{{- if .Values.migrate.enabled }}
apiVersion: batch/v1
kind: Job
metadata:
  {{- /*
  The name hashes what should make a new Job — the image, the migrate block and the chart version —
  and NEVER the rendered pod: an inline env value would be guessable from 32 bits of its hash.
  46 + "-migrate-" + 8 = 63, the ceiling of the job-name label every pod of it carries.
  */}}
  {{- $inputs := printf "%s|%s|%s" (include "${app.kebab}.image" .) (toYaml .Values.migrate) .Chart.Version }}
  name: {{ printf "%s-migrate-%s" (include "${app.kebab}.fullname" . | trunc 46 | trimSuffix "-") ($inputs | sha256sum | trunc 8) }}
  labels:
    {{- include "${app.kebab}.labels" . | nindent 4 }}
    app.kubernetes.io/component: migrate
  annotations:
    helm.sh/hook: pre-install,pre-upgrade,pre-rollback
    helm.sh/hook-weight: "-5"
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
    argocd.argoproj.io/hook: Sync
    argocd.argoproj.io/sync-wave: "-1"
spec:
  backoffLimit: {{ .Values.migrate.backoffLimit }}
  {{- /*
  Collected a day after it finishes unless migrate.ttlSecondsAfterFinished says otherwise: the one
  cleanup an applier that ignores hooks gets. Such an applier that reconciles re-creates a collected
  Job on its next pass, which re-runs a migrate with nothing to apply.
  */}}
  ttlSecondsAfterFinished: {{ ternary .Values.migrate.ttlSecondsAfterFinished 86400 (hasKey .Values.migrate "ttlSecondsAfterFinished") | int }}
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
        {{- include "${app.kebab}.tmpVolume" . | nindent 8 }}
{{- end }}
`;

/** The chart's migrate Job, as `x new` writes it. */
export function helmMigrateFile(app: NameSet): GeneratedFile {
  return { path: MIGRATE_JOB_PATH, contents: migrateJob(app) };
}
