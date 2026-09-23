# 13 — deploy: chart, compose, `x deploy`, milestone 11

> Part of [`overview.md`](overview.md). Depends on: 01 f (readiness grace), 12 e/f. Paths: `docker/`, `packages/cli/src/templates/scaffold-{container,helm}*.ts`, `packages/cli/src/cmd-deploy.ts`, `.github/workflows/ci.yml`.

Rule: a first `helm install` succeeds, a rolling restart drops no request, and CI proves both
rather than rendering templates.

## Files to change

| # | Defect | File:line | Change |
|---|---|---|---|
| a | **the first install hangs.** The migrate Job is a `pre-install` hook using the chart's ServiceAccount, which Helm creates only after pre-install hooks finish | `docker/helm/templates/migrate-job.yaml:14-16,26`, `service.yaml:40-56` | Make the ServiceAccount a hook too (`pre-install,pre-upgrade`, weight `-10`, `before-hook-creation`) |
| b | the listener closes on SIGTERM | both charts' Deployments | `terminationGracePeriodSeconds` ≥ readiness grace (01 f) + drain budget. Also add `lifecycle.preStop.sleep.seconds: 5` where the cluster floor allows it (1.30+; the chart's floor is 1.27, so the framework-side grace is what the chart relies on) |
| c | the worker HPA runs away: each pod publishes the **global** `queue_depth`, and a `Pods`/`AverageValue` metric treats it as per-pod | `docker/helm/templates/hpa.yaml`, `values.yaml:110-121`, `templates/scaffold-helm.ts:97-108`, `packages/jobs/src/worker.ts:98-110` | Use an `External` metric with `AverageValue` |
| d | there is no `startupProbe`, and boot does island builds before any listener opens. `_helpers.tpl:110-114` claims the metrics listener opens "FIRST" | `docker/helm/templates/_helpers.tpl:110-114`, both charts | `startupProbe` (failureThreshold 30 × 5 s). Correct the comment. 12 e removes most of the boot cost |
| e | `x deploy --method helm` has no `--wait`/`--timeout`/`--namespace` and a hard-coded release `app`, so it exits 0 on accept. A long migration fails the upgrade while its Job keeps running | `packages/cli/src/cmd-deploy.ts:126-134` | `--wait --timeout <flag, default 15m> --namespace <flag>`, release name from `app.config.ts` name. `--json` reports rollout status |
| f | Compose is unhardened and never rotates logs | `docker/docker-compose.prod.yml:31-40`, `templates/scaffold-container.ts:142-148` | One `x-common` block: `read_only: true` with a tmpfs for `/tmp` and `.x`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `mem_limit`, and `logging: {driver: json-file, options: {max-size: 10m, max-file: '3'}}` |
| g | the scaffold Dockerfile copies all sources before `bun install`, so every edit reinstalls | `templates/scaffold-container.ts:27-31` | The manifests-only install stage from `docker/Dockerfile:43-57` |
| h | the demo image does `COPY . .` plus a full install with devDependencies of the whole monorepo | `dummy/social-media-clone/Dockerfile.monorepo:27-36` | The same staged install, `--production` in the runtime stage |
| i | `home: https://ultimate.dev` (404 everywhere); the `dead-docs-host` rule misses YAML | `docker/helm/Chart.yaml:16` | Point it at the GitHub repo. Slice 14 widens `dead-docs-host` to `*.yaml`/`*.yml` |
| j | **milestone 11 proof**: nothing in CI builds an app image, installs the chart, or measures a rollout | `.github/workflows/ci.yml` (new job `deploy-proof`) | kind or k3d on `ubuntu-latest`: build the scaffold image, `helm install`, `helm upgrade` with a changed `BUILD_ID`, while a load loop sends mixed GET and POST. Assert 0 non-2xx. Budget ≤ 8 min, main-only (a `paths` filter on `docker/**`, `packages/cli/src/templates/scaffold-*`, `packages/core/src/lifecycle.ts`, `packages/http/src/server.ts`) |
| k | Compose cannot restart invisibly (one published-port replica, `docs/ops/README.md:29`) | `docs/idea/14-roadmap.md` milestone 11 | Narrow the milestone's "invisible rolling restart" to Kubernetes, and record Compose as the single-node rung (`docs/idea/17-scale-ladder.md`). Never ship a proxy in the framework (axiom 7) |

## Steps
1. a and b first: without them j cannot pass.
2. c, d, e.
3. f, g, h, i.
4. j last, and k in the same PR as the first green j.

## Tests
- CI `container` job (existing `helm template` assertions) plus new assertions: the SA carries a hook annotation, and the HPA metric type is `External`.
- `bun test packages/cli/src/templates/scaffold-helm*.test.ts packages/cli/src/templates/scaffold-container*.test.ts packages/cli/src/cmd-deploy.test.ts`
- The new `deploy-proof` job.

## Done when
- The `deploy-proof` job is green on main with 0 failed requests during `helm upgrade`.
- `docs/idea/14-roadmap.md` milestone 11 is marked done for Kubernetes, with the job named as evidence.
