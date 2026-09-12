# Bare VM

A fresh Ubuntu box with **bun** and **git** runs a scaffolded app's whole gate. No Docker daemon, no
Postgres, no Redis, no NATS, no object store, no `.env` editing. Bun runs all four commands below;
git is what commits the scaffold, and `--no-git` is the form that skips it.

```sh
bunx create-ultimate demo --no-git
cd demo
bin/setup
bin/check
```

| Command | What it needs from the box |
|---|---|
| `bunx create-ultimate demo --no-git` | bun, and a network the npm registry answers on. `--no-git` skips `git init`, which is the form an automated provisioner uses; without it the scaffold is committed, and that is git's only job here |
| `cd demo` | — |
| `bin/setup` | bun. Six steps: `bun install`, an `.env.development.local` touch, `x db gen "initial"` when `packages/db/migrations` holds no `.sql`, `x db migrate`, `x db seed`, `x manifest` |
| `bin/check` | bun. `x build --target static`, then `x verify` — the build first, because `budgets` weighs `.x/build-stats.json` and the build is that file's only writer |

`x new` installs nothing, so `bin/setup` is not optional and `cd demo && bin/check` stops on
`X_BUILD_FAILED` naming `bun install` ([Installation](Installation)).

## Why no service is needed

The scaffold's `.env.development` ships committed non-secret defaults, and it leaves `DATABASE_URL`
empty. An empty `DATABASE_URL` is not a hole to fill — it is the switch that selects the embedded
database, in `resolveServices`
([`packages/cli/src/dev-services.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/dev-services.ts)),
which is the one place the three service bindings are decided:

| Binding | Unset env | Resolves to | Set it to |
|---|---|---|---|
| db | `DATABASE_URL` | `pglite://<app>/.x/pgdata` — Postgres compiled to WASM, running **inside this process** | a `postgres:` URL |
| events | `NATS_URL` | `inproc://events` — in-process fanout | a NATS URL |
| storage | `S3_ENDPOINT` | `file://<app>/.x/storage` | an S3 endpoint |

The database is
[`packages/db/src/pglite.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/db/src/pglite.ts):
a real Postgres, WASM-compiled, opened on a directory under `.x/`, so `x db migrate` and `x db seed`
write to the same engine the app then reads — no container to wait for, no port to publish, and a
restart keeps the data. The module is an **optional peer resolved at first query, never at import**,
so an image that only ever talks to a managed Postgres does not carry the WASM it will never load.
`@electric-sql/pglite` is a `devDependencies` entry of the generated app, which is what puts it on
the box during step 1 of `bin/setup`.

**Its absence is a coded refusal, never a silent skip**: `X_DB_UNAVAILABLE`, whose `fix:` is
`bun add @electric-sql/pglite, or set DATABASE_URL to a Postgres server and re-run` — a command the
reader runs, on a box that has just told them what is wrong.

`x doctor` says it earlier than the first query does. Its external-database probe answers nothing
where `DATABASE_URL` is unset, and that silence is exactly this box, so it asks the embedded
question too: does the peer **resolve** from the app root — a resolve, never an import, since
loading it boots the WASM and takes the single-writer lock the next command needs. Red only where
`DATABASE_URL` is unset *and* the peer is unresolvable ([CLI reference](CLI-Reference)).

`bin/check`'s `live`, `job` and `e2e` steps need no service of their own in a generated app: the
queue is Postgres (`SELECT … FOR UPDATE SKIP LOCKED`), the fanout is in-process, and both resolve
through the table above.

## What the embedded database does not do

**No logical replication.** PGlite has no walsender, so there is no write-ahead log to decode and no
slot to take. A `--live` query still works: `x dev` installs the in-process bridge instead — the
same row observer the framework's own live tests run on — and the boot line says which feed you
got, `live=in-process` under the embedded database and `live=replication` under a real one
(`packages/cli/src/dev-live-feed.ts`). Its honest bound is that a write made by **another process**
is invisible to it, which holds by construction under `x dev`, where every role is this one process
([Realtime](Realtime)).

Reach for the dev compose file only when you want parity against real Postgres, NATS and MinIO
([Deployment](Deployment)). Nothing on this page uses it.

## Wall time

On a **WSL2 developer box — not a bare VM, and not a CI runner** — on a Bun the CLI's own floor
accepts (`x doctor`), against real `x new` scaffolds, first pass, nothing waived and no fix-follow,
warm Bun cache, `As of 2026-09-11`:

| Measure | Default scaffold | `--no-example` |
|---|---|---|
| files written | 151 | 123 |
| `bin/setup` | **6,802ms** | **5,135ms** |
| `bin/check` | **5,389ms** | **3,909ms** |
| the first `bin/check`'s verdict | **green, 20 of 20 steps**, `budgets` included | **green, 20 of 20 steps**, `budgets` included |

The cache is the variable to watch, not the box: a **cold** first install takes the `bun install`
inside `bin/setup` to **12.0s** on the same machine. `budgets` is green on that first pass on both
shapes because `bin/check` builds before it verifies — nothing is waived to get there.

<!--
  PLACEHOLDER — issue #430, the `ubuntu-latest` half. The same two scripts are measured by the CI
  job that runs the scaffold's own `bin/setup && bin/check` on a fresh scaffold
  (`.github/workflows/ci.yml`), which prints the same table on every run. Replace the numbers above
  with the runner's — or add them as a third column — once that job has actually run, dated
  `As of <YYYY-MM>`. Until then these are a developer box's, and the header says so.
-->

The same two scripts run in CI on an `ubuntu-latest` runner — a free one, no paid tier — and that
job prints this table itself, which is the measurement that speaks for a provisioned box. A timing typed from a laptop describes that
laptop, which is why the source of each row is named rather than implied.
