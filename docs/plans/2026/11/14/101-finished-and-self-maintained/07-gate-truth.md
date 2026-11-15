# 07 — A gate that cannot pass on a skipped step

> Part of [`overview.md`](overview.md). Depends on: [`06`](06-ai-mail-scraping-ui.md). Tier: 5.

## Files to change
- `packages/cli/src/verify-floor.ts:1-4` — G1. `steps` in `x.verify.json` is a floor; a step left out may skip silently. No adopter lists all 21; `live` is absent in 6 of 9, `e2e` in 7 of 9.
- `packages/cli/src/verify-e2e.ts:1-5`, `packages/testing/src/test-types.ts:166` — G2. `e2eTest` skips with no browser driver and the step is green.
- `packages/cli/src/` `live` step + `packages/testing/src/` — G3. Three adopters built a real-Postgres runner because the embedded database hid driver bugs (a `uuid[]` decode) and `unitTest` has no conditional skip.
- `packages/cli/src/` coverage remap, `fixture-island.ts`, `island-outputs.ts` — G4. Island chunks cannot be source-mapped; three adopters lower or exclude coverage (carried: X9).
- `packages/cli/src/cmd-dev.ts:51` — G5. Binds `localhost` only; one adopter runs a TLS terminator and an IPv6 relay beside it.
- `packages/cli/src/cmd-planned.ts:27-115` — G6. Eight planned commands.
- `packages/cli/src/mcp-host.ts:125,353` — G7. Two stubs.
- Carried from 2026/11/11 slice 13/14: X5 template-database clone + `--shard`, X3 self-API loads, `x profile`, U1/U3/U4, the three missing generators; from slice 18: A12 route loads via `defineExercise`.
- `packages/cli/src/templates/` scaffold `x.verify.json` + CI workflow.

## Steps
1. G1: `x verify` prints, and returns in `--json`, every step that ran zero checks, as `skipped: <reason>`. A step named in the floor that ran zero checks is red today — extend that to a new `strict` key: with `strict: true` every one of the 21 steps must run or carry a written `why`. New scaffolds ship `strict: true`; existing apps get a warning naming the steps they never run. The default flips on `next`.
2. G2: with `e2e` in the floor and no browser, fail with a code whose fix installs or locates the browser. `x doctor` reports the driver.
3. G3: `live` runs in the default floor of a scaffolded app; `x verify` starts the test database itself when none is reachable (the compose file `x dev` already owns), so the fix is one command, not a runner. `unitTest` gains the declared service requirement the live suites use, replacing the adopters' runners.
4. G4: finish X9; island sources count in coverage.
5. G5: `x dev --host <addr>` and `--tls` (a generated local certificate), same flags on the built server. Loopback stays the default.
6. G6: per `90` OD3 of the previous plan — `x status` ships; `token grant`, `cache stats`, `jobs drain`, `db studio` each ship or leave the registry with a `wiki/Known-Gaps.md` row; `branch`, `ai`, `money` are removed on `next` ([`11`](11-compat-and-longevity.md) L1).
7. G7 and the carried items: finish each as its original slice file states.

## Tests
- `bun test ./packages/cli/src/verify-floor.test.ts -t 'strict'` — a floor missing a step fails without its `why`.
- `bun test ./packages/cli/src/verify-e2e.test.ts` — no browser + `e2e` in the floor is red, with the fix command.
- Scaffold smoke: a fresh app's first `x verify` runs every applicable step against real Postgres and a real browser on a clean runner (`scripts/scaffold-smoke-steps.ts`).
- Mutation: break the reference app's offline fallback; the gate must go red (the bug one adopter's own gate was written to catch).

## Done when
- `scaffold-smoke` in CI shows every applicable step with a non-zero check count for both shapes, and each other step excused with a written `skip` why: demoapp 20 of 21 (`roadmap`), bareapp 19 of 21 (`job`, `roadmap`). *Corrected 2026-11-15: "21 of 21" is unreachable in an app — `roadmap` applies only where `docs/idea/14-roadmap.md` exists (`verify-checks.ts`), and a bare app declares no job.*
- No adopter slice needs its own Postgres runner or browser gate.
