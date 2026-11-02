# 33-ops-ci — CI under five minutes, no tested bytes retested, no named flake left

> Part of [`overview.md`](overview.md). Depends on: [`30-perf-gate.md`](30-perf-gate.md) (splits the `cli` coverage unit, for the critical-path row). Tier: 5 (`cli`), plus `scripts/` and workflows.

## Why
Measured 2026-11-02 over the last 200 `ci.yml` runs (2026-10-24 to 11-02), wall time of green runs: p50 4.9 min, p90 5.2 min, against a 5-minute target. 34 runner-minutes per push.

| Finding | Measure |
|---|---|
| main pushes whose tree a green PR run already tested | **55 of 81** (head tree compared through the API). Each re-runs 34 runner-minutes and holds the demo image ~5 min. Two adopters carry a script for this |
| the critical path | `packages (2/2)`, p50 276 s, max 313 s. The `cli` unit alone took 299.4 s in one process; next unit in that shard 55.8 s. [`30-perf-gate.md`](30-perf-gate.md) splits it; nothing here does |
| main runs that needed a flake to clear | 5 of 81: 4 red, 1 rerun green. Owner rule: root-cause every one, never rerun until green |
| release proof that never ran | `v29.4.0`, run 41214625530: `npm-scaffold` red on `GET …/http-29.4.0.tgz` 404, after the audit passed. Package metadata is visible before the tarball |

## Decisions
| Question | Answer |
|---|---|
| Where the predicate lives | `x ci tested`, not a repo script: apps' CI has the same waste, and `wiki/CI-Parallel-Gate.md` hands them this workflow's shape |
| When a push counts as tested | subject ends `(#N)`; PR N is merged with this commit as its merge commit; head tree equals this tree; a same-repository `ci.yml` run on that head concluded `success`, under `--max-age` old (default 24 h: the runner image and registry move) |
| A doubt | `tested: false`, a full run. Exit 0 on every answer, reason printed. Any API failure widens the gate |
| Release commits | never reuse. A step `if:` on the subject prefixes `release-tag.yml` matches, so `release.yml`'s whole-run read stays a run of everything |
| A fork's lying workflow | not admitted: same-repository heads only |
| Drop `packages` as a duplicate of the unit shards | no. It answers isolation and the coverage bar (`ci.yml`, comment above the job) |
| Cache | unchanged. 10.5 GB of a 10 GB allowance, but the install cache hits on its primary key (run 41528680010) |

## Files to change
- `packages/cli/src/cmd-ci-spec.ts`, `cmd-ci.ts` — `subcommands: ['runs', 'tested']`, default `runs`, so `x ci …` is unchanged (`parse.ts:340`).
- `packages/cli/src/ci-tested.ts` (new) — pure predicate over injected `gh` reads; `ci-runs.ts` already spawns `gh`.
- `.github/workflows/ci.yml` — job `tested`; `needs: tested` plus `if` on `gate`, `verify`, `reference-app-verify`, `scaffold-smoke`, `container`, `packages`, `windows`. `deploy-proof` keeps its own due rule, never reused.
- `.github/workflows/deploy-social-demo.yml:127-144` — accept `skipped` only when the commit's `tested` check concluded `success`.
- `scripts/ci-workflow-shape.test.ts`, `scripts/lib/health-*` where a row reads job conclusions.
- `.github/workflows/release.yml` (`npm-scaffold`, the wait loop) — also wait for each package's `dist.tarball`.
- `scripts/registry-audit.ts` — one exported `tarballsServed()`, used by that step.
- Flakes: `packages/realtime/src/pg-advisory-lock.live.test.ts:56-59`, `packages/cli/e2e/client-navigation-swap.e2e.test.ts:97-103`, `scripts/lib/release-due-gh.test.ts:16`, `packages/cli/src/cmd-dev-restart.live.test.ts:71`.
- `wiki/CI-Parallel-Gate.md`, `wiki/CLI-Reference.md`, `packages/cli/README.md`, `packages/cli/CLAUDE.md`, `PUBLISHING.md`.

## Steps
1. `x ci tested [--max-age 24h] [--repo owner/name] [--json]` → `{ tested, reason, pr?, run? }`. Reads `GITHUB_SHA` or `HEAD`.
2. `tested` job: checkout, setup, step `if` not a release subject and `github.event_name == 'push'`. Output `tested`. `verify` becomes `!cancelled() && needs.tested.outputs.tested != 'true'`, needing both.
3. A skipped job's only cause is `tested`: true, or `tested` red, which reddens the run. The demo's read relies on that; the shape test pins that no other `if` sits on those jobs.
4. Tarball wait: `HEAD` every `dist.tarball`, inside the 40-attempt loop.
5. Flakes, each with a stress loop before and after (`for i in $(seq 50)`, with `--rerun-each` where it applies):

| Test | Red run | Cause | Fix |
|---|---|---|---|
| advisory lock, second holder | 40072958691, `Expected "1" Received "2"` | read: `pg_stat_activity` still lists a backend whose client just closed; exit is asynchronous | poll for count 1 under a deadline, on the admin connection |
| islands under an enforced CSP | 41515246191, `__disposed` undefined | suspected, unreproduced: the click beats island `a`'s boot, so nothing is disposed | wait for `__mounts.includes("a")` before the click. If the stress loop disagrees, re-diagnose; never only widen |
| `gh --version` through `run()` | 40168160875, 30.5 s on `windows` | a real binary spawned in a unit test, after the deadline was already raised (#854) | inject the spawn; assert the `run()` argument path. Delete the binary dependency |
| `x dev` restart, edited service | 40323842229 | **unknown**: the log carries no cause line | reproduce under the stress loop first. The fix follows the finding |

## Error codes
No new code. `x ci tested` answers a doubt as `tested: false`; `gh` absent is `x ci`'s existing refusal, read here as a doubt.

## Tests
- `packages/cli/src/ci-tested.test.ts` (unit): each of the four conditions false gives `tested: false` and names itself; a fork head; a stale run; a tree that moved; an API failure; all true.
- `scripts/ci-workflow-shape.test.ts` (unit): every reused job has the one `if`; `deploy-proof` has none; the release subject guard exists; the demo's read accepts `skipped` only beside `tested`.
- Failing-first for each flake: a test holding the delay open (a held close, a held boot) fails before the fix.
- `bun test packages/cli/src/ci-tested.test.ts`

## Semver
minor. New subcommand, `x ci` unchanged. Nothing reaches an app's runtime.

## Done when
- On a merge of an up-to-date green PR, `gate`, `packages` and the app jobs show skipped and the demo image publishes inside 3 minutes of the push.
- A release commit runs every job.
- `packages` p50 under 200 s and whole-run p90 under 5 min, over 20 runs on `main`.
- 20 consecutive green `main` runs with no attempt 2, and each flake's stress loop clean.
- A release's `npm-scaffold` passes with no rerun.
- `bun run verify` green.
