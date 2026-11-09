# CI: one runner per unit

Decided 2026-10-01, on the owner's instruction: split `ci.yml` across parallel free runners by
unit — "1 ci runner does the app a: lint, tests, code cov". It reverses one line of the root
`CLAUDE.md`, and only that line.

## What was reversed, and what was not

| Rule | Before | After |
|---|---|---|
| "lint, typecheck, boundaries and every suite are `verify`'s **steps**, never a second job" | one `verify` job ran the whole gate | the gate runs in parts, one per runner (`gate`), and `verify` merges them |
| axiom 1 — one way to do each thing | unchanged | unchanged: a part is `x verify --only <steps>`, the same step list, and no step runs twice |
| axiom 5 — one command means shippable | `bun run verify` | `bun run verify`, unchanged. CI's verdict is `x verify merge`, which is that command's answer over the parts |
| no `lint` / `typecheck` / `test` job **beside** the gate | forbidden | still forbidden — a job beside the gate re-runs a step; a part of the gate is the step |

The old rule's reason was cost: four jobs beside the gate re-ran what the gate ran (~2.2
runner-minutes) and added their slowest to the critical path through `needs`. A part re-runs
nothing, and nothing waits on a part except the merge.

## Why

Measured on the last six `ci.yml` runs before the split, seconds per job:

| Job | Range |
|---|---|
| `verify` | 307–362 |
| `packages` | 138–183 |
| `reference-app-verify` | 119–160 |
| `scaffold-smoke` | 65–116 |
| `container` | 24–58 |
| `deploy-proof` (main only) | 5–231 |

- `verify` alone was over the five-minute target the root `CLAUDE.md` states.
- It hit its 12-minute timeout twice on a push to `main` and delayed a release (#589).
- Two changes in flight make it slower: coverage instrumentation on `unit`, a schema-dump check on
  `drift`.

## The gate's steps, as the gate printed them

Run 36899716351 (`main`, 4-core runner, 2026-10-01). Wall 299 s; the step times sum to more
because the static steps run beside the serial suites.

| Step | Seconds | Tests ran |
|---|---|---|
| `typecheck` | 8.4 | |
| `lint` | 22.0 | |
| `boundaries` | 7.9 | |
| `filesize` | 20.8 | |
| `package-shape` | 17.4 | |
| `errors` | 37.2 | |
| `unit` | 179.9 | 19,608 |
| `contract` | 3.5 | 22 |
| `live` | 64.1 | 296 |
| `job` | 0.4 | 9 |
| `e2e` | 42.5 | 68 |
| `eval` | 0.2 | 2 |
| `manifest` | 34.8 | |
| the six app-surface steps, `roadmap` | 0 | skipped at the repo root, or instant |

Job overhead around it: 22 s service containers, 3 s checkout, 13 s setup, 8 s for the two
servers a `services:` block cannot start.

## The graph

| Job | Runners | What one runner does |
|---|---|---|
| `gate` | 6 | one part of the framework gate: `unit`, `contract` and `job` in three shards against one Postgres, `live` in two shards against every server, `static` (the six static steps beside `eval`), `e2e` (the compiler, then a browser) — as of 2026-11-09, below |
| `verify` | 1 | `x verify merge` over the six parts — the framework gate's verdict. `release.yml` reads the whole run's conclusion, which includes it (2026-10-03) |
| `reference-app-verify` | 3 | one tracked app: build, gate, ratchet — the docs site the third since 2026-11-06 (plan 101, 42-adopt-docs-site) |
| `scaffold-smoke` | 5 | one scaffold per runner: default, `--no-example`, and one per `x new --shape` (`api`, `blog`, `dashboard` since 2026-11-06), held to `NEW_SHAPES` by `scripts/ci-workflow-shape.test.ts` |
| `packages` | 2 | each unit tested and covered alone; `cli` in one shard, every other unit in the other (2026-11-05, below) |
| `container` | 1 | unchanged |
| `deploy-proof` | 1 | unchanged, `main` only |
| `fault-drills` | 1 | `x drill` on `examples/dummy` against one Postgres: `pg-blackhole`, `worker-sigkill`, `web-sigterm` — added 2026-11-06, below |
| `windows` | 1 | native Windows in PowerShell: lint, typecheck, a path-heavy unit subset, a scaffold smoke — added 2026-10-05, below |
| `changes` | 1 | can this diff reach the six jobs that read no prose? — added 2026-11-07, below |

The pattern is the one `wiki/CI-Parallel-Gate.md` documents for an app: a matrix of parts, every
part uploading its `--json` document, one job merging them.

No static part until 2026-11-09 (below), when `live` was split and a shard may name no other step.
The first cut had two (`typecheck`, `errors`, `manifest` and `lint`, `boundaries`,
`filesize`, `package-shape`), and they bought nothing: the runner already puts those steps BESIDE
the serial suites whenever `live` is in the list, where the slowest (37 s) fits inside `live`'s
64 s. Folding them into the `live` part removed two runners and four billed minutes without moving
the critical path.

Fixed cost of a part, measured on `main`: 7–11 s for checkout and setup — the install cache is a
34 MB restore keyed on `bun.lock`, and the install after it takes under a second — plus the
services where it starts any (22 s + 8 s before this change, for two servers by hand and two as
`services:`).

## What holds it

| Claim | Enforced by |
|---|---|
| the parts are the gate's step list, each step once, every shard of a split | `scripts/ci-workflow-shape.test.ts` (before a push) · `x verify merge` → `X_VERIFY_MERGE_INCOMPLETE` (after) |
| a part's flags are ones the repo gate accepts | `scripts/ci-workflow-shape.test.ts`, against `VERIFY_FLAGS` |
| `release.yml` still reads the verdict | same test: the check is named `verify`, and that job is the merge |
| `deploy-social-demo.yml` reads the demo app's own gate | same test: its `CHECK` is the matrix job's name for that app |
| every tracked app has a runner | same test: the matrix is `GATED_APPS` |
| a part starts only the services it exports URLs for | `scripts/test-services-shape.test.ts` |
| a suite that needs a service URL is run by a part that exports it | `scripts/test-services-shape.test.ts` |
| `windows` is the one non-Ubuntu runner, pwsh on every step, ≤ 25 min | `scripts/ci-workflow-shape.test.ts` |

## Trade

| | Before | After |
|---|---|---|
| critical path, pull request | 307–362 s | ~140 s expected: the slowest part (~115 s) plus the merge (~25 s) |
| jobs per run | 6 | 14 |
| runner-minutes as GitHub bills them (each job rounded up) | 16–19 | 23–26 |

More runner-minutes for less wall time, on free runners. The per-package matrix that was removed
on 2026-09-16 (32 jobs, 33 of ~40 runner-minutes) is not what this is: a job here is a unit of
real work measured in tens of seconds, never a five-second suite paying a minute.

## Job names

| Name | Reader | Changed |
|---|---|---|
| `verify` | `release.yml` `check` job; `PUBLISHING.md` | no — same name, now the merge |
| `reference-app-verify` | `deploy-social-demo.yml` | yes — the check is `reference-app-verify (<app>)`; the workflow reads `reference-app-verify (dummy/social-media-clone)` |
| `scaffold-smoke` | docs and wiki, by job id | no — the id is unchanged; the checks are `scaffold-smoke (demoapp)` and `scaffold-smoke (bareapp)` |
| `packages`, `container`, `deploy-proof` | none | ids unchanged |
| `windows` | none yet; `required` once green | new, 2026-10-05 |
| `fault-drills` | none | new, 2026-11-06 |
| branch protection | none: `main` is unprotected and has no rulesets (`gh api repos/developerz-ai/ultimate/branches/main/protection` → 404, `As of 2026-10-01`) | — |

If `main` is ever protected, the one required check is `verify`.

## Rebalanced, 2026-10-03

Measured on eight runs of 2026-10-03 (run 37101906027 among them), seconds per job: `packages (2/2)`
169–225 (one package, `cli`, is 168.6 s of it, covered in one process), `gate (live)` 129–157,
`reference-app-verify (examples/dummy)` 115–150, a `unit` shard 80–125, `gate (e2e)` 55–70.

| Change | Why |
|---|---|
| `contract` (12 s) and `job` (16 s) moved from `live` to `e2e`, which starts Postgres | `live` was the slowest part, and `verify` waits on the slowest part; both suites read only `TEST_DATABASE_URL` |
| services started before `setup`, waited for after it | the pull (10–20 s) and the cache restore (4–9 s) no longer add up |
| a part's `--json` document is uploaded, never printed | a red one is a single line over 1 MB, and the Actions log dropped it and the step table after it (run 37103688822) |
| the step table, its `(fail)` test names and the merged verdict go to the job summary | a red run names its step and `fix:` on the run page |

The run's wall time is still `packages (2/2)` until `cli`'s coverage is split across processes
(`scripts/coverage-gate.ts`), which is outside this change — done 2026-11-05, below.

## Rebalanced again, 2026-11-05

Measured on main, the two full runs of 2026-11-05 (41965364111, 42032367633), seconds per job: `packages (2/2)` 318–451, `gate (e2e)` 245–283, `gate (live)` 219–256, a `unit` shard 112–197, `packages (1/2)` 108–118. Two jobs at or past the five-minute target.

| Change | Why |
|---|---|
| `contract` and `job` moved from `e2e` into the three unit shards: `--only unit,contract,job --shard i/3` | `e2e` is serial by design and cannot be split; both suites are in `SHARDABLE_STEPS` and read only `TEST_DATABASE_URL`, which every unit shard starts. `x verify merge` folds each step's three slices on its own; an empty slice (fewer files than shards) is a pass with zero tests, the floor applied to the sum (`verify-merge.test.ts`, "three parts, each a slice of unit, contract and job") |
| a unit with more than 200 test files runs on `bun test --parallel=<n>`, every file isolated, leasing n cores (`scripts/lib/coverage-schedule.ts`) | `cli` alone was the critical path. Bun folds the workers' coverage by function identity, so the reading is the one-process reading (`scripts/coverage-gate-parallel.test.ts`). `--no-isolate` was refused: which files share a worker is the clock's choice, and two suites went red that way |
| `--shard` deals units by measured core-seconds (`UNIT_SECONDS`), heaviest first | round-robin by name put `cli`, `jobs`, `testing` and `entity` in one shard; by weight `cli` gets a shard to itself |
| each unit's `bun test` gets the env minus every `docker/test-services.env` URL and `DATABASE_URL` | the pins are measured with no services, so a laptop that sourced the env file read a number of its own; and side-by-side units handed one `TEST_DATABASE_URL` would each clone and `DROP … WITH (FORCE)` `ultimate_test_template_w1` (`packages/testing/src/template-db.ts`) |

Local, not CI: one box, 8 cores, pinned to four with `taskset -c 0-3`, shared with other work, Bun 1.4.4.

| Run | Before (main's script) | After |
|---|---|---|
| `--all --shard 1/2` | 81 s | 249–286 s — `cli` alone, four workers |
| `--all --shard 2/2` | 402 s — `cli` one process, beside 15 units | 129–159 s — the other 31 units |
| `cli` alone | 432 s, one process | 286 s, four workers; 793 s user CPU |

The critical path moves from ~400 s to 250–290 s here. Not yet a CI number: the runner may be slower than this box, so `packages (1/2)` can still sit at the five-minute target. What is left is `cli`'s own tests — the `x upgrade` hop (30–72 s) and the scaffold `tsc` runs — not the gate.

## Measured, and what moved, 2026-11-07

Run 42323662996 (a green PR, 22 jobs, wall 389 s), per job and per step from the Actions API. Fixed
cost is small: checkout 3–5 s, setup 6–17 s (Windows 29 s), services ready 3–12 s. The time is the
work, and the work is single-pole:

| Job | Wall | Where it goes |
|---|---|---|
| `packages (1/2)` | 378 s | `cli` alone, 364.2 s on 4 workers (`ceil(664 files / 200)`): the run's end |
| `gate (live)` | 334 s | `live` 302 s, one serial `bun test`, with the six static steps beside it for their first 95 s (`errors` 95, `manifest` 97, `filesize` 61, `package-shape` 59, `boundaries` 57, `lint` 36) |
| `gate (e2e)` | 275 s | `typecheck` 20 s, `e2e` 229 s, serial |
| `windows` | 274 s | setup 29 s, lint 24, typecheck 23, seven unit steps ~105 s one process each, scaffold setup + verify 68 s |
| `reference-app-verify (examples/dummy)` | 261 s | the ratchet script, 242 s |
| `gate (unit-1/2/3)` | 256 / 223 / 179 s | `unit` 200 / 153 / 117 s: round-robin by file, not by time |
| six prose-blind jobs | ~1,120 runner-s | `windows`, `macos`, five `scaffold-smoke`, `fault-drills`, `container`, `compose-deploy` |

| Change | Why |
|---|---|
| `changes` job, beside `tested`: `scripts/ci-changes.ts` classifies `git diff --no-renames`; `heavy=false` only when every path is `wiki/**.md`, `docs/**.md` or root `*.md` | a prose-only diff re-proved ~19 runner-minutes of bytes it never touched. The six jobs skip on an explicit `false` only, so a red, cancelled or silent `changes` is a full run (`scripts/ci-workflow-changes.test.ts`) |
| the gate, `verify`, `packages` and every `reference-app-verify` never read it | `x verify merge` is red for a step no part reported, and `errors`, `manifest` and the citation tests read exactly these files; the docs site builds the wiki |
| not a workflow `paths:` filter | that leaves every check of the workflow pending forever; a skipped job concludes |
| `windows`: the seven unit steps are one `bun test --isolate --parallel` | ~105 s on one core of four; `x verify`'s unit step already runs `--parallel` green on the same runner |
| the bun install cache keyed on `bun.lock` alone, no `restore-keys` (`.github/actions/setup/action.yml`, held by `scripts/ci-workflow-cache.test.ts`) | the fallback restored the previous lock's cache and saved it again with the new packages on top, so the entry only grew: 34 MB (2026-10-01) → 168 MB → 287 MB, restored in every job. A lock change now costs one cold install per job of that run |

Not done here, each with the measurement that decides it:

| What | Where | Expected |
|---|---|---|
| split `cli`'s files across two `packages` runners and fold their lcov | `scripts/coverage-gate.ts` | **blocked on Bun's lcov, measured 2026-11-07**: it carries `FNF`/`FNH` counts and no `FN:` records, so lines union exactly across runners and functions only as a per-file max, a lower bound. `db` whole against two halves folded: lines 8180/8428 both ways; functions 1197 → 1182 (−1.19 points) split by name, 1189 (−0.63) with each subject's tests kept together. `cli` clears the 95% bar on functions by 0.43, so a split reads red over unchanged coverage, or needs a lower bar. Reopens when Bun writes `FN:`/`FNDA:` |
| `live` and `e2e` shardable across runners (`SHARDABLE_STEPS`), and a merge that can read a step skipped by path | `packages/cli/src/verify-shard.ts`, `verify-tests.ts`, `verify-merge.ts` | `gate (live)` 334 s → ~170 s on two; a prose-only PR could then skip `live` and `e2e` too. `live` split 2026-11-09, below |

## `live` in two shards, a static part, 2026-11-09

Measured on main (runs 42447766689, 42480668181, 42540901591), seconds per job: `packages (1/2)`
363–408 (`cli` alone, 392 s on four workers), `gate (live)` 333–347 (`live` 280–302, serial),
`packages (2/2)` 216–339, `gate (e2e)` 220–248, a `unit` shard 218–264. Wall 6 m 21 s – 7 m 10 s.

| Change | Why |
|---|---|
| `live` → `live-1`, `live-2`: `--only live --shard i/2`, every service in both | `live` was one serial `bun test` and `SHARDABLE_STEPS` already lists it; ~300 s → ~150 s a shard |
| every part running a step must supply its services (`scripts/lib/test-service-coverage.ts`) | a suite lands on the shard the sorted file list deals it, so "some part exports Redis" let a shard without Redis skip whatever Redis suite it got |
| a `static` part: the six static steps, `eval` and the steps that apply only to an app | a shard refuses a non-shardable step (`X_VERIFY_SHARD_INVALID`), so they left `live` |
| the static steps run BESIDE the first serial suite listed, not only `live` (`packages/cli/src/verify-run.ts`); `eval` is that suite in `static` | alone they were serial: the sum of six whole-tree scans, ~400 s. Beside `eval`, the slowest: `manifest` 99 s. Pinned by `verify-run-overlap.test.ts` |
| `packages` NOT re-sharded | `cli` is one unit and the critical path by itself; a third shard moves the other 31 units, not `cli`. The split is the row above (blocked on Bun's lcov) |

Expected: the gate's slowest part ~200 s; the run's end is still `packages (1/2)` at 363–408 s —
over five minutes until `cli` can be split across runners.

Re-measured 2026-11-09, Bun 1.4.4: is the `cli` split still blocked? Yes. A two-file probe still
writes `FNF`/`FNH` and no `FN:`/`FNDA:` records. Then all 778 of `cli`'s test files ran whole and in
two halves, each run `bun test --coverage --parallel=4` with no `TEST_*` URLs. The halves were folded
by `mergeFileCoverage` (`packages/cli/src/coverage-lcov.ts`), the fold `x verify merge` uses.
`cli`'s own sources:

| Run | Lines | Functions (hit / found) |
|---|---|---|
| whole, one `bun test` | 94.95 | 94.79 (5658 / 5969) |
| two halves, contiguous in sorted order, folded | 94.94 | 94.25 (5623 / 5966) |
| two halves, round-robin, folded | 94.94 | 93.57 (5576 / 5959) |

The tree was mid-edit and some suites were red in all three runs, so the whole run reads under CI's
96.07 / 95.48. The three runs share that tree, so the gaps between them are what matters.
Lines fold to within 0.01, as `mergeFileCoverage`'s comment says. Functions lose 0.54–1.22 points
(35–82 functions), because a file whose functions are split between the halves keeps only the
better half. CI reads `cli` at 95.48% functions, 0.48 points over the 95% bar: either split reads
red over unchanged code. The halves were also uneven (229–255 s against 407–449 s on a shared
12-core box), so a split by file count would not halve the wall time anyway. Reopens when Bun's
lcov carries function identity; until then `packages (1/2)` holds the run over five minutes.

## Fault drills, 2026-11-06

`fault-drills` asks one question no other job can: does the reference app keep the framework's
declared behaviour while a dependency fails (plan 101 / 40, `x drill`). Not a gate part — the gate
needs nothing, a drill needs a real Postgres — and reused through `tested` like every job a green
PR run already answered.

| Choice | Why |
|---|---|
| three of the eight drills | the 5-minute budget, measured locally 2026-11-06: `pg-blackhole` 67 s, `worker-sigkill` 49 s, `web-sigterm` 6 s. `pg-slow` 68 s and `pg-restart` 98 s held too; they run by hand |
| `redis-down`, `nats-down` not run | `examples/dummy` declares no `redis` tier and an in-memory transport: refused `X_DRILL_SERVICE_MISSING`, never green over nothing |
| Postgres alone | the only service the three dial |
| one document per drill, uploaded | the `--json` verdict is the evidence; the log gets each summary and every finding's fix |
| the reverted-fix proof is a test, not a CI drill | `packages/testing/src/drill-pg-blackhole.live.test.ts`, in the gate's `live` part: the unanswered-statement bound off through the pool's own seam turns `pg-blackhole` red |

## Windows, 2026-10-05

Plan 101 sweep 8 (`docs/plans/2026/10/04/101-squeaky-clean-sweep/08-windows.md`, W6): native
Windows — PowerShell, no WSL — is a supported platform, and a `windows-latest` job is what says
so. Free, because the repository is public. It is not a part of the gate and not a job beside it
in the sense this page forbids: its question is the platform, which no Ubuntu runner can answer.

| Rule | Why |
|---|---|
| `shell: pwsh` on every step; the setup composite installs in pwsh on Windows | Git Bash ships on the image and would run a bash dependency in silence |
| checkout with the runner's default `core.autocrlf` | that is a contributor's clone; `.gitattributes` has to make it LF |
| a path-heavy unit subset, `./`-prefixed, not the full suite | ~2× slower runner, 25-minute budget; bare (no `./`), `packages/core` also selects `examples/dummy/packages/core` |
| `continue-on-error: true`, outside `verify`'s `needs` | lands red first so the sweep's rows can watch it turn green; flipped to required in the diff that makes it green |

## The other workflows

Moved out of root `CLAUDE.md` on 2026-11-03 to make room for the facts `AGENTS.md` carried alone
when it became a symlink to `CLAUDE.md`. `ci.yml` runs on pushes to `main`, `next` and `release/*`.

| Workflow | Trigger → what it does |
|---|---|
| `release-tag.yml` | green `ci` push of a release commit to `main` or `release/*` at an untagged version → annotated tag, Release, `release.yml` dispatched |
| `release.yml` | that dispatch or a **published** Release → npm via OIDC, after `check` |
| `registry-audit.yml` | daily → a `registry-drift` issue on disagreement |
| `deploy-social-demo.yml` | green `ci` on `main` → the demo image |
| `deploy-docs-site.yml` | green `ci` on `main` → `dummy/docs-site`'s static build on GitHub Pages; **inert** — every job skipped — until the owner sets the `DOCS_SITE_ORIGIN` repository variable (`scripts/ci-workflow-shape-docs.test.ts`) |
| `wiki.yml` | push to `main` → the wiki |
| `tutorial-run.yml` | push to `main` touching a tutorial or a generator → tutorials 1–4 fence by fence, `X_DOC_TUTORIAL_DIVERGED`; never on a PR, never in `ci` |
| `bench.yml` | weekly + release → re-measured first-hour/http-hello JSON as a PR; never in `ci` |
| `workflow-lint.yml` | push or PR touching `.github/**` → zizmor 1.32.0 at `medium` and above, online audits (impostor commits, advisories) included; a deliberate finding is suppressed in place with its reason. Its own workflow so a path filter can gate it; not a required check, so the filter never leaves one pending (added 2026-11-09) |
