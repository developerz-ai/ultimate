# Test services: in RAM, silent, and not MinIO

Decided 2026-10-01, on the owner's instruction: "no logs and ram db in tests and cicd, also same
for redis, storage (minio like, but not minio)".

## The rule

One file starts every backing service a suite measures against —
[`docker/docker-compose.test.yml`](../../docker/docker-compose.test.yml) — on a laptop and in CI.

| Rule | How |
|---|---|
| in RAM | every data directory is a tmpfs; no volume |
| no durability | Postgres `fsync`, `synchronous_commit`, `full_page_writes` off, JIT and autovacuum off, a small WAL; Redis `--save ''`, `--appendonly no` |
| silent | Postgres `log_min_messages=fatal`, Redis `--loglevel nothing`, NATS `-l /dev/null`, the gateway `VGW_QUIET`; every container's log driver is `none` |
| one definition | CI's `gate` parts run `docker compose up -d --wait <services>`; the URLs live in `docker/test-services.env` |
| one supplier | a suite that reads a `TEST_*_URL` is run by the part that starts that server and exports the URL — `scripts/test-services-shape.test.ts` |

Held by `scripts/test-services-shape.test.ts`, which also pins `jit=off`, `autovacuum=off`, the
connection ceiling and the one logical server.

## Why compose, not a `services:` block

| `services:` in the workflow | Compose file |
|---|---|
| takes no command: `wal_level=logical` and JetStream were `docker run` by hand in a step, so one job had two mechanisms | one mechanism |
| cannot be conditional on a matrix value | a part names the services it wants |
| exists only in CI | the file a laptop starts |
| readiness was a shell loop per server, and one went red on `main` probing the bootstrap server's unix socket | `--wait` on healthchecks; the TCP probe is in the file |

Postgres takes its settings through `POSTGRES_INITDB_ARGS` (`initdb -c`, Postgres 16+), so neither
server needs a command for them.

## What RAM buys

Measured on a 12-core box with NVMe, images cached, 2026-10-01 — the floor of the gain, since a
hosted runner's disk syncs slower than this one.

| Measure | Disk-backed, as `ci.yml` started them | tmpfs, no fsync |
|---|---|---|
| `pgbench`, 4 clients, 5 s | 1,872 tps | 3,500 tps |
| 20 `CREATE DATABASE … TEMPLATE` clones (what each test worker does) | 6,434 ms | 5,204 ms |
| 12 Postgres- and NATS-backed test files, 84 tests | 13.4–14.1 s | 14.6–15.3 s |
| all five services to healthy | 2,670 ms for the two Postgres servers alone | 3,982 ms for all five |

The third row is the honest one: those suites wait on timers, not on commits, so they do not move.
The gain is in write-heavy suites and in what a run leaves behind, which is nothing.

## The S3 server

`packages/storage` had no live suite: `s3Driver` was proved only against `FakeS3Client`, so no
suite in CI ever spoke to an S3 endpoint. `packages/storage/src/driver-s3.live.test.ts` is that
suite now — 11 tests over the real `Bun.S3Client`: put, get, stream, a 6 MiB object, copy, delete
of an absent key, paged listing, presigned GET and PUT, a forged signature, a GET URL replayed as a
PUT. It is what the candidates were run against, unmodified.

Criteria, in order: passes the suite; permissive licence; one container with no bootstrap; start
time; image size.

| Server | Version | Licence | Suite | Bootstrap before the first PUT | Ready | Image | Idle RSS | Log lines, default |
|---|---|---|---|---|---|---|---|---|
| **Versity S3 Gateway** | v1.8.0 | Apache-2.0 | 11/11 | none — environment only; a directory under the root is a bucket, so a tmpfs mounted at `/data/<bucket>` is the bucket | 369 ms | 101 MB | 9 MiB | 0 with `VGW_QUIET` |
| RustFS | v1.0.0 | Apache-2.0 | 11/11 | a `CreateBucket` call from a second client (a pre-made directory passes 1/11); the tmpfs must be owned by uid 10001 | 580 ms + the call | 401 MB | 132 MiB | 3 |
| SeaweedFS | 4.48 | Apache-2.0 | 11/11 | a `CreateBucket` call | 3,907 ms with it | 724 MB | 132 MiB | 143 |
| Garage | v2.1.0 | AGPL-3.0 | 11/11 | a config file and five admin commands: layout assign, layout apply, key import, bucket create, bucket allow | 2,237 ms | 39 MB | 10 MiB | 173 |
| Zenko CloudServer | 8.2.20 (`S3BACKEND=mem`) | Apache-2.0 | 11/11 | a `CreateBucket` call | 3,975 ms | 2.05 GB | 267 MiB | 183 |

- `Bun.S3Client` has no `CreateBucket` and refuses to presign a bucket root
  (`ERR_S3_INVALID_PATH`), so "a `CreateBucket` call" means a second client or an init container.
  Only Versity needs neither — criterion three decides it.
- Docker Hub's `zenko/cloudserver:latest` was built in 2022.
- MinIO passes the same 11 (`RELEASE.2025-09-07`); it is the baseline, not a candidate.

**Versity S3 Gateway**, pinned `versity/versitygw:v1.8.0`, in three places and one image:
`docker-compose.test.yml` (tmpfs), `docker-compose.dev.yml` (a volume), and the dev compose `x new`
writes (a volume). Production is any S3-compatible endpoint; nothing prescribes a server there.

## What it changed for an app

| | MinIO | Versity |
|---|---|---|
| the bucket | made by hand (`mc mb`) | exists on the first `up` — the volume is mounted at it |
| region | any | checked: a request signed for another region is `AuthorizationHeaderMalformed`. `Bun.S3Client` signs for `auto` when none is set, so every stack here starts the gateway with `VGW_REGION: auto` and an app sets no `S3_REGION` |
| console | `:9001` | `:9001` (`VGW_WEBUI_PORT`), framework dev file only |
| container env | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `ROOT_ACCESS_KEY` / `ROOT_SECRET_KEY` |

## The region trap

The gateway's default region is `us-east-1`, and the first version of this change documented
`S3_REGION=us-east-1` as required. That is a trap, not a rule: an author who runs the scaffold's
compose and uploads a file meets a 400. Closed twice, 2026-10-01:

| Where | What |
|---|---|
| the three compose files | `VGW_REGION: auto` — the region an unset `S3_REGION` signs for. `scripts/test-services-shape.test.ts` pins it, and the live suite runs with no region |
| `s3Driver`, any endpoint | a region mismatch on `put`, `copy`, `list` or `delete` is `X_CONFIG_INVALID` whose fix is `set S3_REGION=<the region the provider named>` — it used to escape `put` as a bare `S3Error` and reach `list`/`delete` with a fix about IAM grants (`packages/storage/src/driver-s3-region.ts`) |

A HEAD has no body, so `exists()` and `stat()` cannot carry the provider's sentence; the first
signed request with one does.

## Object Lock

`As of 2026-10-06` (plan 101 sweep 10a): the signed PUT exists — core's `signAwsRequest`, sent by
`@ultimat3/storage`'s `driver-s3-signed.ts` — and a per-object retention and legal hold round trip
was measured on Versity v1.8.0 with versioning. The compose gateway still has no
`VGW_VERSIONING_DIR`, so its bucket cannot hold a lock and the lock case in
`driver-s3.live.test.ts` skips unless `S3_OBJECT_LOCK_BUCKET` is set. To run it:

1. Start a VERSIONED gateway beside the plain one (any free port):
   `docker run -d --rm --name lock-s3 -p 127.0.0.1:9100:9000 -e VGW_BACKEND=posix -e VGW_BACKEND_ARG=/data -e VGW_PORT=':9000' -e VGW_REGION=auto -e ROOT_ACCESS_KEY=ultimate -e ROOT_SECRET_KEY=ultimate-test -e VGW_VERSIONING_DIR=/versions --tmpfs /data --tmpfs /versions versity/versitygw:v1.8.0`
2. Create a plain bucket and a LOCK-ENABLED one — `CreateBucket` with
   `x-amz-bucket-object-lock-enabled: true`; a lock cannot be turned on after creation. Either
   `aws s3api create-bucket --bucket locked --object-lock-enabled-for-bucket --endpoint-url http://127.0.0.1:9100`,
   or a signed `PUT /locked` through `signAwsRequest({ service: 's3', region: 'auto', … })`.
3. `TEST_S3_URL=http://ultimate:ultimate-test@127.0.0.1:9100/plain S3_OBJECT_LOCK_BUCKET=locked bun test ./packages/storage/src/driver-s3.live.test.ts`
4. `docker stop lock-s3` — the tmpfs goes with it, so no locked object outlives the run.

What it showed: a DELETE without a version id on a locked object SUCCEEDS (a delete marker) and an
overwrite writes a newer version — the locked version stays. That is S3's Object Lock, and it is
why the s3 driver hands both calls to the provider while the local and memory disks refuse them
(`X_STORAGE_OBJECT_LOCKED`). Plan 102/03's premise that S3 answers a locked delete with a refusal
was false.

## The physical standby (2026-11-06)

`postgres-standby` is a streaming physical standby of `postgres` (`TEST_STANDBY_URL`, port 5434),
for the two suites that pause its replay and read behind the primary:
`packages/db/src/replica-position.live.test.ts` and
`packages/cli/src/runtime-replica-roundtrip.live.test.ts`. Before it, both skipped everywhere — the
`postgres-logical` peer is never in recovery, so it cannot say how far it replayed — and the first
run against a real standby found both wrong:

| Found | Why | Now |
|---|---|---|
| a standby replayed exactly to the primary's position looked caught up without the row | `pg_current_wal_lsn()` is the WRITE position; under `synchronous_commit = off` it trails the commit just made | `primaryPosition` reads `pg_current_wal_insert_lsn()` |
| the round trip's non-vacuity read was `X_DB_SCHEMA_STALE`, not `[]` | it paused replay before the standby had replayed its `CREATE TABLE` | it waits for `pg_last_wal_replay_lsn()` to pass the primary's insert position, then pauses |
| a pause that had not landed yet | `pg_wal_replay_pause()` only REQUESTS one; the startup process may replay the next record after it returns | both suites poll `pg_get_wal_replay_pause_state()` to `paused` |

The two `pg_wal_replay_*` calls need a superuser on the standby, which the test services' user is.
To run it beside a shared stack already up, a second compose project with its own ports never
touches the first:
`docker compose -p ultimate-standby-probe -f docker/docker-compose.test.yml -f <override> up -d --wait postgres postgres-standby`,
the override giving both services `ports: !override [...]`, then `down` the same project.

## One logical server, and the throughput settings (2026-11-07)

On the owner's instruction: "dbs no logs, errors optimized, 1 process multiple parallel dbs,
ramdisk, same for redis". Measured on a 16-core laptop, images cached, in a second compose
project on offset ports so the shared stack stayed up.

| Candidate | Verdict | Number |
|---|---|---|
| `postgres-logical` + `postgres-tls` → one server | **done**: `postgres-tls` serves both; `TEST_REPLICATION_URL` dials 5440 with `sslmode=disable` (`host all all all` admits cleartext; without it the wire client's `prefer` would move those suites onto TLS) | idle stack 282 → 245 MiB; `up --wait` 4.31 → 3.96 s (mean of 4); the 7 replication + TLS suites, 31 tests, green on the one server in 3.5 s. Slot, publication, table and role names are disjoint per suite, and `live` runs serially |
| `max_connections` | **raised to 400** | the stock 100 ran out at `bun test --parallel=12` over `packages/{db,entity,testing}`: 98 `too many clients`, read as 96 `X_DB_POOL_EXHAUSTED`. Peak once raised: 305. Cost: ~8 MiB of shared memory per idle server |
| `jit=off`, `autovacuum=off` | **done** | no wall-clock change on the serial live suites (121.6–123.3 s before, 121.9–122.0 s after, fresh servers): they wait on timers. Kept for what they remove — JIT compile on a millisecond query, and an autoanalyze racing a suite's own `analyze` (every plan-asserting suite analyzes explicitly) |
| `min_wal_size=32MB`, `max_wal_size=256MB` | **done**, smaller, not larger | the WAL is a tmpfs, so a kept segment is RAM. Every `DROP DATABASE` requests a checkpoint (64 in one verify), so `max_wal_size` never triggers one and a larger one buys nothing; peak `pg_wal` 48–64 MiB either way |
| `wal_level=minimal` + `max_wal_senders=0` | **killed** here, already true in the scaffold | `postgres` feeds `postgres-standby`; `postgres-tls` decodes logical WAL |
| `log_min_error_statement`, `log_error_verbosity` | **killed**: already silent | `log_min_messages=fatal` suppresses an ERROR and its STATEMENT line: `select 1/0` and an unknown column wrote 0 server log lines |
| `client_min_messages` | **killed** | a client setting, not a server log; a suite may read a NOTICE |
| clone with `STRATEGY file_copy` | **killed** | 20 clones of the migrated template: 170–199 ms `wal_log`, 91–119 ms `file_copy`; ~8 test files clone per run, so ~30 ms a run — not worth `cloneSql` behaving differently on an app's disk-backed server, where `file_copy` forces checkpoints |
| per-worker databases | **already true** | `acquireWorkerDatabase` clones one migrated template per worker (`packages/testing/src/template-db.ts`) |

The same settings land in the test stack `x new` writes (`scaffold-test-services.ts`, and its copy
in `dummy/docs-site/docker/`), whose Redis now logs `nothing` as this repo's does. The deploy
proof's throwaway Postgres in kind (`docker/deploy-proof/postgres.yaml`) runs on a memory
`emptyDir` with fsync off. Dev and production compose files keep their durability: their data is
somebody's.

## Logs in the test run itself

Not closed by this change. A green `bun test` over a package still prints the framework's own JSON
log lines — 137 for `packages/cache`, 114 for `packages/realtime`, 31 for `packages/auth` — because
the default logger's level is read from `LOG_LEVEL` at module init and the preload cannot set it
after the import. `LOG_LEVEL=silent` removes every line and leaves those three suites green; five
tests in `packages/core` assert on the default level and go red under it. CI is quiet when green
regardless: the gate captures a step's output and prints it only when the step fails.
