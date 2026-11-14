# 10 — Test determinism: five flake classes, closed

> Part of [`overview.md`](overview.md). Depends on: none (runs after sweep 6 to avoid file overlap). Tier: tests.

## Files to change
17 of 441 commits since 2026-10-01 fixed a flake or a red `main`; 6 of the last 100 `ci.yml` runs on `main` failed. Test files touched, by area: `jobs` 50, `realtime` 46, `testing` 44, `cli` 34, `scraping` 23, `scripts` 22, `core` 17, `db` 11.

| Class | Evidence | Files |
|---|---|---|
| F1 ports: probe-then-bind, double `freePort` | `092c7cd38`, `3ea39eebb` | every test calling `freePort`; `packages/testing/src/` port helper |
| F2 browser launch deadlines (Windows) | `dcc21ed6f`, `be5b7edb8` | `packages/scraping/src/*.test.ts`, `packages/testing/src/` browser fixture |
| F3 bus subscribe ordering (NATS, Redis) | `3f6d1b24d`, `1618ab873`, #1132 | `packages/realtime/src/*.live.test.ts`, `packages/cache/src/*.live.test.ts` |
| F4 temp directories and background `git` | `e407c015a` (red `main`, 2026-11-14), `packages/cli/src/cmd-upgrade-refusals.test.ts:46` | `packages/cli/src/*.test.ts` |
| F5 wall-clock deadlines | `3f6d1b24d`, the OTLP drain | pins in `scripts/lib/test-real-sleep-pins.ts`; 4 e2e sleeps |

Also carried from 2026/11/11 slice 17 (`:240-244`): the flaky job's clean week, the `mock.module('node:*')` guard; from slice 16: G8, G13, G14 (30 files at 449–500 LOC).

## Steps
1. One helper per class in `packages/testing`, and one guard that refuses the unsafe form: F1 bind port 0 and read the port back (no probe); F2 one launch fixture with a readiness handshake instead of a deadline; F3 `subscribed()` awaited before publish; F4 one owner creates and removes each temp tree, and waits for child processes; F5 the injected clock.
2. Convert every call site by band (four workers, file-name bands disjoint). Each guard starts with a pin table, as `scripts/lib/test-real-sleep-pins.ts` does, and ends the sweep empty.
3. `.github/workflows/flake-hunt.yml`: nightly, the `unit` and `live` steps N times with shuffled file order; a failure files one issue per test with the seed. Free runners, outside the 5-minute budget because it is not a gate.
4. Split the 30 files near the line ceiling (G14).

## Tests
- Each guard has a failing-first fixture.
- The proof is step 3's run history, not a local pass. Never rerun to green; a rerun is a diagnostic.

## Done when
- Seven consecutive nights of `flake-hunt` with zero failures.
- The five pin tables are empty; `scripts/health.ts` reads the flake-hunt conclusion ([`12`](12-maintainer-loop.md) M4).
