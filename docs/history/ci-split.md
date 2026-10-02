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
| `gate` | 5 | one part of the framework gate: `unit` in three shards, `live` (every suite that needs a server, with the six static steps beside it), `e2e` (with the compiler) |
| `verify` | 1 | `x verify merge` over the five parts — the verdict, and the name `release.yml` reads |
| `reference-app-verify` | 2 | one tracked app: build, gate, ratchet |
| `scaffold-smoke` | 2 | one scaffold shape: default, `--no-example` |
| `packages` | 2 | half the packages, each tested and covered alone |
| `container` | 1 | unchanged |
| `deploy-proof` | 1 | unchanged, `main` only |

The pattern is the one `wiki/CI-Parallel-Gate.md` documents for an app: a matrix of parts, every
part uploading its `--json` document, one job merging them.

No static part. The first cut had two (`typecheck`, `errors`, `manifest` and `lint`, `boundaries`,
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
| branch protection | none: `main` is unprotected and has no rulesets (`gh api repos/developerz-ai/ultimate/branches/main/protection` → 404, `As of 2026-10-01`) | — |

If `main` is ever protected, the one required check is `verify`.
