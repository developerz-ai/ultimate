# 31 — Where a green test run says less than it reads

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5 (`cli`, `testing`); test-only edits in 0–4.

## Why
Measured 2026-11-02 by mutating a copy of the source: 380 single-line mutants sampled across `core`, `entity`, `jobs`, `action`, `http`, `realtime`, `ui`, against the tests naming each file, then each high-value survivor against its whole package; 73 more in `query`, `auth`, `http`, `policy`, `entity`. 279 of 375 died first pass, and about half the rechecked survivors died under the wider run. Many of the rest are equivalent. The suite is strong. The holes that remain are specific:
| Hole | Reproduced |
|---|---|
| An audited read's `seek()` | `query/src/audit-gate.ts:118` stripped of its wrapper: 670 pass, 0 fail. An MCP page read could go unrecorded under a green suite |
| A second-factor attempt's tenant budget | `auth/src/mfa-challenge.ts:114` deleted: 809 pass across `auth` and CLI/admin MFA tests. The twin at `auth/src/auth.ts:330` fails 3 tests |
| A `Blob` download with a range | `query/src/download-http.ts:190` inverted, shipped in the last minor: 774 pass |
| `isActorKind` accepting any string | `core/src/actor.ts:181` `&&`→`\|\|`: 1437 pass across `core`-consuming `query`, `auth`; it guards a signed token's fields at `query/src/download-token.ts:171,178` |
| `hostDecision` on an empty host | `core/src/host-rules.ts:96` flipped: 33 pass. `file:///x` under an any-host rule |
| Catch-up runs of a task | `jobs/src/scheduler-occurrences.ts:39` `<`→`<=`: one over `maxCatchUp`, whole `jobs` package green |
| Who decided a policy denial | `policy/src/evaluate.ts:90`, either operator: survives. `or(...)` reports the wrong leaf |
| Rollback of a primary-key move in the memory driver | `entity/src/memory-repo.ts:171` |
| A scaffolded slice's cache tag | `invalidates` deleted from a generated action: green. 11 of 13 other scaffold mutants died (policy, order, limit, tenant, key, retry, step) |

Three more, not mutation:
- **A mostly skipped suite is green.** `verify-run.ts:276` and `verify-merge.ts:322` fail only when `tests.ran === 0`. Probe: a scaffolded app, 9 of 17 contract tests behind `skipIf(!process.env.TYPO)`: `"ok":true … "tests":{"ran":8,"skipped":9}`. Adopters gate 37 and 23 such sites on a database URL. Without services the framework's `entity` run is 204 of 1552 skipped.
- **A unit test is red on one kernel.** `realtime/src/socket-wire.test.ts:10` assumes 40 × 150 kB overruns a 1 MB buffer. On `tcp_wmem` max 16 MB the kernel takes it all: 0 dropped, fails 6 of 6 at HEAD. With 200 frames it passes 3 of 3.
- **The framework never runs the mode its apps run.** Apps get `--no-isolate`; `x.verify.json:2` says `"isolate": true`. Same files, one process each way: `core policy action query` and `entity http cache` 0 failures; `jobs realtime` 89 s against 145 s, identical; `ui render db` 55 s against 108 s, identical; `auth mcp ai testing` 75 s against 143 s with 33 more failures; `mcp` alone 0, `auth mcp` 0, `ai mcp` 27, so a neighbour leaks into `mcp`.

## Decisions
| Candidate | Outcome |
|---|---|
| Mutation testing as a gate step | **killed.** Hours per run on free runners. `scripts/lib/coverage-pins.ts:24` already states the rule; this slice pays the debts found |
| Assertion-free-test guard | **killed.** Heuristic hit 94 of 23,525 framework tests and 0.5% or less in three adopters; sampled hits assert in helpers |
| Shipping the real-sleep guard to apps | **killed.** Adopters: 7, 18, 13 sites. Ratchet stays the framework's (`scripts/test-real-sleep.ts`) |
| Fixed-port guard | **killed.** No fixed-port bind in any framework test |
| Enforcing "unit means no I/O" | **killed.** 92 unit-suffixed files open a database, 59 spawn, and the coverage floor counts `unit` alone by design. The doc row is what is wrong |
| Slow-suite work | **killed.** 2,552 files, 1,327 s; top 50 files 33%, slowest 23 s. No single fix. The flip below is the lever |
| Property tests, cassettes | stay deferred, [`90-deferred.md`](90-deferred.md). No new evidence |

## Files to change
- `packages/query/src/audit-surfaces.test.ts:142`, `packages/query/src/download-http.test.ts:159`, `packages/auth/src/` (new `mfa-org-budget.test.ts`), `packages/core/src/actor.test.ts`, `packages/core/src/host-rules.test.ts`, `packages/policy/src/evaluate.test.ts`, `packages/entity/src/memory-repo-rollback.test.ts` (new), `packages/jobs/src/scheduler-next-run.test.ts` — one failing-first test per row.
- `packages/realtime/src/socket-wire.test.ts:10,52` — send until `droppedFrames > 0`, bounded, so the premise is observed.
- `packages/cli/src/templates/action.ts:139` — the generated unit test asserts `cache.invalidates` when the action declares it.
- `packages/cli/src/verify-floor.ts:54`, `verify-run.ts:276`, `verify-merge.ts:322` — the ceiling below.
- `x.verify.json:2`, the failures it exposes in `packages/mcp/src/` — the flip.
- `wiki/Testing.md:10,20,21` — false today: `bun test --workers 8`, per-file truncate or savepoint, `--keep-db`; `docs/idea/10-testing.md:15,24` says so, and no CLI source holds `keep-db`. `wiki/Testing.md:101`, `docs/idea/10-testing.md:82` — the `unit` row names the migrated-database recipe. `docs/idea/10-testing.md:132` — "fails until filled in" is false; generated tests run and pass.

## Steps
1. Hole tests first, one commit each, each proven by its mutant above.
2. `"skipCeiling": { "<step>": <n> }` in `x.verify.json`, optional. Over it, the step fails. Judged by `x verify merge`, and by a whole `x verify` when `CI` is set; a laptop without services stays a dev loop, as Bun treats `test.only`. Same precedent as `E2E_BROWSER_REQUIRED`.
3. `x new` writes no ceiling: a new app has nothing to hold. The finding on a green CI run names the measured number to write.
4. Flip the framework to `"isolate": false` only once `x test unit` passes without it. Fix the leak in `mcp`'s neighbours at the file boundary if the boundary is what missed it, since an app gets the same miss. Measure `cli` then, which this sweep did not run. If `cli` stays red after that, leave the flag, keep the fixes, and record the number in `wiki/Testing.md`.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_VERIFY_SKIPS_OVER_CEILING` | a step skipped more tests than `skipCeiling` states | `x test <step> --json`, then set what the suite skips without, or raise `skipCeiling` with the reason in the diff. `bun run new-error-code`, tier 5, neither status flag |

## Tests
- Each hole: unit, beside its source; `bun test <file>`. Each must fail on its mutant.
- `packages/cli/src/verify-floor.test.ts`, `verify-merge.test.ts` (unit): over and at the ceiling, shard sum, `CI` unset is green, a non-number is `X_CONFIG_INVALID`.
- `packages/cli/src/templates/action.test.ts`: the generated test goes red when the tag is deleted, run for real as `scaffold-gate` does.

## Semver
minor. `skipCeiling` is optional; the template only adds an assertion to newly generated files. Nothing in `wiki/Upgrading.md`.

## Done when
- Each table row's mutant fails its new test; the PR lists them.
- `bun test packages/realtime/src/socket-wire.test.ts` is green on a 16 MB `tcp_wmem` box.
- `grep -n 'keep-db\|--workers 8' wiki/Testing.md` is empty.
- `bun run verify` green, and `bun run scripts/reference-app-gate.ts` green.
