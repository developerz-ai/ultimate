# Move a Postgres major

**The test services move first and alone; the demo follows only on a green gate over the new
major.** A Postgres major is a planned migration, never a weekly bump: Dependabot ignores
`postgres` majors in both its Docker ecosystems (`.github/dependabot.yml`, #655).

**Where each runs, `As of 2026-11-15`** (`grep -rn -E 'postgres:1[0-9]|pgvector:pg' docker dummy examples packages/cli/src/templates`):

| Site | Major | Who reads it |
|---|---|---|
| `docker/docker-compose.test.yml` — `postgres`, `postgres-standby` (`pgvector/pgvector:pg17`), `postgres-tls` (`postgres:17-alpine`), each by digest | 17 | every `live`, `job` and `e2e` suite, CI and local; `x drill` |
| `docker/docker-compose.dev.yml`, `docker/deploy-proof/postgres.yaml` | 17 | the framework's own dev stack, the deploy-proof manifests |
| `dummy/social-media-clone/docker/docker-compose.{dev,prod}.yml` | 17 | the demo's compose stacks |
| the scaffold (`packages/cli/src/templates/scaffold-test-services.ts`, `scaffold-container-compose.ts`), `dummy/docs-site`, `examples/dummy`'s dev compose | 18 | what `x new` writes; [`04-datastores.md`](./04-datastores.md) sizes 18 for production |
| the deployed demo's database | the operator's cluster | not in this repository: `deploy-social-demo.yml` publishes an image and holds no cluster credential |

So the framework's suites run on 17 while new apps are scaffolded on 18 — the gap the next move
closes.

**Rehearsal:** none yet. This sequence is derived from the files above and the 17 → 18 differences
the scaffold already absorbed; it has not been run end to end. The first run records itself here.

## 1. The test services (one PR, to `main`)

A server major changes no framework API, so it is not a break for apps — unless a suite shows the
framework depends on old behaviour, which is a fix, not a pin.

| # | Step |
|---|---|
| 1 | Read each digest: `docker buildx imagetools inspect pgvector/pgvector:pg<new>` and `docker buildx imagetools inspect postgres:<new>-alpine` — the `Digest:` line |
| 2 | In `docker/docker-compose.test.yml`, write both images as `<tag>@<digest>`; `postgres-standby` keeps the same image as `postgres` |
| 3 | 18 and later keep the cluster under `/var/lib/postgresql/<major>/docker`, not `/var/lib/postgresql/data`: move each `tmpfs:` to `/var/lib/postgresql`, the parent, as the scaffold does — else the cluster lands on the container's disk and the suites lose RAM speed with nothing red. The standby's explicit `PGDATA` stays under the new tmpfs |
| 4 | Update `scripts/test-services-shape.test.ts`'s tmpfs expectation in the same diff, then `bun test ./scripts/test-services-shape.test.ts` |
| 5 | Recreate the services: `docker compose -f docker/docker-compose.test.yml down`, then `docker compose -f docker/docker-compose.test.yml up -d --wait`, then `set -a; . docker/test-services.env; set +a` |
| 6 | `bun run x -- verify --only live,job --json` — the suites that speak to the server: replication, TLS, the standby's paused replay, `pg-vector.live.test.ts` (refuses to skip without the extension) |
| 7 | `bun run schema-dumps --check` — a dump replayed on a real Postgres (a migration creating an extension PGlite cannot link) may differ across majors |
| 8 | `bun run x -- drill --list --json --cwd examples/dummy`, then each drill: `bun run x -- drill <name> --json --cwd examples/dummy` |

## 2. The framework's dev stack and the demo's compose files

| # | Step |
|---|---|
| 1 | `docker/docker-compose.dev.yml`, `docker/deploy-proof/postgres.yaml` and both demo compose files: the new tag (and digest where the file pins one). A named volume mounts at `/var/lib/postgresql` from 18 |
| 2 | A dev volume written by the old major does not start under the new one (#655). Dev data is disposable: `docker compose -f <file> down -v`, then `bun run setup` in the app — migrate and seed rebuild it |
| 3 | `bun run scripts/reference-app-gate.ts --app dummy/social-media-clone` |

## 3. The deployed demo's database

Outside this repository. Its operator moves it by dump and restore into a new cluster at the new
major — `pg_dump --format=plain --no-owner --no-privileges`, the same format as
[`04-datastores.md`](./04-datastores.md)'s backups, restored by
[`05-disaster-recovery.md`](./05-disaster-recovery.md)'s procedure — then repoints `DATABASE_URL`.
After the cut-over: `ROLE=migrate` against the new cluster first ([`07-deploy-contract.md`](./07-deploy-contract.md)),
and the realtime replicator's slot and publication exist only on the old cluster — the replicator
recreates them at start (`packages/realtime/src/pg-preflight.ts`); confirm with
[`06-runbooks.md`](./06-runbooks.md#the-replication-slot-is-accumulating-wal) that the old slot is gone
with the old cluster.

## 4. Gate

| # | Step |
|---|---|
| 1 | `bun run verify` |
| 2 | `bun run scripts/reference-app-gate.ts` |
| 3 | a `CHANGELOG.md` `[Unreleased]` line under `### Changed`: the test services' new major, and the server range the framework is now tested on |
