# 10 — docker/, CI, tracked apps' deploy artifacts

> Part of [`overview.md`](overview.md). Depends on: 09 (`bun-pin` reach), 07 (`x deploy` image). Tier: none (infra files in this repo).

The scaffold template (`packages/cli/src/templates/scaffold-container.ts`) is the reference; the framework's own `docker/` and both apps are stale copies of older templates.

## Files to change
| File | Defect | Template reference |
|---|---|---|
| `docker/docker-compose.prod.yml:47-53` | `backfill` has `command:` and no `entrypoint:`; the image's ENTRYPOINT reads `ROLE`/`PORT` only, so argv is discarded and it serves HTTP as `web` | `scaffold-container.ts:147-152` |
| `docker/docker-compose.prod.yml:62-64` | `web` healthcheck `['CMD', '/app/x', 'doctor', '--json']` — `/app/x` exists only in the distroless CLI image, which this file's header says serves no role → `web` never healthy, `backfill` (`depends_on: service_healthy`) never starts | `scaffold-container.ts:57-58` (rely on the image's `HEALTHCHECK`) |
| `docker/docker-compose.prod.yml:41-43,55-92` | only `web` depends on `migrate`; `sync`/`worker`/`scheduler`/`replicator` start concurrently with it | `scaffold-container.ts:163-207` gates all five |
| `docker/docker-compose.dev.yml:17-30` | `app` service builds the CLI image with `ROLE: web`, `PORT: 3000`, ports → prints the catalogue, exits 0, binds nothing | drop the service; the stack is `db`/`events`/`storage` |
| `examples/dummy/docker/docker-compose.prod.yml:16` | no `backfill` service; `DEPLOY_ROLES` (`cmd-deploy.ts:34`) includes it → `X_DEPLOY_FAILED` after four roles rolled. Also `image: …:${BUILD_ID:?…}` (not `${IMAGE:-…}`), `env_file: ../.env` (not `.env.production`), `QUEUES=default,mail,digest` — an env var nothing in `packages/*/src` reads | `scaffold-container.ts:139-160` |
| `dummy/social-media-clone/docker/docker-compose.prod.yml:19` | no `backfill` service | same |
| `dummy/social-media-clone/docker/Dockerfile.monorepo:25,33`, `Dockerfile:11,24`; `examples/dummy/docker/Dockerfile:11,24` | `FROM oven/bun:1.3-alpine` — the framework, scaffold, setup action and `release.yml` are on 1.4; `Dockerfile.monorepo` is the image **deployed on every push to main**, running a Bun series nothing in CI exercises, installing a 1.4-written `bun.lock` under `--frozen-lockfile` | `scripts/bun-pin.test.ts:1-4` names the incident this recurs |
| `dummy/social-media-clone/docker/Dockerfile.monorepo.dockerignore` | no `**/.npmrc`; the other three have it with the reason; `COPY . .` + `cache-to: type=gha,mode=max` | any of the other three |
| `.github/workflows/ci.yml:480-481` | per-package `bunx biome check packages/<pkg>` is a strict subset of the `verify` job's `biome check .`; ~30 steps per push that cannot fail alone; root `CLAUDE.md` says "never a second job" | delete the two lines, keep `test + coverage` |
| `.github/workflows/ci.yml:6,135,145,223,224,234` | "Three jobs" (six); five "17-step" claims; `:223-224` numerically stale (17 of 19 / 18 of 19 now) | slice 09's widened `gate-steps` reports these |
| `scaffold-container.ts:195,211` | compose half says "advisory lock" for the scheduler; the helm half of the same template says "expiring row in x_scheduler_leader" (the code: `dev-roles.ts:315-318`, `driver-pg-ddl.ts:144`) | fix the compose half |

## Steps
1. Regenerate `docker/docker-compose.prod.yml` from the template's shape by hand: `entrypoint` on `backfill`, drop the `/app/x` healthcheck, `depends_on: migrate` on all five, keep the file's own header prose. Same for both apps' compose files, including `backfill`, `${IMAGE:-…}`, `.env.production`; delete `QUEUES`.
2. Bump the six `FROM` lines to the series `scripts/bun-pin.test.ts` pins (1.4); slice 09 step 4 makes the test read them.
3. Add `**/.npmrc` to the monorepo dockerignore.
4. Delete `ci.yml:480-481`; fix the six stale claims.
5. `docker-compose.dev.yml`: remove `app`.
6. `scaffold-container.ts:195,211`: "expiring lease row" wording.

## Tests
- `scripts/bun-pin.test.ts` reds before step 2, green after.
- New `scripts/compose-parity.test.ts`: for each compose file in `docker/`, `examples/*/docker`, `dummy/*/docker` — every role in `DEPLOY_ROLES` is a service; `backfill` declares `entrypoint`; every serving role `depends_on` `migrate`; no `healthcheck` invokes `/app/x`. Reds on `main` for all three files.
- `bun run scripts/gate-steps.ts` green after slice 09 widens it and these lines are fixed.
- Command: `bun test scripts/bun-pin.test.ts scripts/compose-parity.test.ts`.

## Done when
- `x deploy --method compose --dry-run --json` in both apps lists six steps with no unknown service; the parity test is green; `deploy-social-demo.yml` builds on 1.4 and the demo still answers.
