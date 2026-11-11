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
