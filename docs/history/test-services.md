# Test services: in RAM, silent, and not MinIO

Decided 2026-10-01, on the owner's instruction: "no logs and ram db in tests and cicd, also same
for redis, storage (minio like, but not minio)".

## The rule

One file starts every backing service a suite measures against —
[`docker/docker-compose.test.yml`](../../docker/docker-compose.test.yml) — on a laptop and in CI.

| Rule | How |
|---|---|
| in RAM | every data directory is a tmpfs; no volume |
| no durability | Postgres `fsync`, `synchronous_commit`, `full_page_writes` off; Redis `--save ''`, `--appendonly no` |
| silent | Postgres `log_min_messages=fatal`, Redis `--loglevel nothing`, NATS `-l /dev/null`, the gateway `VGW_QUIET`; every container's log driver is `none` |
| one definition | CI's `gate` parts run `docker compose up -d --wait <services>`; the URLs live in `docker/test-services.env` |

Held by `scripts/test-services-shape.test.ts`.

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

Plan `docs/plans/2026/09/22/102-downstream-app-gaps/03-storage-object-lock.md` will need a
lock-enabled bucket. `As of 2026-10-01`: with `VGW_VERSIONING_DIR` set, Versity creates one and a
client reads it back as enabled; a per-object retention round trip was not measured, because the
signed PUT that carries `x-amz-object-lock-*` is that plan's `signAwsRequest`, which does not exist
yet. Such a bucket is made by a `CreateBucket` call with the lock header, so it will need the init
step the plain bucket does not.

## Logs in the test run itself

Not closed by this change. A green `bun test` over a package still prints the framework's own JSON
log lines — 137 for `packages/cache`, 114 for `packages/realtime`, 31 for `packages/auth` — because
the default logger's level is read from `LOG_LEVEL` at module init and the preload cannot set it
after the import. `LOG_LEVEL=silent` removes every line and leaves those three suites green; five
tests in `packages/core` assert on the default level and go red under it. CI is quiet when green
regardless: the gate captures a step's output and prints it only when the step fails.
