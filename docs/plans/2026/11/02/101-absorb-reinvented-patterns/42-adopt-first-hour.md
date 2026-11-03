# 42 — Adoption: a stranger's first hour, through the first deploy

> Part of [`overview.md`](overview.md). Depends on: [`32-docs-false-claims`](32-docs-false-claims.md) for tutorials 1–4; lands before [`42-adopt-docs-site`](42-adopt-docs-site.md). Tier: 5 (`cli`), docs, CI.

## Why
Timed 2026-11-02, Linux x64, clean `HOME`, empty Bun cache, published 29.4.0, Docker up, no services.

| Step | Time | Result |
|---|---|---|
| `bunx create-ultimate myapp` | 2.1 s | 204 files; "no repository" (F4) |
| `bun run setup` | 30.4 s | 299 tarballs, 192 MB `node_modules` |
| `bun run dev`, first page | about 5 s | `/` 3,955 B, 0 JS. **37 s from nothing** |
| `x g resource note`, `db gen`, `migrate` | 7 s | 38 files |
| `bun run check` | 37 s | 20 steps, exit 0. **Under 2 minutes to a green first feature, no Docker** |
| `x build --target docker` | 27 s | 286 MB (`wiki/Tutorial-05-Deploy-Free.md:32` says 194) |
| `docker run -e ROLE=web` + 3 secrets | 6 s | `/readyz` 200 |
| `x deploy --method compose` | never green | web and worker crash-loop on the scaffold as written (F1) |

The first two minutes are the product's best evidence. Minute three is where a stranger stops.

## Defects
| # | Site | As run | Fix |
|---|---|---|---|
| F1 | `cli/src/templates/scaffold-container-compose.ts:59`, `docker/docker-compose.prod.yml:59` | `read_only: true` with a root-owned `tmpfs: /app/.x`. The scaffold's image is `USER 1000:1000` (`RUNTIME_UID`, `scaffold-helm.ts:18`); the framework's is `nonroot`, 65532 (`docker/Dockerfile:146`, `docker/helm/values.yaml:107`). `X_STORAGE_UNWRITABLE … EACCES mkdir '/app/.x/storage'`. CI misses it: `deploy-proof` uses the chart, `container` only builds and renders | scaffold: `/app/.x:uid=1000,gid=1000`, from `RUNTIME_UID`. `docker/docker-compose.prod.yml`: `uid=65532,gid=65532`. Probe of the scaffold with that one edit: `x deploy` `ok: true`, every role healthy within 30 s, `/` 200 |
| F2 | `cli/src/cmd-deploy.ts:442`, `cli/src/cmd-env-spec.ts:11` | no `.env.production` and no writer. `x deploy` says only `role "migrate" step exited 1`. A hand-written file met `auth_failed` (the compose user is `postgres`, database the app name; no doc says so), then a `NATS_URL` boot refusal | `x env init --production`; a pre-flight in `x deploy` |
| F3 | `wiki/Installation.md:22`, `cli/src/cmd-doctor.ts:204`, `cli/src/mcp-errors.ts:31` | `x` is not on `PATH`. Outside an installed app, `bunx x doctor` **downloaded an unrelated npm package named `x` (0.1.2, 104 packages)**, then `could not determine executable`. If that package gains a bin, the typo runs a stranger's code. `bunx @ultimat3/cli doctor --json` works, and its fix `x new myapp` cannot run there | docs spell `bunx @ultimat3/cli …` outside an app; both fixes become `bunx create-ultimate myapp`. In-app spelling is [`42-adopt-agents`](42-adopt-agents.md) |
| F4 | `cli/src/cmd-new.ts:284`, `cli/src/messages.ts:193` | no git identity: "no repository", yet `.git` exists with no commits | say what happened: initialised, not committed, and the one command |
| F5 | `.github/workflows/ci.yml` | no job or doc mentions macOS (`grep -n macos`: 0 hits). Windows has a job | a `macos` job: scaffold smoke only, `macos-latest`, free on a public repo |
| F6 | `wiki/Installation.md:7,188`, `README.md:12` | floor stated as `>= 1.3`, `≥ 1.4`; `engines.bun` is `>=1.4.4` | one statement; `scripts/bun-pin.test.ts` reads all three |

## Decisions
| Question | Answer |
|---|---|
| Recipes or adapters | recipes as docs. No host-specific config file, no generator, no adapter (axiom 7) |
| Which hosts | the four PaaS rows at `wiki/Tutorial-05-Deploy-Free.md:106-109`, one-box Compose, the chart, bare VM. A host joins by a PR that ran it |
| The npm name `x` | not chased in this slice. Asking npm for it is an owner act, listed last |
| Secrets in `x env init` | generated locally, file gitignored, never printed |

## Files to change
- `packages/cli/src/templates/scaffold-container-compose.ts:59` + test, `docker/docker-compose.prod.yml:59` — F1.
- `packages/cli/src/cmd-env.ts`, `cmd-env-spec.ts`, `cmd-env.test.ts` — `init`.
- `packages/cli/src/cmd-deploy.ts`, `cmd-deploy-compose.ts`, tests — pre-flight.
- `packages/cli/src/cmd-new.ts`, `messages.ts`, `cmd-doctor.ts`, `mcp-errors.ts` + tests — F3, F4.
- `.github/workflows/ci.yml`, `scripts/ci-workflow-shape.test.ts` — compose leg in `container`, `macos` job.
- `scripts/bun-pin.test.ts` — F6.
- `wiki/Deploy-Recipes.md` (new), `wiki/_Sidebar.md`, `wiki/Deployment.md:381-387`, `wiki/Tutorial-05-Deploy-Free.md`, `wiki/Installation.md`, `wiki/CLI-Reference.md`, `packages/cli/README.md`.

## Steps
1. F1, with the failing unit test: each compose file's tmpfs uid equals its image's `USER`, 1000 and 65532.
2. `x env init --production [--json]`: writes `.env.production` from the typed env plus what the compose file needs (`IMAGE`, `POSTGRES_PASSWORD`, a `DATABASE_URL` matching the compose `db`, `APP_URL`, `SYNC_URL`, each required secret from `openssl rand -hex 32`'s equivalent). Refuses an existing file.
3. `x deploy --method compose` reads the env file before the first step and names what is absent. On a failed step, the finding carries the last error line of that container, not only the rerun command.
4. Compose leg in CI, on a fresh scaffold: `x env init --production`, `x build --target docker`, `x deploy`, `/readyz` 200, `/` 200, down.
5. `wiki/Installation.md`: a platform table, Linux, macOS, native Windows, each naming the CI job proving it; and a no-Docker table: dev and the gate need none; deploy takes an image or `--target binary`.
6. `wiki/Deploy-Recipes.md`, one section per host: build source, `PORT`, health path, release command with `ROLE=migrate`, one service per role, what a free tier loses. Each carries `As of` and `executed` or `not executed`.
7. Owner runs: execute the unexecuted recipes on real accounts, flipping each to `executed`; decide whether to ask npm about the name `x`.

## Error codes
`bun run new-error-code`, `--off-socket`.

| Code | When | Fix |
|---|---|---|
| `X_DEPLOY_ENV_MISSING` | `--method compose` with no `.env.production`, or a `${VAR:?}` it does not set | `bunx x env init --production` |
| `X_ENV_FILE_EXISTS` | `x env init --production` over an existing file | `bunx x env check --json` |

## Tests
- `scaffold-container-compose.test.ts`: tmpfs uid; fails on today's line. A `docker/` shape test: the prod compose says 65532, the value in `docker/helm/values.yaml:107`.
- `cmd-env.test.ts`: every `${VAR:?}` in the compose template is written; a second run refuses.
- `cmd-deploy.test.ts`: missing file gives the new code and runs no step.
- CI compose leg: the only proof that a stranger's Compose deploy boots.
- `bun test packages/cli/src/cmd-env.test.ts`

## Semver
Minor. Changelog: apps scaffolded earlier edit one line of `docker/docker-compose.prod.yml`.

## Done when
- A fresh scaffold reaches `/` 200 via `x env init --production` and `x deploy`, in CI, every push to `main`.
- `git grep -n 'bunx x ' -- wiki/Installation.md` has no line that runs outside an installed app.
- A `macos` job is green; `wiki/Deploy-Recipes.md` is linked from `wiki/_Sidebar.md`.
