# 17 — Tests that cannot flake and cannot pass vacuously

> Part of [`overview.md`](overview.md). Depends on: none; runs after the slices that edit the same sources (9, 10, 11) so the locks do not collide. Tier: tests only, all tiers.

Owner rule (2026-10): a flaky test is root-caused, never rerun to green and never given a longer timeout. A negative assertion standing on a real sleep passes on a slow runner without proving anything.

The rail exists: `scripts/test-real-sleep.ts` (a host check of the `errors` step, `scripts/verify.ts:305`) refuses a new wall-clock wait in a test, with a per-package ratchet in `scripts/lib/test-real-sleep-pins.ts`. **This slice adds no guard and no code. It drives the pins to zero.** No `.skip`, `.todo` or `.only` exists in the packages.

## The ratchet, as of 2026-11-11

| Package | Pin | Worst files (`file:line`) | Seam to use |
|---|---|---|---|
| `cli` | 104 | not itemised by the audits: `bun run scripts/test-real-sleep.ts --explain --json` lists every site | most wait on a child process or a dev server: await the event (a ready line, an exit), or annotate `// real-clock: <why>` when it truly is another process's time |
| `jobs` | 77 | `worker-drain-budget.test.ts:164,193`, `scheduler-drain-budget.test.ts:191,209,213`, `outbox-relay.test.ts:236`, `worker-max-in-flight.test.ts`, `execute.test.ts`, `scheduler-lifecycle.test.ts`, `worker-loop.test.ts:94,100` | `WorkerOptions.schedule` / the injected clock; assert on handed-over timers |
| `realtime` | 57 | `nats-transport-redial.test.ts:137-260` (8 waits, 5–100 ms), `nats-transport-background.test.ts:84`, `presence.live.test.ts:86` (500 ms) | the scheduler the transport already takes; await the predicate, fire the timer by hand |
| `db` | 25 | `transaction-sibling.test.ts:68,87,106`, `concurrent-index.live.test.ts:159,162` (400 ms) | live tests wait on a database fact (`pg_stat_activity`, a lock row), never on time |
| `core` | 18 | `lifecycle-bounds.test.ts:96,101` (a 60 ms hook racing a 40 ms timer) | fake timers |
| `http` | 10 | `server-drain.test.ts:110,119,139,148,161`, `deadline.test.ts:70` | the drain's clock seam |
| `render` | 7 | `navigation.test.ts:82,315,317,368`, `navigation-input.test.ts:18`: 120–200 ms waits against the router's 150 ms progress delay, a 30–50 ms margin | a scheduler seam on the router (new, in `navigation*.ts`), driven by hand as `render-isr-flight.test.ts` does |
| `mail`, `pwa`, `scraping` | 6 each | — | as above; `scraping`'s four on a real child keep their `real-clock` line |
| `ai`, `testing`, `ui`, `entity`, `scripts`, `auth`, `cache` | 4, 3, 3, 2, 2, 1, 1 | `entity/src/pg-transition-observed.live.test.ts:108` (a 150 ms race) | as above |

Total pinned: 332 sites.

Weak assertions, separate from the ratchet: `toBeDefined()` × 41 in `packages/schema/src/validators-builtins.test.ts`, × 9 in `packages/cache/src/lru.test.ts` — assert the value.

## One addition: find a flake before it merges
- Retries and quarantine are decided out (`docs/architecture/14-testing-internals.md:195`). A *detector* is not a retry: a CI job that runs the **changed** test files with `--rerun-each 5` (`scripts/lib/bun-test-paths.ts:12` already knows the flag) and is red if any run differs. Changed files only, so it stays inside the 5-minute budget. Lands in [`16`](16-gate-ci-docker.md)'s `ci.yml` edit; listed here because it is this slice's acceptance test.

## Files to change
- The test files behind each pin (≈ 150 files across two sweeps), and the two seams that do not exist yet: `packages/render/src/navigation*.ts` (scheduler), `packages/http/src/server-drain.ts` (clock) if not injectable.
- `scripts/lib/test-real-sleep-pins.ts` — coordinator only, lowered with `bun run scripts/test-real-sleep.ts --unpin <pkg>` after each band.
- `packages/schema/src/validators-builtins.test.ts`, `packages/cache/src/lru.test.ts`.

## Steps
1. Sweep 17a (≤ 100 files): W1 `jobs`; W2 `realtime`; W3 `render` + `http` + `core`; W4 `db` + the small packages.
2. Sweep 17b: `cli`'s 104, four workers by file-name band (`cmd-*`, `dev-*`, `runtime-*`, the rest).
3. For each file: replace the wait with the seam, then **prove the test can fail** — break the behaviour under test by hand and show red (the `test-author` agent's mutation check). A converted test that stays green under the mutation was vacuous: rewrite it.
4. A wait on another process's time keeps a `// real-clock: <why>` line; the pin counts what is left, and the PR lists each survivor with its reason.
5. Record the `unit` step's wall-clock before and after (its timing file) in each PR.

## Tests
- `bun run scripts/test-real-sleep.ts --json` — the pin of every converted package at its new figure.
- Per converted file: one mutation shown red in the PR description.
- 20 consecutive runs of the converted files (`bun test ./<path> --rerun-each 20`), four copies in parallel for load: green.

## Done when
- Pins at zero for `jobs`, `realtime`, `render`, `http`, `core`, `db`; every remaining site in any package carries a `real-clock` reason.
- The changed-files rerun job is in CI and has caught nothing for a week (or what it caught is fixed).
- The `unit` step is measurably faster; the figure is in the PR.

## Outcome (17a, local)

`As of 2026-11-13`, before release. All 15 packages besides `cli` and `scripts` are at zero, and their rows are gone from `scripts/lib/test-real-sleep-pins.ts` (a package with no row is pinned at zero). `bun run scripts/test-real-sleep.ts --json` now counts only `cli` 104 and `scripts` 2, which belong to 17b.

| Band | Before → after | How |
|---|---|---|
| W1 `jobs` | 77 → 0 | `fake-time-fixture.ts`, `manual-schedule-fixture.ts`: the worker's `schedule` and the injected clock, with handed-over timers fired by hand. `queue-wake.job` `WAKE_BOUND_MS` 1,000 → `10 × FLOOR_MS` |
| W2 `realtime` | 57 → 0 | new `NatsTransportOptions.scheduler` / `SelectTransportOptions.scheduler`; `turns-fixture.ts`; fake timers for the sync node. `sync-worker.test` `onconnect` race fixed |
| W3 `render`, `http`, `core` | 7 + 10 + 18 → 0 | `render`: the DOM fixture's window owns its timers (`navigation-dom-fixture.ts`, `win.advance`), with no new seam in `navigation*.ts`. `core`: fake timers; `raster-pool.test` counts which thread ran the codec (`spyOn`) instead of timing a 1 ms interval. `http`: the `server-drain` WebSocket bounds dropped, leaving only a lower bound (`≥ 399` ms, the drain's own budget) |
| W4 `db`, `entity`, `ai`, `auth`, `cache`, `mail`, `pwa`, `ui`, `scraping`, `testing` | 25 + 2 + 4 + 1 + 1 + 6 + 6 + 3 + 6 + 3 → 0 | Live tests wait on a database fact (`pg_stat_activity`, a lock row) instead of on time. Bug fixed on the way: `uploadInParts` settles the parts in flight before it rejects |
| W5 | — | the `--rerun-each` seam (`packages/testing/src/rerun-declarations.ts`); the Redis pub/sub resubscribe retry, the 1 s command bound and `CLIENT SETNAME` (`packages/cache/src/redis-pubsub.ts`), which fix the diagnosed cause of the `runtime-cache-redis.live` flake. The flake itself was not reproduced; the live test now waits for this replica's own named connection in `CLIENT LIST TYPE pubsub`; the `rate-limit-postgres.live` HOT check waits on `pg_stat_activity`'s horizon holders |

Weak assertions: `toBeDefined()` drops from 41 to 0 in `validators-builtins.test.ts` and from 9 to 0 in `lru.test.ts`; each now asserts the value.

`unit` step, `bun run verify --only unit --json`, one run on each tree, back to back on one 12-CPU host with the live services up: origin/main (31.18.1) took **561.9 s** (40,481 tests, 9 workers, pace 1.57). This tree took **619.7 s** (40,494 tests, 9 workers, pace 1.69). That is 10 % slower, not faster: the host's pace probe rose 8 % between the runs (load average 17–23 on 12 CPUs, a shared host), and both runs' ten slowest files are `cli`, `scripts` and PGlite files, which 17a did not touch. The waits 17a removed are each a few to a few hundred milliseconds, spread across 9 workers, so they are small beside the step's 9 minutes. Still owed: a per-file timing comparison (`--timings` with a `--shard` split) on a quiet host. The "measurably faster" condition is not met yet.

### Every `// real-clock:` line outside `cli`

55 lines; "17a" marks the 19 this sweep added. Each one waits on another process's clock: a server, a child process, the OS. `cdp-launch-probe.ts` is source, not a test.

| Site | Added | Reason, as written |
|---|---|---|
| `packages/cache/src/redis.live.test.ts:352` | before | Bun's reconnect loop and the server's socket close run on their own timers |
| `packages/core/e2e/version.e2e.test.ts:28` | before | Windows releases the just-exited binary on its own schedule, not this test's |
| `packages/core/src/image/raster-worker-compile.e2e.test.ts:31` | 17a | Windows releases the just-exited binary on its own schedule, not this test's |
| `packages/core/src/redis-client.live.test.ts:18` | before | Bun's reconnect loop and the server's socket close run on their own timers |
| `packages/db/src/concurrent-index.live.test.ts:158` | before | polling ANOTHER Postgres session's state; nothing here owns its timers |
| `packages/db/src/concurrent-index.live.test.ts:161` | before | past the 200 ms bound, while the build is still blocked on the reader |
| `packages/db/src/pglite-ready.test.ts:49` | before | a deadline on a boot that may hang — a pass never waits it out |
| `packages/db/src/replica-position.live.test.ts:34` | before | the standby's startup process pauses on its own schedule |
| `packages/db/src/replica-position.live.test.ts:90` | before | the standby replays WAL in its own process |
| `packages/entity/src/lock-keys.live.test.ts:70` | before | "still parked" has no event; only Postgres's lock queue, given time, can show it |
| `packages/entity/src/lock.live.test.ts:132` | before | "still parked" has no event; only Postgres's lock queue, given time, can show it |
| `packages/entity/src/lock.live.test.ts:160` | before | "still parked" has no event; only Postgres's lock queue, given time, can show it |
| `packages/http/e2e/idle-timeout.e2e.test.ts:23` | 17a | Bun's socket idle cut is the runtime's native timer, which no fake timer moves |
| `packages/http/src/rate-limit-postgres.live.test.ts:258` | 17a | another backend's transaction ends on its own time, not this test's |
| `packages/jobs/src/driver-pg-wake.live.test.ts:29` | before | a NOTIFY is delivered on the server's time, after another session's commit |
| `packages/jobs/src/driver-redis.live.test.ts:306` | before | Bun's reconnect loop and the server's socket close run on their own timers |
| `packages/jobs/src/events-tx-visibility.live.test.ts:127` | before | the backstop poll is due on the server's time |
| `packages/jobs/src/events-tx-visibility.live.test.ts:199` | before | the mark must be stamped after E0, on the server's time |
| `packages/jobs/src/events-tx-visibility.live.test.ts:309` | before | the commit's wake lands on the server's time |
| `packages/jobs/src/events-wake-race.live.test.ts:116` | before | a second Postgres session commits on its own time |
| `packages/jobs/src/events-wake.live.test.ts:188` | before | a NOTIFY is delivered by the Postgres server, so silence is waited for |
| `packages/jobs/src/events-wake.live.test.ts:193` | before | notifications arrive from the Postgres server's own process |
| `packages/jobs/src/events-wake.live.test.ts:195` | before | a third, unwanted notification would arrive from the server, if at all |
| `packages/jobs/src/events-wake.live.test.ts:230` | before | session b blocks inside the Postgres server until a commits |
| `packages/jobs/src/queue-wake-pooler.live.test.ts:107` | before | the verdict waits on a pooler's real silence, 50 ms of it |
| `packages/jobs/src/queue-wake.live.test.ts:39` | 17a | paces reads of a real server's state — a NOTIFY crossing a socket, a re-dial |
| `packages/jobs/src/scheduler-failover.live.test.ts:211` | before | the lease expires on the Postgres server's clock, which no test clock moves |
| `packages/realtime/src/channel-publish.live.test.ts:21` | 17a | a real nats-server delivers the frame on its own time, not this process's |
| `packages/realtime/src/nats-black-hole.live.test.ts:115` | 17a | measures how long the nats library takes to notice a held socket — its pings |
| `packages/realtime/src/nats-transport.live.test.ts:23` | 17a | a real nats-server answers on its own time, not this process's |
| `packages/realtime/src/nats-transport.live.test.ts:117` | 17a | the nats-server expires the key on its own per-message TTL |
| `packages/realtime/src/pg-advisory-lock.live.test.ts:73` | before | a closed client's backend exits on the server's time, not this process's |
| `packages/realtime/src/pg-advisory-lock.live.test.ts:175` | 17a | Postgres sends the FATAL to the terminated session on its own time |
| `packages/realtime/src/pg-connection.live.test.ts:138` | before | only a bound — a real walsender answers in one round trip, on its own time |
| `packages/realtime/src/pg-identity-window.live.test.ts:114` | 17a | the walsender decodes and streams the commit on its own time |
| `packages/realtime/src/pg-publication.live.test.ts:53` | 17a | bounds a TCP dial to a database host that may never answer |
| `packages/realtime/src/pg-replication-slot.live.test.ts:49` | before | a real postgres streams the WAL on its own time, not on any clock this test moves |
| `packages/realtime/src/pg-replication.live.test.ts:71` | 17a | the walsender streams a commit on its own time, not this process's |
| `packages/realtime/src/pg-replication.live.test.ts:108` | 17a | bounds a TCP dial to a database host that may never answer |
| `packages/realtime/src/pg-replication.live.test.ts:237` | 17a | the server's walsender exits, and releases the slot, on its own time |
| `packages/realtime/src/pg-tls.live.test.ts:166` | 17a | the walsender streams the commit over TLS on its own time |
| `packages/realtime/src/presence.live.test.ts:96` | 17a | the nats-server expires `lost` on its own per-message TTL |
| `packages/realtime/src/replicator.live.test.ts:30` | before | a real postgres streams the WAL on its own time, not on any clock this test moves |
| `packages/realtime/src/replicator.live.test.ts:188` | before | the slot is confirmed on the walsender's time, by a status update it reads |
| `packages/realtime/src/replicator.live.test.ts:226` | before | the slot is confirmed on the walsender's time, by a status update it reads |
| `packages/scraping/src/cdp-launch-probe.ts:63` | before | bounds a spawned process, not a timer a test arms |
| `packages/scraping/src/cdp-launch-relaunch.test.ts:195` | 17a | a forked shell child rewrites the profile every 20 ms while it lives |
| `packages/scraping/src/cdp-snapshot.e2e.test.ts:54` | before | awaits a spawned Chrome process, not a timer this test arms |
| `packages/scraping/src/cdp-snapshot.e2e.test.ts:119` | 17a | the deadline on a real Chrome child, which runs on its own time |
| `packages/scraping/src/pdf-render-slots.test.ts:42` | before | a watchdog on a hang, never a wait — a passing render settles first and clears it |
| `packages/testing/e2e/cdp-session.e2e.test.ts:153` | 17a | a second `online` would come from the real Chrome's own event loop, if at all |
| `packages/testing/src/drill-pg-blackhole.live.test.ts:97` | before | the pool's sweep, a blackholed socket and the server behind it keep real time |
| `packages/testing/src/pg-pin-unanswered.live.test.ts:37` | before | the pool's sweep and the blackholed socket keep real time |
| `packages/testing/src/pg-pin-unanswered.live.test.ts:88` | before | the delayed answer is the proxy's real wait |
| `packages/testing/src/rate-limit-store-blackhole.live.test.ts:52` | before | the blackholed socket and the store's deadline keep real time |

### Deferred to 17b: files that cannot rerun yet

`bun test --rerun-each 2` still fails the second load of 53 test files. Measured one at a time on this tree, `As of 2026-11-13`. W5's list named 55 files; `backfill-clock` and `backfill-throttle` rerun clean now. The seam (`packages/testing/src/rerun-declarations.ts`) deliberately covers only a file's own module body. The two files spot-checked, `entity/src/search.test.ts` and `testing/src/repro.test.ts`, declare inside a test instead, which a rerun replays. CI's `flaky` job runs the changed files with `--rerun-each 5`, so it goes red on any PR that touches one of these files until each has a restore seam.

| Code on the second load | Files |
|---|---|
| `X_DB_UNIQUE_VIOLATION` (1): the process driver keeps run 1's `fp_notes` row | `packages/testing/src/factory-persist.test.ts` |
| `X_ACTION_DUPLICATE` (13) | `packages/testing/src/exercise-actor-facts.test.ts`, `packages/testing/src/exercise-actor-user.test.ts`, `packages/testing/src/exercise-bind-queue.test.ts`, `packages/testing/src/exercise-drift-hint.test.ts`, `packages/testing/src/exercise-entry-kind.test.ts`, `packages/testing/src/exercise-input-statements.test.ts`, `packages/testing/src/exercise-input-throws.test.ts`, `packages/testing/src/exercise-request-pass.test.ts`, `packages/testing/src/exercise-request.test.ts`, `packages/testing/src/exercise-setup.test.ts`, `packages/testing/src/exercise-statement-ceiling.test.ts`, `packages/testing/src/exercise.test.ts`, `packages/testing/src/stub-action.test.ts` |
| `X_ENTITY_DUPLICATE` (12) | `packages/cli/src/templates/admin-catalog.test.ts`, `packages/entity/src/declared-index.test.ts`, `packages/entity/src/describe-indexes.test.ts`, `packages/entity/src/search.test.ts`, `packages/entity/src/version-lock.test.ts`, `packages/testing/src/factory-registry.test.ts`, `packages/testing/src/seed-graph-shared.test.ts`, `packages/testing/src/seed-graph.test.ts`, `packages/cli/src/app-load-graph.test.ts`, `packages/cli/src/verify-seeds-probe.test.ts`, `packages/cli/src/test-database.test.ts`, `packages/testing/src/scale-sweep-seed.test.ts` |
| `X_ERROR_CODE_DUPLICATE` (1) | `packages/mcp/src/recipes.test.ts` |
| `X_JOB_DUPLICATE` (8) | `packages/cli/src/repro-job.test.ts`, `packages/testing/src/fixture-jobs.test.ts`, `packages/testing/src/framework-fixtures.test.ts`, `packages/testing/src/job-crash-proof-bound.test.ts`, `packages/testing/src/job-crash-proof.test.ts`, `packages/testing/src/job-sim-soak.job.test.ts`, `packages/testing/src/job-simulate.test.ts`, `packages/testing/src/repro.test.ts` |
| `X_MAIL_DUPLICATE` (9) | `packages/mail/src/index.test.ts`, `packages/cli/src/cmd-mail.test.ts`, `packages/mail/src/envelope-address.test.ts`, `packages/mail/src/job.test.ts`, `packages/mail/src/layout-registry.test.ts`, `packages/mail/src/mail.test.ts`, `packages/mail/src/preview.test.ts`, `packages/mail/src/transform.test.ts`, `packages/testing/src/mail-driver-conformance-transports.test.ts` |
| `X_OAUTH_PROVIDER_DUPLICATE` (8) | `packages/auth/src/oauth-registry.test.ts`, `packages/auth/src/jwks-provider.test.ts`, `packages/auth/src/oauth-exchange-client-auth.test.ts`, `packages/auth/src/oauth-exchange-signature.test.ts`, `packages/auth/src/oauth-grant-context.test.ts`, `packages/auth/src/oauth-profile.test.ts`, `packages/auth/src/oauth-route.test.ts`, `packages/testing/src/fake-identity-provider.test.ts` |
| `X_SERVICE_DUPLICATE` (1) | `packages/cli/src/verify-role-load.test.ts` |

What fixes each: entity and job files already have their seam, so they only need their declarations hoisted into the module body or restored by the file's own `afterAll`. `action`, `mail`, `oauth`, `defineError` and `service` each need a forget/restore export in the package that owns the registry, landed lowest tier first. A `DeclarationRegistry` row in `rerun-declarations.ts` then consumes it.
