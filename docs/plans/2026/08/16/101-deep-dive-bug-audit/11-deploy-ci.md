# 11 — Deploy artifacts, CI and release

> Part of [`overview.md`](overview.md). Depends on: none. Tier: `docker/`, `.github/`, `cli` (5).

Milestone 11's open item is "the demo app on Compose **and** K8s from one image with an invisible
rolling restart". This slice is why it is not close: the framework's own image **does not build**,
and the image that does build dispatches no roles.

`scripts/roadmap.ts:67-75` marks milestone 11 by checking that `docker/Dockerfile`,
`docker/docker-compose.prod.yml` and `docker/helm` **exist**. Both files below exist and neither
works, so the `roadmap` gate step is green over the exact claim it asserts. Fix that check last, once
the artifacts are real.

## Critical

- `docker/Dockerfile:12-15` — **the framework's own image cannot build.** The deps stage copies
  `package.json`, `bun.lock`, `packages/` and `examples/` — never `dummy/` — but `bun.lock` declares
  7 `dummy/social-media-clone*` workspace members (`bun.lock:16,47-78`) because root
  `package.json:9-11` globs `dummy/*`, `dummy/*/apps/*`, `dummy/*/packages/*`. Bun resolves
  workspaces from manifests on disk, sees members it cannot resolve, and wants to rewrite a frozen
  lockfile. **Proven**: mirroring the exact deps-stage file set into a temp dir →
  `error: lockfile had changes, but lockfile is frozen`, exit 1; adding
  `git ls-files 'dummy/**/package.json'` → `68 packages installed`, exit 0.
  `dummy/social-media-clone/docker/Dockerfile.monorepo:22-27` documents this failure verbatim
  ("Copying only what this app imports looked tidier and failed with 'lockfile had changes, but
  lockfile is frozen'") — the framework's own Dockerfile is the case that comment describes and never
  got the fix. Nothing in CI builds this file, which is why it went unnoticed;
  `docker/docker-compose.dev.yml:9-11` builds it, so the documented local-stack command fails too.

  **This falsifies `CLAUDE.md:29`**: "The image build now ends in `/out/app --version`, so a binary
  that cannot answer fails the build rather than the first command an operator runs" — the build dies
  at line 15 and never reaches line 39. The `--define` fix itself is real (proven: the compiled
  binary answers `✓ 1.2.0`); the claim about the image is not.

  Fix: `COPY dummy ./dummy` beside the `packages`/`examples` copies, or replace all three with
  `COPY . .` and lean on `Dockerfile.dockerignore`, as `Dockerfile.monorepo` does.

- `.github/workflows/release.yml:75-79` — **`@ultimat3/flags` is in no publish step, so the "29
  packages in lockstep" release publishes 28.** The tier-1 step names `i18n, money, time, cache, seo,
  db, storage` — 7 of the 8 in `scripts/lib/tiers.ts:11`. `packages/flags/package.json` is public, at
  `1.2.0`, and `scripts/release.ts` derives its list from `publishOrder(listWorkspaces(root))` = 29 —
  so the script and the workflow disagree and no test pins one against the other.
  `PUBLISHING.md:51-59` omits it too and `:130` says "all 28", which is where the count drift starts.
  CI cannot catch it: `scripts/scaffold-smoke-overrides.ts` rewrites every `@ultimat3/*` range to a
  `file:` override, so the registry is never consulted. `README.md:20` and `llms.txt:3` already
  acknowledge flags never reached npm and blame the manual bootstrap — but the *workflow* omission
  means it stays behind after the bootstrap too, while `CLAUDE.md:16` claims all 29 are on npm in
  lockstep. Fix: add `-w @ultimat3/flags` to the tier-1 step and to `PUBLISHING.md:52-53`; add a test
  asserting the workflow's `-w` set equals `publishOrder(listWorkspaces(root))`.

- `.github/workflows/release.yml:70` — **the release workflow never runs
  `scripts/release.ts --check <version>`**, the guard written specifically to stop the failure that
  is live right now. `scripts/release.ts:137-140` states "The release workflow runs this before
  `npm publish`" and describes the exact scenario: "29 packages all at 1.2.0 pass while the tag says
  v1.10.1 — and the publish then dies `EPUBLISHCONFLICT` on all 29". `grep` over `release.yml` finds
  no `release.ts`, no `--check`. **Proven**: `git describe --tags` → `v1.10.1-24-gf2f41f5` while
  every `package.json` reads `1.2.0`. A GitHub Release published today would run `verify`, pass, then
  `EPUBLISHCONFLICT` on every package. Fix: add
  `bun run scripts/release.ts --check "${GITHUB_REF_NAME#v}" --json` before the first publish, and
  reconcile the tag series with the package versions.

- `.github/workflows/release.yml:18` — the publish job is reachable from `workflow_dispatch` on **any
  ref**, holds `id-token: write` (`:28`), and runs no version guard. Any account with write access —
  a compromised contributor, a stolen PAT, a merged-then-reverted branch — can push a branch and run
  the workflow on it, publishing an arbitrary tree as an arbitrary version across all packages
  **with genuine provenance attached**, irreversibly; `PUBLISHING.md:96` documents this dispatch as a
  normal path, so it will not read as anomalous. Fix: the `--check` step above, plus
  `environment: release` on the job — the repo already demonstrates environment-gated deploys at
  `.github/workflows/deploy-social-demo.yml:61-63`, and the npm trusted-publisher config
  (`PUBLISHING.md:72`) can then name it instead of leaving Environment blank.

## High

- `docker/Dockerfile:44-54` — **the framework's own image ships a CLI, not a role-dispatching
  server**, so `ROLE` is read by nothing and the default `CMD` fails on start. The build compiles
  `packages/cli/src/bin.ts`; `ROLE` is read only by `serve.ts`'s `runRole`
  (`packages/cli/src/serve.ts:57`), a library an app's `apps/web/server.ts` calls — there is no
  `x serve` command. `ENV ROLE=web` + `CMD ["dev","--once"]` runs `x dev --once` at `/`, a
  *smoke-test* flag ("boot, report, exit"). **Proven** on the binary built with the Dockerfile's
  exact command:

  ```
  /out/app --version      → ✓ 1.2.0         exit 0    (the --define fix does hold)
  /out/app doctor --json  → X_NOT_IN_APP    exit 1
  /out/app dev --once     → X_NOT_IN_APP    exit 1
  ```

  So `docker/docker-compose.prod.yml:49`'s `web` healthcheck (`['CMD','/app/x','doctor','--json']`)
  can never pass, and `backfill` (`depends_on: {web: {condition: service_healthy}}`, `:39`) never
  runs. Every service in that file — `migrate`, `web`, `sync`, `worker`, `scheduler` — runs
  `x dev --once` and exits 1, `ROLE` notwithstanding; the `migrate` service applies **no migrations**.
  The file's header ("One image, every role. ROLE selects behaviour at start") and
  `docker run -e ROLE=worker ultimate-app:dev` are both false as written. Even inside a real app
  image `x doctor` reports `X_PORT_IN_USE` for the port the app serves on — it goes red precisely
  when the app works. The scaffolded Dockerfile gets this right
  (`packages/cli/src/templates/scaffold-container.ts:56-57` polls `/readyz`). Fix: build the
  framework image from an app entry point, as `Dockerfile.monorepo` does — or state in the header
  that this image is the CLI only and delete the role/compose topology built on top of it.

- **One role-blind `HEALTHCHECK` in all four images marks `sync`, `worker` and `scheduler`
  permanently unhealthy** — `examples/dummy/docker/Dockerfile:44`,
  `dummy/social-media-clone/docker/Dockerfile:44`,
  `dummy/social-media-clone/docker/Dockerfile.monorepo:53`,
  `packages/cli/src/templates/scaffold-container.ts:56`. Every image runs
  `fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz')`.

  | Role | Reality |
  |---|---|
  | `sync` | binds `PORT + 1` (`packages/cli/src/dev-sync.ts:95`) and opens nothing on `PORT`; every compose file sets `ROLE=sync` with `PORT` unset (=3000) and publishes `3001:3001` |
  | `worker` / `scheduler` / `replicator` | open no HTTP socket at all — `/healthz` and `/readyz` come from `createServer` (`packages/http/src/server.ts:164-165`), which only `web` and `sync` construct; their only listener is `startMetricsEndpoint`, which 404s every path but `/metrics` and says so at `packages/cli/src/metrics-endpoint.ts:52-54` |

  `dummy/social-media-clone`'s live demo image — published on every push to main — reports 3 of 5
  containers unhealthy forever, and any `depends_on: {condition: service_healthy}` hangs. Note this
  is the *same* defect as the helm readiness probe that was already fixed at `_helpers.tpl:42-45`,
  still live in the image. Same false claim in prose at `docker/README.md:20` and
  `docker/Dockerfile:52` ("All roles expose /healthz and /readyz"). Fix: make the healthcheck
  role-aware, or drop the image-level `HEALTHCHECK` and declare per-service healthchecks in compose.

- `examples/dummy/docker/Dockerfile:13` and `dummy/social-media-clone/docker/Dockerfile:13` —
  `COPY package.json bun.lock ./` with the app root as build context, and **neither app root has a
  `bun.lock`**. `x build --target docker` runs `docker build -f <appRoot>/docker/Dockerfile -t <tag>
  <appRoot>` (`packages/cli/src/cmd-build.ts:52`); both apps are workspace members and the only
  lockfile is at the repo root, so BuildKit fails `"/bun.lock": not found`.
  `dummy/social-media-clone` has `Dockerfile.monorepo` as the working alternative — but the
  `docker/Dockerfile` beside it is dead, and `examples/dummy` has no alternative at all. Both headers
  advertise `x build --target docker` as the invocation. Fix: delete both (they are the scaffold's
  file, checked into a monorepo where it cannot apply), or point them at the repo root.

- `.github/workflows/ci.yml:159` — `scaffold-smoke`'s `x verify (demoapp)` step carries
  `continue-on-error: true`, so **the job that answers "can a stranger scaffold an app that gates"
  cannot fail on the gate.** The comment justifies it with one pinned TS18048 gap in
  `x new --example`'s `entity.ts`, but the waiver covers the whole 17-step table: a red `unit`, a
  missing package-shape file, an unmounted route or a broken `boundaries` step in a scaffolded app is
  invisible and the job still reports success. `ci.yml`'s header and `CLAUDE.md`'s CI paragraph both
  present this as one of three blocking jobs. Fix: drop `continue-on-error`, run `x verify --json`,
  parse the step table and fail unless the only failure is `typecheck` — the ratchet shape
  `reference-app-gate.ts` already implements — or scaffold with `--no-example` for the blocking run.

- `packages/cli/src/templates/scaffold-container.ts:130-131` — the scaffolded `backfill` service
  passes CLI argv to an entry point that ignores it, so `x deploy`'s backfill step silently boots a
  web server and blocks forever. `command: ['db','backfill','--all','--write','--json']` against
  `ENTRYPOINT ["bun","apps/web/server.ts"]` (`:66`), and `server.ts` is
  `await runRole({ root, env: Bun.env })` — argv is never read and `ROLE` defaults to `'web'`.
  `x deploy --method compose` runs `docker compose run --rm backfill`
  (`packages/cli/src/cmd-deploy.ts:74-76`) and awaits it: a web server starts, `restart: 'no'`, no
  sweep runs, nothing errors. Verified identically in both tracked apps' checked-in
  `apps/web/server.ts`. Fix: give `server.ts` an argv branch, or make the compose service
  `entrypoint: ['bun','node_modules/@ultimat3/cli/src/bin.ts']` with the existing `command`.

- `packages/cli/src/templates/scaffold-container.ts:81-82` — **the `.dockerignore` `x new` writes
  bakes production secrets into the image.** It excludes `.env` and `.env.*.local` but not
  `.env.production`, which the compose file written 20 lines later names as *the* production secrets
  file (`:103`, `env_file: [../.env.production]`). Docker's glob is per-segment, so `.env.*.local`
  matches only `.env.production.local`; `.env.production`, `.env.local`, `.env.development` and any
  `apps/*/.env.production` all enter the build context, and the generated Dockerfile's `COPY . .`
  (`:39`) is in the **final runtime stage**. Anyone with pull access to the registry — or any later
  `docker save` / layer scrape / CI cache export — reads every production credential in plaintext, no
  need to run the container. The repo already gets this right, with the comment that states the rule
  — `dummy/social-media-clone/docker/Dockerfile.monorepo.dockerignore:29-32`:

  ```
  # Never bake an environment into an image: one artifact deploys everywhere and the values arrive
  # from the platform.
  .env
  .env.*
  **/.env
  **/.env.*
  ```

  Fix: replace `:81-82` with those four lines. **Same defect, byte-identical, in both tracked apps**:
  `examples/dummy/docker/Dockerfile.dockerignore:7-8` and
  `dummy/social-media-clone/docker/Dockerfile.dockerignore:7-8`, both with `COPY . .` into the
  runtime stage at `:27`.

- `packages/cli/src/templates/scaffold-repo.ts:189-190` — the scaffolded `.gitignore` ignores `.env`
  and `.env.*.local`, so **the `.env.production` the scaffolded compose file requires is tracked by
  git** — production secrets in version-control history after a routine `git add -A`, unrecoverable
  by deletion. **The framework's own `.gitignore:6-10` has the same hole**: it lists `.env`,
  `.env.local`, `.env.*.local`, `.env.test.local`, `.env.dev` — and not `.env.production`, which is
  exactly the filename `docker/docker-compose.prod.yml:20` instructs an operator to create at the
  repo root. Fix: `.env.*` after `.env`, with `!.env.example` (the scaffold writes a tracked example,
  and `scaffold-repo.ts:228` a tracked `.env.development`).

## Medium

| Site | Defect |
|---|---|
| `examples/dummy/docker/docker-compose.prod.yml`, `dummy/social-media-clone/docker/docker-compose.prod.yml` | neither declares a `backfill` service, but `DEPLOY_ROLES` (`cmd-deploy.ts:34`) always runs one → "no such service". `cmd-deploy.ts:31-32`'s comment saying both "still owe that service" is stale — the framework's and the scaffold's have it now; the two apps' do not |
| `packages/cli/src/cmd-deploy.ts:58-59` | `--method helm` passes `--set image=<ref>`, replacing the `image` **map** with a string; `_helpers.tpl:12`'s `printf "%s:%s" .Values.image.repository` then fails to render. Masked for the tracked apps by the `docker/helm`-absent guard at `:99`, so it bites whoever copies the chart. Fix: `--set image.repository=… --set image.tag=…` |
| `docker/helm/Chart.yaml:5-6` | `version`/`appVersion` are `0.0.1` while the framework is 1.2.0, and `values.yaml:4` defaults `image.tag` to `.Chart.AppVersion` — a bare `helm install` pulls a tag that has never existed. `scripts/release.ts` rewrites only `package.json`s and the changelog; add `Chart.yaml` to its set |
| `docker/helm/templates/deployments.yaml:37` | no `automountServiceAccountToken: false` on any pod spec, while `service.yaml:41-45` creates a ServiceAccount no workload needs (the chart declares no Role or RoleBinding). Any file-read or RCE in a pod yields a valid API token. The one gap in an otherwise complete set — `values.yaml:32-40` correctly sets `runAsNonRoot`, `runAsUser: 65532`, `seccompProfile`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem`, `capabilities.drop: [ALL]`. One line, also in `migrate-job.yaml:26` |
| `.github/actions/setup/action.yml:9` | `oven-sh/setup-bun@v2` is a third-party action on a **mutable tag**, used again inline at `release.yml:58` inside the job holding `id-token: write`. Whoever moves that tag gets arbitrary code in the release runner with the OIDC identity npm trusts. Pin to commit SHAs; `.github/dependabot.yml:34-46` already watches `github-actions` |
| `docker/Dockerfile.dockerignore` | no `.env` entry at all (13 lines, none env-related) while `docker/Dockerfile:21` does `COPY . .` into the `build` stage. Bounded — the distroless final stage copies only `/out/app` — so the exposure is intermediate layers and the GHA build cache (`--cache-to type=gha,mode=max`). Same four-line fix |
| `docker/Dockerfile:9`, `docker/README.md:80` | "deps: cached on the lockfile alone" is false — the stage copies full `packages/` and `examples/` source trees, so every source edit re-runs `bun install`. The two app Dockerfiles have the same shape but at least say why |
| CI coverage | **nothing renders or lints the helm chart, and nothing builds `docker/Dockerfile`.** `deploy-social-demo.yml` is the only workflow that builds an image, and it builds `Dockerfile.monorepo`. `deployments.yaml:19-20`'s comment ("which is why `helm lint` never passed") implies a lint no job runs. Add `helm lint && helm template` and `docker build -f docker/Dockerfile .` to `ci.yml` |

## Low

- `docker/docker-compose.dev.yml:35,48,56` — the dev stack publishes Postgres, NATS client +
  monitoring and MinIO API + console on `0.0.0.0` with hardcoded credentials (`:32-34`, `:54-55`).
  Anyone on the same L2 network as a developer's laptop connects to `<laptop-ip>:5432` with
  credentials printed in the file; NATS `:8222` exposes topology unauthenticated. The file's own
  header says `x dev` needs none of this. Fix: prefix each mapping with `127.0.0.1:`.
- `docker/helm/values.yaml:5` — `pullPolicy: IfNotPresent` with a mutable tag rather than a digest,
  and `deploy-social-demo.yml:140` sets `provenance: false` / `sbom: false`, so there is no
  attestation to verify against either.
- `.github/actions/setup:9` — `bun-version: latest` while `package.json:engines` pins `>=1.3.0` and
  every Dockerfile pins `oven/bun:1.3-alpine`: CI is not reproducible and tests a runtime the images
  never ship.
- `.github/workflows/deploy-social-demo.yml:71` uses `actions/checkout@v6` while the other three
  workflows use `@v7`.
- `docker/Dockerfile:50` — `EXPOSE 3000` only, on an image whose `sync` role listens on 3001.
- `docker/helm/templates/deployments.yaml:40` — `terminationGracePeriodSeconds: 45` vs every compose
  file's `stop_grace_period: 30s`: two drain budgets for one drain. Reconcile with the deadline work
  in [`06-concurrency-lifecycle.md`](06-concurrency-lifecycle.md).
- The chart declares no `PodDisruptionBudget` and no anti-affinity, while `docs/ops/01-kubernetes.md:83`
  and milestone 11's "done when" both rest on "a rolling restart is invisible to connected clients".

## Verified sound — do not "fix"

Cache poisoning from a fork PR (Actions scopes cache writes by ref); script injection via event
payloads (no `pull_request_target`; no `run:` interpolates `github.event.*`, `head_ref`, PR title or
body); npm lifecycle scripts (zero `postinstall`/`preinstall`/`prepare` across all 29 manifests, no
`trustedDependencies`, so Bun blocks dependency install scripts by default); secrets shipped to npm
(`files` allowlists enforced by `packages/cli/src/workspace-checks.ts:204-246`); committed
credentials (full history sweep — only labeled dev placeholders); `.mcp.json` (every credential is
`${VAR}` interpolation); the framework Dockerfile's *hardening* (distroless `nonroot`, no shell in
the final stage, no secret `ARG`, minor-pinned bases); helm privileged-workload patterns (no
`hostNetwork`, `hostPID`, `privileged`, `hostPath`, `NET_RAW`; no Secret or ConfigMap rendered —
`_helpers.tpl:65-67` routes through `envFrom.secretRef`; `/metrics` cannot reach the internet because
`ingress.yaml:31-36` routes by port name); `x deploy`/`x build` command injection (`Bun.spawn` with
argv arrays, no shell); the helm `sync` readiness probe (**fixed** — `_helpers.tpl:42-45` derives
`PORT = port - 1` for `sync`; the *image* healthcheck is the one still wrong).

## Tests

- `scripts/release.test.ts` — the workflow's `-w` set equals `publishOrder(listWorkspaces(root))`.
  This is the test that would have caught the missing `flags`.
- A CI job that builds `docker/Dockerfile` and runs `helm lint`/`helm template` — the Critical above
  exists only because nothing builds the file.
- `packages/cli/src/templates/scaffold-container.test.ts` — the emitted `.dockerignore` excludes
  `.env.production`; the emitted `.gitignore` likewise.
- A role-matrix test asserting each role's healthcheck targets a port that role actually opens.

## Done when

- `docker build -f docker/Dockerfile .` succeeds in CI and the image dispatches roles (or the file
  documents itself as the CLI only and the compose topology is deleted).
- `helm lint` and `helm template` run in CI.
- A release publishes 29 packages, guarded by `release.ts --check` and an `environment: release`.
- No `.env.production` can enter an image or a git history from any scaffold.
- `scaffold-smoke` fails on any gate step but the one pinned `typecheck` gap.
- `scripts/roadmap.ts:67-75` checks that milestone 11's artifacts *work*, not that they exist.
- `bun run verify` green.
