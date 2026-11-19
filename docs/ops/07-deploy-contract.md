# What a deploy guarantees

**`ROLE=migrate` finishes before a role of the new build serves; a role that finds its schema
missing refuses rather than guessing; two adjacent releases may serve together; a rollback is a
redeploy of the older image.** Each row below names the code or the chart line that holds it.
`As of 2026-11`; the chart rows hold from a chart rendered by 31.29.

| Guarantee | Held by | State |
|---|---|---|
| migrate runs to completion before any role of the new build starts | the chart's migrate Job; `x deploy`'s first compose step; every compose service's `depends_on: migrate: service_completed_successfully` | shipped |
| the same order under `helm`, Argo CD, an applier that ignores hooks, and `helm rollback` | the same Job, ordered per applier ([`01-kubernetes.md`](./01-kubernetes.md#migrations)) | shipped, 31.29 chart |
| a serving role never runs DDL | `SchemaMode` `'verify'` on an external database (`packages/cli/src/serve-boot.ts`) | shipped |
| a role over a schema behind its build — framework stamp or app ledger — does not serve | `verifySchema` (`packages/cli/src/framework-schema-verify.ts`) → `X_FRAMEWORK_SCHEMA_UNAPPLIED` / `X_APP_MIGRATIONS_UNAPPLIED` | shipped |
| it waits with bounded backoff, logs one line, then exits (`ULTIMATE_SCHEMA_WAIT_MS`, default 300000, `0` refuses at once) | `waitForSchema` (`packages/cli/src/framework-schema-wait.ts`) | shipped |
| a role over a database a newer major stamped refuses at once, without waiting | `aheadByMajor` (`packages/cli/src/framework-schema-stamp.ts`) | shipped |
| an old pod restarting mid-rollout still serves | the stamp keeps the last 16 framework-schema hashes (`STAMP_KEEP`, `packages/cli/src/framework-schema-stamp.ts`) | shipped |
| app release N-1 runs on release N's schema | `X_MIGRATION_ROLLING_UNSAFE` at `x db gen` | shipped |
| a rollback over a destroyed column refuses before anything serves | `X_MIGRATION_ROLLBACK_DESTRUCTIVE` in the older image's migrate | shipped, from the release after the one that recorded the bit |
| in-flight work drains on SIGTERM; abandoned work exits 70 | `@ultimat3/core`'s drain, `DRAIN_TIMEOUT_EXIT_CODE` | shipped |
| every failure the running fleet can show raises an alert that links its runbook | `docker/helm/templates/alert-rules.yaml`, `runbook_url` per rule; `scripts/chart-alerts.test.ts` refuses a rule whose anchor is not a heading in [`06-runbooks.md`](./06-runbooks.md) | shipped; a failure that fails the deploy command itself raises none — [the failure table](#failures-their-alert-and-their-runbook) |

## Order: migrate before roles

| Platform | What runs migrate | What holds the roles back | A failed migrate |
|---|---|---|---|
| Kubernetes | the chart's one migrate Job, ordered per applier — `helm` hook (`pre-install,pre-upgrade,pre-rollback`), Argo CD `Sync` hook in wave `-1`, or, for an applier that ignores both, an ordinary Job named `<release>-migrate-<8 hex of a hash of the image, the `migrate` values and the chart version>`: [`01-kubernetes.md`](./01-kubernetes.md#migrations) | under `helm`, no Deployment changes until the Job succeeds; `x deploy --method helm` waits `--timeout`, default `15m` (`HELM_DEFAULT_TIMEOUT`, `packages/cli/src/cmd-deploy-helm.ts`). Elsewhere, the wave order, or the roles waiting unready ([next section](#a-role-over-a-schema-that-is-behind)) with `maxUnavailable: 0` keeping the old pods serving | the release or sync fails before any role rolls; the old pods keep serving ([stuck app](./06-runbooks.md#an-app-is-stuck-and-nobody-noticed)). A chart before 31.29 under a hook-blind applier runs no migrate at all |
| Compose (`x deploy --method compose`) | step 1, `docker compose run --rm migrate` (`DEPLOY_ROLES`, `packages/cli/src/cmd-deploy.ts`) | the plan stops at the first failed step; `docker compose up` itself refuses a service before `migrate` completed (`docker/docker-compose.prod.yml`) | `X_DEPLOY_FAILED` naming the step, nothing rolled |
| PaaS | the platform's release phase running the image with `ROLE=migrate` | the platform | the platform keeps the previous release |

What `ROLE=migrate` does, in order (`runMigrations`, `packages/cli/src/serve.ts`):

| Step | Refuses with |
|---|---|
| the framework tables, one transaction under the migration advisory lock, then the build's stamp on `x_jobs` | `X_FRAMEWORK_SCHEMA_FAILED` |
| the app's migrations through the ledger, under the same lock (60 s wait, `MIGRATION_LOCK_WAIT_MS`) | `X_MIGRATE_CONCURRENT`, `X_DB_LOCK_TIMEOUT`, `X_MIGRATION_CONFLICT`, `X_MIGRATION_ROLLBACK_DESTRUCTIVE` |
| the live schema against the ledger just written | `X_DB_DRIFT` — exits non-zero, so the deploy does not roll on |

## A role over a schema that is behind

**A serving role waits, unready, until the schema is its build's, then serves; past a deadline it
exits with the code that names what is missing.** One boot read, two facts
(`verifySchema`, `packages/cli/src/framework-schema-verify.ts`):

| Fact | Behind means |
|---|---|
| the framework stamp `ROLE=migrate` leaves on `x_jobs` | this build's framework schema hash is not in it. The hash covers the framework's DDL, not the version: a release that changed no framework table passes before its migrate runs |
| the app's ledger, `x_migrations` | a migration this build ships is not in it, or the table does not exist |

| The role finds | It |
|---|---|
| both current | serves |
| either behind | waits, reading again on core's backoff curve (1 s, capped at 15 s), logging `ultimate schema waiting` once and `ultimate schema applied` when it ends (`packages/cli/src/framework-schema-wait.ts`). `web` and `sync` answer `/healthz` 200 and `/readyz` 503 on their own port meanwhile (`packages/cli/src/serve-boot-probe.ts`), so the probes see a live pod that is not ready. `framework_schema_applied` reads 0 every round |
| still behind after `ULTIMATE_SCHEMA_WAIT_MS` (default 300000; `0` refuses at once) | exits with `X_FRAMEWORK_SCHEMA_UNAPPLIED` or `X_APP_MIGRATIONS_UNAPPLIED`, `meta.waitedMs` saying how long. A SIGTERM mid-wait ends it too: a drain, not a wait to the deadline |
| a schema read that never answers (database unreachable, pool still dialling) | ends at the remaining deadline, at least 1 s per read: the last verdict's refusal, or `X_DB_UNAVAILABLE` before any read answered |
| a framework stamp whose newest build is a newer major than its own | exits with `X_FRAMEWORK_SCHEMA_UNAPPLIED` at once: no migrate of this build is coming |
| its hash in the stamp, newest applied build another major | serves, logs `ultimate framework major skew` once (`reportSkew`); `framework_schema_major_skew` reads 1 |
| the ledger holding migrations this build does not ship | serves, logs `ultimate app migrations ahead` once: a rollback, or an old pod of a rollout whose migrate already ran |

## Drain

SIGTERM drains every role: readiness grace (web and sync only), stop accepting, finish in-flight
work inside `drain.deadlineMs`, hand off, close. Per-role steps:
[Deployment](../../wiki/Deployment.md#graceful-drain-on-sigterm).

| Role | Chart `terminationGracePeriodSeconds`, defaults | Rollout strategy |
|---|---|---|
| `web`, `sync` | preStop 5 + grace 5 + drain 25 + margin 10 = 45 (40 below Kubernetes 1.30) | `RollingUpdate`, `maxUnavailable: 0`, `maxSurge: 1` |
| `worker` | retire 3600 + drain 25 + margin 10 = 3635 | `RollingUpdate`, as above |
| `scheduler` | drain 25 + margin 10 = 35 | `RollingUpdate`, as above |
| `replicator` | drain 25 + margin 10 = 35 | `Recreate`: one pod holds the slot |

Every Deployment waits `minReadySeconds: 10` before a new pod counts, so one that crashes seconds
after its first ready probe stops the rollout instead of replacing a working pod. Source:
`ultimate.terminationGracePeriodSeconds` in `docker/helm/templates/_helpers.tpl`,
`docker/helm/templates/deployments.yaml`.

| Exit | Means |
|---|---|
| `0` | drained clean |
| `70` | work abandoned at the deadline, logged `X_SHUTDOWN_TIMEOUT` → [runbook](./06-runbooks.md#x_shutdown_timeout-in-the-logs-on-every-deploy) |
| any other non-zero during boot | the boot refused (a coded error on the last log line) |

Compose derives none of this: `stop_grace_period: 40s` in `docker/docker-compose.prod.yml` is
sized for the defaults; raise it with `drain.deadlineMs`. Compose rolls `web` and `sync`
stop-first while they publish a host port ([README](./README.md#the-ladder)).

## The skew window

Which versions may serve at the same time during a rolling deploy:

| Pair | May serve together | Held by |
|---|---|---|
| app code N-1 and N, over N's schema | yes — one release apart | `X_MIGRATION_ROLLING_UNSAFE`: a column drop takes two releases, retired first ([Entities and migrations](../../wiki/Entities-And-Migrations.md)) |
| app code N, over N-1's schema | never | the order above; a role that meets it waits, then `X_APP_MIGRATIONS_UNAPPLIED` |
| framework builds whose schema hashes are both in the stamp | yes — the last 16 distinct hashes | `stampVerdict` |
| framework builds a major apart | yes, with one warning per boot | `reportSkew`. [Stability](../../wiki/Stability.md): at most one major per 90 days, and `x upgrade` moves one major per run |
| a browser tab of build A, a web pod of build B | hashed assets: inside `assets.retain`'s `builds`; an action whose input changed incompatibly: `X_BUILD_SKEW` | [Deployment](../../wiki/Deployment.md#hashed-assets-across-a-deploy--assetsretain) |
| a realtime client and a sync node | only at the same `PROTOCOL_VERSION` (`packages/realtime/src/wire-version.ts`); otherwise `X_PROTOCOL_VERSION` in both directions | each bump is an [Upgrading](../../wiki/Upgrading.md) entry |

## Rollback

**A rollback runs the older build's migrate before any role rolls back.** `x deploy --image
<previous> --json` always does. `helm rollback` does only to a revision rendered by a 31.29+ chart:
Helm runs the TARGET revision's hooks, and only from 31.29 is the Job a `pre-rollback` hook
([`01-kubernetes.md`](./01-kubernetes.md#migrations)). To an older revision, `helm rollback` skips
the ledger check (`X_MIGRATION_ROLLBACK_DESTRUCTIVE`, `X_MIGRATION_CONFLICT`): use `x deploy --image`.

| The schema ahead of the older build | Its migrate | Its serving roles |
|---|---|---|
| additive app migrations | passes, logs `ultimate migrate ledger ahead of build` | serve, each logging `ultimate app migrations ahead` once |
| a migration recorded destructive | `X_MIGRATION_ROLLBACK_DESTRUCTIVE`, nothing serves | — |
| a framework schema change | re-applies its own DDL and moves its hash to the front of the stamp | serve; a major apart logs the skew line |

Then prove it: `x deploy verify --url <origin> --build <id> --json` samples `/readyz` until every
answer names that build. Every case: [a migration failed mid-deploy](./06-runbooks.md#a-migration-failed-mid-deploy).
GitOps: [roll back a bad image](./06-runbooks.md#roll-back-a-bad-image) — pause the image watcher
first.

## Failures, their alert and their runbook

| Failure | What you see | Alert | Runbook |
|---|---|---|---|
| the migrate Job fails | `helm upgrade` fails / `X_DEPLOY_FAILED`; the old version serves | none from the chart: the deploy command fails, a GitOps app goes `OutOfSync` | [a migration failed mid-deploy](./06-runbooks.md#a-migration-failed-mid-deploy) |
| migrate waits on a lock | `X_DB_LOCK_TIMEOUT`, `X_MIGRATE_CONCURRENT` | none | same |
| roles start before migrate | pods not ready, one `ultimate schema waiting` line each; past `ULTIMATE_SCHEMA_WAIT_MS`, `X_FRAMEWORK_SCHEMA_UNAPPLIED` / `X_APP_MIGRATIONS_UNAPPLIED` and a restart | [`UltimateSchemaUnapplied`](./06-runbooks.md#ultimateschemaunapplied), critical, after 10 m | [a role refuses an unapplied schema](./06-runbooks.md#a-role-refuses-an-unapplied-schema) |
| a fleet across a major | `ultimate framework major skew` | [`UltimateVersionSkew`](./06-runbooks.md#ultimateversionskew), after 30 m | same |
| the new build crashes after boot | restarts; the rollout stalls on `minReadySeconds` | [`UltimateTargetDown`](./06-runbooks.md#ultimatetargetdown) | [roll back a bad image](./06-runbooks.md#roll-back-a-bad-image) |
| the new build answers 5xx | — | [`UltimateServerErrors`](./06-runbooks.md#ultimateservererrors), [`UltimateErrorBudgetFastBurn`](./06-runbooks.md#ultimateerrorbudgetfastburn) | [roll back a bad image](./06-runbooks.md#roll-back-a-bad-image) |
| the new build is slow | — | [`UltimateRequestLatency`](./06-runbooks.md#ultimaterequestlatency): release-wide p95 over 1 s | same |
| the new build holds transactions open, or opens more connections | a migration waits on a lock; `53300` on pod start | [`UltimateLongTransaction`](./06-runbooks.md#ultimatelongtransaction), [`UltimateConnectionsNearMax`](./06-runbooks.md#ultimateconnectionsnearmax) | each alert's entry |
| work abandoned on drain | `X_SHUTDOWN_TIMEOUT`, exit `70` | none | [X_SHUTDOWN_TIMEOUT](./06-runbooks.md#x_shutdown_timeout-in-the-logs-on-every-deploy) |
| a rollback over a dropped column | `X_MIGRATION_ROLLBACK_DESTRUCTIVE` | none: the deploy fails | [a migration failed mid-deploy](./06-runbooks.md#a-migration-failed-mid-deploy) |
| the image cannot be pulled | `ImagePullBackOff` | operator rule, not the chart's | [`ImagePullBackOff`](./06-runbooks.md#imagepullbackoff) |
| the replicator stops consuming its slot | WAL grows on the database | [`UltimateReplicationSlotRetention`](./06-runbooks.md#ultimatereplicationslotretention); the volume, [`UltimateVolumeNearFull`](./06-runbooks.md#ultimatevolumenearfull) | [the replication slot is accumulating WAL](./06-runbooks.md#the-replication-slot-is-accumulating-wal) |
| open tabs 404 their assets after a deploy | `X_ASSET_RETAIN_UNDECLARED` at web boot | none | [Deployment](../../wiki/Deployment.md#hashed-assets-across-a-deploy--assetsretain) |

Rehearse the order before it is needed: `x drill roll-before-migrate --json` starts every role on a
scratch database before its migrate, then runs migrate, and holds `roles-wait`,
`serves-after-migrate` and `one-wait-line`. Per role, the evidence is
`.data.drills[].evidence.rollout.roles[]`: `{ role, exit, ready, waitLines, logTail }`; a property
that did not hold is `X_DRILL_FAILED`.

| Role | Played when |
|---|---|
| `web`, `worker`, `scheduler` | always: `TEST_DATABASE_URL` or `TEST_REPLICATION_URL` |
| `sync` | `TEST_NATS_URL` is set |
| `replicator` | `TEST_REPLICATION_URL` names a `wal_level=logical` server, and the app has an entity on a table |

A role left out is listed in `.data.rolesNotPlayed[]` as `{ drill, role, needs }`; the `fault-drills`
CI job is red on any. `x drill --list --json` names every drill. `As of 2026-11`.
