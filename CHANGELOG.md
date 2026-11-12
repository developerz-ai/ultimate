# Changelog

All notable changes to Ultimate. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Framework packages version in **lockstep** — a release bumps every package to the same version, in one commit, under one tag. Declare `@ultimat3/*` at `^<version>`, as `x new` writes, and let `bun.lock` pin the build; keep every one on the same version, since a mixed-version install is a combination nobody tested. See [PUBLISHING.md](PUBLISHING.md).

Semver applies from 1.0.0. A breaking change to a documented API needs a major — [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) says what "documented API" covers. From 23.0.0 on, each `BREAKING —` line names its migration as `(#N)` straight after the dash — row N of that major's `Entry by entry` table in Upgrading — and `bun run changelog-check` refuses a line without one (`X_DOC_MIGRATION_UNPAIRED`).

**Majors 1 through 30 were the pre-stability line**: shipped from 2026-08 under semver, often weeks apart, each with its edit in [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading). v31 is the stable line: from it, at most one major every 90 days (`X_RELEASE_MAJOR_WINDOW`), breaking changes wait on `next` (`X_BREAKING_ON_MAIN`), and the previous major gets security fixes for six months — [Stability](https://github.com/developerz-ai/ultimate/wiki/Stability).

## [Unreleased]

### Highlights

- An idle job queue costs a quarter of what it did: a worker on two queues, the outbox relay and the scheduler leader send 543 statements an hour, down from 2,418 — workers rest until the next due row instead of claiming every 5 s, counters are batched, and lease renewals are HOT updates.
- `x_jobs` moves to fillfactor 80 and swaps `x_jobs_finished_idx` for the narrower `x_jobs_ended_idx` on the first boot after upgrading (a brief lock under the migration).
- A step write and an operator step resolve lock their job row, so a new attempt never replays from steps missing an in-flight write.

### Added

- `@ultimat3/jobs`: `JOBS_TABLE_STORAGE` — `x_jobs` at `fillfactor = 80`, the framework schema's storage row for it, so `x db migrate` reports a hand-reset fillfactor as `changed-table-storage`.
- `@ultimat3/jobs`: a claim answers two more things. `ClaimOptions.onEmpty(dueInMs)` — a claim that took nothing says how long until a row of those queues can next be taken (`null`: none waits or is held); `OutboxStore.claim(limit, { onEmpty })` the same for a held outbox row's lease. `ClaimedJob.steps` carries the run's step records (`[]` on a first attempt). All optional: a driver or store without them keeps the poll and the step list. `JobIntrospection.renewWorker(id, ttlMs)`, optional, pushes a registry row's expiry alone.
- `@ultimat3/testing`: `jobDriverConformance` checks `onEmpty` (none, a delayed row, a held lease) and `ClaimedJob.steps`; `outboxStoreConformance` checks the outbox `onEmpty`.

### Changed

- `@ultimat3/jobs`: an idle worker with a proven `LISTEN` wake rests until the next row is due — `min(run_at)` over waiting rows, a running row's lapsed lease — at most 60 s, where it claimed every 5 s; the idle claim is `SQL_CLAIM_IDLE`, the plain `SQL_CLAIM` while busy. The rest is armed in 2 s slices that re-read the wake, so a lost wake session falls back to the 2 s poll within one slice. Without a proven wake nothing changes (≤ 2 s). An enqueue due within the 60 s rest notifies (was within 1 s), so a delayed job another process queues starts at its `runAt`; a worker stopping with a retry or `step.sleep` due soon announces it through the new optional `JobDriver.wake`; a woken loop's first empty pass keeps the floor, so the throttled wake's slot-silent row is found a floor later. A driver without `wake` (Redis) never rests. The outbox relay does the same, resting until a held row's lease lapses.
- `@ultimat3/jobs`: a lease renewal and a progress write no longer set `x_jobs.updated_at`, and `x_jobs` is at `fillfactor = 80`, so a renewal is a HOT update that writes no index (> 0.9 of 100 renewals HOT in `driver-pg-heartbeat.job.test.ts`; production before: 247,180 updates, 8 HOT). Existing pages reach the fillfactor as rows churn.
- `@ultimat3/jobs`: the boot drops `x_jobs_finished_idx` and builds `x_jobs_ended_idx` (`failed`, `dead`, `cancelled`; `done` is `x_jobs_done_idx`'s) once per database, inside the locked framework-schema apply. `x_jobs_created_idx` stays: the immediate-enqueue wake reads it.
- `@ultimat3/jobs`: the Postgres driver batches settle counts per process and writes them in one statement every 10 s and on `close()` (`SQL_COUNTER_FLUSH`); `SQL_ACK` and `SQL_NACK` carry no counter upsert. A counter read flushes its own process's batch first; one from another process can lag up to 10 s, and a crash loses at most 10 s of counts, never a row's state. The scheduler leader's counter fold runs every 10 min, hourly after a fold that moved nothing.
- `@ultimat3/jobs`: a worker's registry row lives `max(60 s, visibility timeout)`, renewed every third of that (20 s by default, was the 10 s heartbeat), and is rewritten in full only when its held job ids or drain flag changed; otherwise only its expiry moves.
- `@ultimat3/jobs`: a claimed row carries its run's steps, so an attempt lists none before it runs or after it settles. A lapsed lease on a final attempt is buried in the claim's one update, not a second update in the same statement.
- `@ultimat3/jobs`: the retention pass's orphan-step scan (`SQL_JOBS_RETENTION_ORPHANS`, unindexed) runs at most once a day per process, not every hourly pass.
- `@ultimat3/jobs`: an on-time `jobs.scheduler.dispatched` logs at `debug`; a catch-up fire and `jobs.scheduler.already-fired` stay `info`. `DEFAULT_LEADER_TTL_MS` is 60 s, renewed every 20 s (was 30 s / 10 s). Measured `As of 2026-11-12`, one idle hour of a worker on two queues, a relay and a scheduler leader with three daily tasks, wake live, on the embedded Postgres under fake timers: 2,418 statements → 543 (claims 60, depth reads 60, registry 180, relay 60, leader 180, fold 3).

### Fixed

- `@ultimat3/jobs`: a step write and an operator step resolve lock their job row (`for share`) before writing, so a claim that takes the job over waits for them — a new attempt never replays from steps missing a write that was in flight. Counter batches are capped at 10,000 pending rows while flushes fail (oldest dropped, one `jobs.counters.dropped` warn); a flush whose commit outcome is unknown may count twice.
- `@ultimat3/jobs`: `demand()` (`queue_demand`) counts a draining worker's job again once that job's lease lapses: a draining worker killed mid-job no longer hides the job from the autoscaler for as long as its registry row lives.
## Releases

| Version | Date | Summary |
|---|---|---|
| [31.12.0](docs/changelog/31.12.0.md) | 2026-11-12 | A page no longer stays unstyled after one stylesheet fails during soft navigation: the router does a full load instead of swapping in a page whose CSS did not load, and keeps the previous sheets. |
| [31.11.0](docs/changelog/31.11.0.md) | 2026-11-12 | Security: a `native:` form answer and `uploadFlow` are host- and row-guarded — a refused form never redirects off this host, and an upload's policy judges the row it attaches to. |
| [31.10.0](docs/changelog/31.10.0.md) | 2026-11-12 | Security: `subjectErase` now reaches `<table>_history` — every image naming the erased person is purged in the parent's transaction, including rows deleted earlier and images a `set null`/`cascade` write records. An undeclared history table is `X_SUBJECT_TABLE_UNDECLARED`. |
| [31.9.0](docs/changelog/31.9.0.md) | 2026-11-12 | Set-based entity writes: `db.x.where(…).updateAll(patch)` / `.deleteAll()` is one statement, and `updateMany([{ id, patch }])` writes 1,000 different rows in one statement. |
| [31.8.0](docs/changelog/31.8.0.md) | 2026-11-12 | A rate-limit check writes no WAL: `x_rate_limit` is unlogged at fillfactor 70 (2 WAL records per take → 0). |
| [31.7.0](docs/changelog/31.7.0.md) | 2026-11-12 | Security: a sealed column no longer enters a history image (its lookup ciphertext was an equality oracle), and the authorization server enforces each client's registered grants and auth method. |
| [31.6.1](docs/changelog/31.6.1.md) | 2026-11-11 | After a deploy, a CDN can no longer hand a page an island chunk from the previous build: every island and `/_x/assets` script is named by a hash of its final bytes (#1075). |
| [31.6.0](docs/changelog/31.6.0.md) | 2026-11-11 | `contract-diff` compares against the manifest as committed, so `x manifest` or `x g` can no longer rebaseline a breaking change away before the gate sees it. |
| [31.5.0](docs/changelog/31.5.0.md) | 2026-11-11 | One address no longer meets 429 on a cold page load: built, content-hashed assets spend a new `assets` rate-limit bucket (2,000 burst, 200/s) instead of `default`. Measured: 180 of 300 island-chunk GETs from one address answered 429 before, 0 after. |
| [31.4.2](docs/changelog/31.4.2.md) | 2026-11-11 | `launchChrome` no longer gives up on a cold Chrome that has already opened its debugging port: the connection now gets what is left of the 60 s launch deadline, not the 10 s per-call one. |
| [31.4.1](docs/changelog/31.4.1.md) | 2026-11-11 | An island that throws an app error code ships about half the bytes: import `defineError` from `@ultimat3/core/page` (12,019 B → 6,507 B). |
| [31.4.0](docs/changelog/31.4.0.md) | 2026-11-11 | `ROLE=migrate` loads 104 fewer modules (977 → 873): the framework schema now reads the auth tables from the new `@ultimat3/auth/schema` leaf instead of the whole auth package. |
| [31.3.0](docs/changelog/31.3.0.md) | 2026-11-11 | Read one row's recorded history in write order with `history(db.postsHistory, id)`: versions numbered from 1, scoped to the tenant. |
| [31.2.0](docs/changelog/31.2.0.md) | 2026-11-10 | `x build` and `x exercise` honour `runtime.ts`: an audit sink declared there makes audited pages measurable and audited primitives reachable. |
| [31.1.0](docs/changelog/31.1.0.md) | 2026-11-10 | `x affected`, `x verify --changed` and `x test --affected` measure a change against `origin/main` by default, not a local `main` nobody pulled, and `bun test $(x affected --paths)` receives only paths. |
| [31.0.0](docs/changelog/31.0.0.md) | 2026-11-10 | **v31 is the stable line.** 74 breaking changes — most delete a second way to do one thing, the rest are security fixes and limits — each with its edit in [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading#30x--3100-entry-by-entry). The next major comes no earlier than 2027-02-08, 90 days from today ([Stability](https://github.com/developerz-ai/ultimate/wiki/Stability)). |
| [30.9.0](docs/changelog/30.9.0.md) | 2026-11-09 | The test network seal is whole: every DNS resolver, `node:net`/`tls`/`http(s)`/`http2` and UDP are refused unless loopback, mocked or allowed — a test that reached the internet through one of them now fails, and `allowHost('<host>')` is the fix it prints. |
| [30.8.0](docs/changelog/30.8.0.md) | 2026-11-08 | Every primitive of a real app can be reached by `x exercise`: an entry can carry its call's cookies and headers, a job and an action of one name get separate entries, and a throwing entry is that primitive's record instead of the end of the pass. |
| [30.7.0](docs/changelog/30.7.0.md) | 2026-11-08 | `x exercise` runs at the size of a real app. A crash proof costs the same over 1,500 seeded rows as over 3: one job's proof cost a 504-primitive app most of a 172-minute pass. Every record and the report now say where the time went. |
| [30.6.0](docs/changelog/30.6.0.md) | 2026-11-08 | `x exercise` counts a job's own statements: never the jobs it queued, never jobs it found queued. A job that queues one child per row is no longer `X_QUERY_SCALES_WITH_ROWS`. |
| [30.5.0](docs/changelog/30.5.0.md) | 2026-11-08 | `x exercise` reports what a 5xx said, seeds a NOT NULL `json(t.json())` column, resolves mocked hosts under the sealed network, and names the step a crash-proof effect ran inside. |
| [30.4.0](docs/changelog/30.4.0.md) | 2026-11-07 | `x exercise` runs vendor-calling handlers for real under the sealed network: `defineExercise(overrides, { setup })` installs an app's `mockFetch` routes or `cassette()` for the pass. |
| [30.3.0](docs/changelog/30.3.0.md) | 2026-11-07 | `x exercise` seats a job in the tenant it is enqueued under, whatever field its `tenant(input)` reads: no more `X_JOB_TENANT_MISMATCH` (and `X_TENANCY_ACTOR_MISMATCH` inside) on a job whose org field the id binder did not recognise. |
| [30.2.0](docs/changelog/30.2.0.md) | 2026-11-07 | `seo: { llms: false }` hands `/llms.txt` to the app: an app serving its own no longer fails to boot with `X_ROUTE_CONFLICT`. |
| [30.1.0](docs/changelog/30.1.0.md) | 2026-11-07 | `x exercise` seeds a table with your own `defineFactory`, so an entity whose rows no generated value satisfies — a cross-column `satisfies`, a JSON column with required keys — runs the gate's `exercise` step. |
| [30.0.0](docs/changelog/30.0.0.md) | 2026-11-07 | One major for the whole of plan 101: every breaking change below lands here once, each with its edit in [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading). |
| [29.4.0](docs/changelog/29.4.0.md) | 2026-10-31 | Added · Changed |
| [29.3.2](docs/changelog/29.3.2.md) | 2026-10-31 | Added · Fixed |
| [29.3.1](docs/changelog/29.3.1.md) | 2026-10-30 | Fixed |
| [29.3.0](docs/changelog/29.3.0.md) | 2026-10-30 | Added · Fixed |
| [29.2.0](docs/changelog/29.2.0.md) | 2026-10-30 | Added · Changed |
| [29.1.0](docs/changelog/29.1.0.md) | 2026-10-29 | Added · Changed |
| [29.0.0](docs/changelog/29.0.0.md) | 2026-10-28 | Added · Changed · Fixed |
| [28.0.0](docs/changelog/28.0.0.md) | 2026-10-24 | Changed · Added · Fixed |
| [27.16.1](docs/changelog/27.16.1.md) | 2026-10-24 | Fixed |
| [27.16.0](docs/changelog/27.16.0.md) | 2026-10-23 | Added · Fixed |
| [27.15.0](docs/changelog/27.15.0.md) | 2026-10-22 | Added · Fixed |
| [27.14.1](docs/changelog/27.14.1.md) | 2026-10-22 | Fixed |
| [27.14.0](docs/changelog/27.14.0.md) | 2026-10-22 | Added · Fixed |
| [27.13.2](docs/changelog/27.13.2.md) | 2026-10-21 | Fixed |
| [27.13.1](docs/changelog/27.13.1.md) | 2026-10-20 | Fixed |
| [27.13.0](docs/changelog/27.13.0.md) | 2026-10-20 | Added · Fixed |
| [27.12.0](docs/changelog/27.12.0.md) | 2026-10-18 | Added · Changed |
| [27.11.0](docs/changelog/27.11.0.md) | 2026-10-17 | Fixed |
| [27.10.4](docs/changelog/27.10.4.md) | 2026-10-15 | Fixed |
| [27.10.3](docs/changelog/27.10.3.md) | 2026-10-15 | Fixed |
| [27.10.2](docs/changelog/27.10.2.md) | 2026-10-14 | Fixed |
| [27.10.1](docs/changelog/27.10.1.md) | 2026-10-12 | Fixed |
| [27.10.0](docs/changelog/27.10.0.md) | 2026-10-12 | Added · Changed · Fixed |
| [27.9.0](docs/changelog/27.9.0.md) | 2026-10-11 | Added · Fixed |
| [27.8.1](docs/changelog/27.8.1.md) | 2026-10-11 | Fixed |
| [27.8.0](docs/changelog/27.8.0.md) | 2026-10-11 | Added · Fixed |
| [27.7.0](docs/changelog/27.7.0.md) | 2026-10-10 | Fixed |
| [27.6.1](docs/changelog/27.6.1.md) | 2026-10-10 | Fixed |
| [27.6.0](docs/changelog/27.6.0.md) | 2026-10-10 | Added · Fixed |
| [27.5.0](docs/changelog/27.5.0.md) | 2026-10-10 | Added · Fixed |
| [27.4.0](docs/changelog/27.4.0.md) | 2026-10-09 | Added · Fixed |
| [27.3.0](docs/changelog/27.3.0.md) | 2026-10-09 | Added · Fixed |
| [27.2.3](docs/changelog/27.2.3.md) | 2026-10-09 | Fixed |
| [27.2.2](docs/changelog/27.2.2.md) | 2026-10-09 | Fixed |
| [27.2.1](docs/changelog/27.2.1.md) | 2026-10-09 | Fixed |
| [27.2.0](docs/changelog/27.2.0.md) | 2026-10-09 | Added · Fixed |
| [27.1.0](docs/changelog/27.1.0.md) | 2026-10-09 | Added |
| [27.0.0](docs/changelog/27.0.0.md) | 2026-10-09 | Changed · Added · Fixed |
| [26.1.1](docs/changelog/26.1.1.md) | 2026-10-08 | Fixed |
| [26.1.0](docs/changelog/26.1.0.md) | 2026-10-08 | Added · Fixed |
| [26.0.0](docs/changelog/26.0.0.md) | 2026-10-08 | Changed · Added |
| [25.2.0](docs/changelog/25.2.0.md) | 2026-10-07 | Added · Fixed |
| [25.1.0](docs/changelog/25.1.0.md) | 2026-10-07 | Added · Fixed |
| [25.0.0](docs/changelog/25.0.0.md) | 2026-10-07 | Added · Security · Changed · Fixed |
| [24.0.0](docs/changelog/24.0.0.md) | 2026-10-04 | Added · Changed · Fixed |
| [23.0.0](docs/changelog/23.0.0.md) | 2026-10-02 | Added · Changed · Fixed · Removed |
| [22.15.0](docs/changelog/22.15.0.md) | 2026-10-01 | Added · Changed · Fixed |
| [22.14.0](docs/changelog/22.14.0.md) | 2026-09-30 | Added |
| [22.13.0](docs/changelog/22.13.0.md) | 2026-09-29 | Added · Changed · Fixed |
| [22.12.0](docs/changelog/22.12.0.md) | 2026-09-29 | Added · Fixed |
| [22.11.0](docs/changelog/22.11.0.md) | 2026-09-29 | Changed · Added · Fixed |
| [22.10.0](docs/changelog/22.10.0.md) | 2026-09-29 | Added · Changed |
| [22.9.1](docs/changelog/22.9.1.md) | 2026-09-29 | Fixed |
| [22.9.0](docs/changelog/22.9.0.md) | 2026-09-29 | Added · Fixed |
| [22.8.2](docs/changelog/22.8.2.md) | 2026-09-28 | Fixed |
| [22.8.1](docs/changelog/22.8.1.md) | 2026-09-28 | Fixed · Added |
| [22.8.0](docs/changelog/22.8.0.md) | 2026-09-28 | Added · Changed |
| [22.7.1](docs/changelog/22.7.1.md) | 2026-09-28 | Fixed |
| [22.7.0](docs/changelog/22.7.0.md) | 2026-09-28 | Changed · Added · Fixed |
| [22.6.2](docs/changelog/22.6.2.md) | 2026-09-27 | Fixed |
| [22.6.1](docs/changelog/22.6.1.md) | 2026-09-27 | Fixed |
| [22.6.0](docs/changelog/22.6.0.md) | 2026-09-27 | Added · Changed · Security |
| [22.5.1](docs/changelog/22.5.1.md) | 2026-09-27 | Security |
| [22.5.0](docs/changelog/22.5.0.md) | 2026-09-27 | Added · Fixed |
| [22.4.0](docs/changelog/22.4.0.md) | 2026-09-27 | Added · Fixed |
| [22.3.6](docs/changelog/22.3.6.md) | 2026-09-26 | Fixed |
| [22.3.5](docs/changelog/22.3.5.md) | 2026-09-26 | Fixed |
| [22.3.4](docs/changelog/22.3.4.md) | 2026-09-26 | Fixed |
| [22.3.3](docs/changelog/22.3.3.md) | 2026-09-26 | Security · Fixed |
| [22.3.2](docs/changelog/22.3.2.md) | 2026-09-26 | Fixed |
| [22.3.1](docs/changelog/22.3.1.md) | 2026-09-26 | Added · Changed · Fixed |
| [22.3.0](docs/changelog/22.3.0.md) | 2026-09-25 | Added · Changed · Fixed |
| [22.2.2](docs/changelog/22.2.2.md) | 2026-09-25 | Added · Fixed |
| [22.2.1](docs/changelog/22.2.1.md) | 2026-09-25 | Fixed |
| [22.2.0](docs/changelog/22.2.0.md) | 2026-09-24 | Added · Fixed |
| [22.1.0](docs/changelog/22.1.0.md) | 2026-09-24 | Changed · Security · Fixed |
| [22.0.0](docs/changelog/22.0.0.md) | 2026-09-24 | Changed · Added · Fixed |
| [21.0.0](docs/changelog/21.0.0.md) | 2026-09-23 | Added · Fixed · Changed |
| [20.2.1](docs/changelog/20.2.1.md) | 2026-09-19 | Changed · Fixed |
| [20.2.0](docs/changelog/20.2.0.md) | 2026-09-19 | Added · Fixed |
| [20.1.6](docs/changelog/20.1.6.md) | 2026-09-18 | Fixed |
| [20.1.5](docs/changelog/20.1.5.md) | 2026-09-18 | Fixed |
| [20.1.4](docs/changelog/20.1.4.md) | 2026-09-18 | Added · Fixed |
| [20.1.3](docs/changelog/20.1.3.md) | 2026-09-18 | Fixed |
| [20.1.2](docs/changelog/20.1.2.md) | 2026-09-16 | Changed · Fixed |
| [20.1.1](docs/changelog/20.1.1.md) | 2026-09-12 | Fixed |
| [20.1.0](docs/changelog/20.1.0.md) | 2026-09-12 | Added · Changed · Fixed |
| [20.0.0](docs/changelog/20.0.0.md) | 2026-09-08 | Added · Changed · Fixed |
| [19.4.0](docs/changelog/19.4.0.md) | 2026-09-08 | Added |
| [19.3.3](docs/changelog/19.3.3.md) | 2026-09-07 | Added |
| [19.3.2](docs/changelog/19.3.2.md) | 2026-09-07 | Added · Fixed |
| [19.3.1](docs/changelog/19.3.1.md) | 2026-09-06 | Fixed |
| [19.3.0](docs/changelog/19.3.0.md) | 2026-09-06 | Removed · Fixed |
| [19.2.0](docs/changelog/19.2.0.md) | 2026-09-06 | Added · Changed · Fixed |
| [19.1.3](docs/changelog/19.1.3.md) | 2026-09-06 | Fixed |
| [19.1.2](docs/changelog/19.1.2.md) | 2026-09-06 | Fixed |
| [19.1.1](docs/changelog/19.1.1.md) | 2026-09-05 | Fixed |
| [19.1.0](docs/changelog/19.1.0.md) | 2026-09-05 | Fixed · Changed · Not changed, and the evidence for why |
| [19.0.0](docs/changelog/19.0.0.md) | 2026-08-27 | Added · Fixed · Changed · Not changed, and the evidence for why |
| [18.0.0](docs/changelog/18.0.0.md) | 2026-08-27 | Added · Changed · Fixed |
| [17.0.0](docs/changelog/17.0.0.md) | 2026-08-26 | Added · Changed · Fixed · Removed |
| [16.0.0](docs/changelog/16.0.0.md) | 2026-08-26 | Added · Fixed · Changed |
| [15.0.0](docs/changelog/15.0.0.md) | 2026-08-25 | Fixed · Changed · Known |
| [14.0.0](docs/changelog/14.0.0.md) | 2026-08-25 | Added · Fixed · Changed |
| [13.0.0](docs/changelog/13.0.0.md) | 2026-08-25 | Added · Fixed · Changed |
| [12.0.0](docs/changelog/12.0.0.md) | 2026-08-24 | Security · Fixed · Added · Removed · Changed |
| [11.3.0](docs/changelog/11.3.0.md) | 2026-08-24 | Fixed · Added · Changed |
| [11.2.0](docs/changelog/11.2.0.md) | 2026-08-23 | Added · Fixed · Changed |
| [11.1.0](docs/changelog/11.1.0.md) | 2026-08-23 | Added |
| [11.0.0](docs/changelog/11.0.0.md) | 2026-08-23 | Added · Changed · Fixed |

## Older releases

`10.0.0` and everything before it are **in git history, not in this file**. No length cap is
enforced: trimming is a deliberate edit that deletes the oldest `## X.Y.Z` sections, because a
changelog nobody scrolls to the bottom of is a changelog nobody reads, and every deleted line is
one `git show` away.

| Want | Run |
|---|---|
| one past release's section | `git show v10.0.0:CHANGELOG.md` — or any tag; every release from 1.0.0 on is tagged |
| when a line was written, and by whom | `git log -p --follow -- CHANGELOG.md` |
| the whole file as it stood at the last full release | `git show v13.0.0:CHANGELOG.md` |
| what a major broke, without git | [`wiki/Upgrading.md`](https://github.com/developerz-ai/ultimate/wiki/Upgrading) — it walks **every** major, oldest first, and is deliberately NOT truncated |

**The upgrade guide is the one that has to stay complete**, and it does: a reader upgrading across
four majors needs every walkthrough in order, where a reader of this file wants the last release.
Two documents, two jobs — `bun run changelog-check` reads the oldest `## X.Y.Z` heading still here
as the retention boundary and stops demanding a section below it, so trimming this file again is
deleting sections and nothing else.
