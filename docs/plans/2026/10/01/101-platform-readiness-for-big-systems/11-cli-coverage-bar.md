# 11 — CLI: one coverage bar, ours and theirs

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5.

Rule: 95% line and function coverage is one bar for the framework's code and for every project
built on it. Lint and tests alone are not green. The floor only ever rises.

| Code | Bar today | After this slice |
|---|---|---|
| the 30 `@ultimat3/*` packages | 95% lines and functions, zero pins (`COVERAGE_PINS = {}`, `scripts/lib/coverage-pins.ts`) | unchanged — already held |
| `scripts/` (this repo's guards and tooling) | tested, no number | measured; gated at 95 or pinned at what it measures, pin deleted as tests land |
| `examples/dummy`, `dummy/social-media-clone` | no number | a stated floor each, through the app mechanism below |
| an app made with `x new` | no number | 95, written by the scaffold, enforced by `x verify` |

Evidence: the framework holds itself to it — `COVERAGE_TARGET = 95`
(`scripts/lib/coverage-pins.ts:29`), enforced per package by `scripts/coverage-gate.ts` and the
`packages` CI job — but an app's `x verify` runs its suites with no threshold at all: nothing
under `packages/cli/src/verify-*.ts` reads a coverage number. The surveyed SPA holds every
workspace at ≥95% lines with floors that may only go up, reconciled against the whole source
tree. The surveyed Ultimate app has 123k lines of tests and no number saying what they cover.

## Files to change
- `packages/cli/src/verify-floor.ts:18-43` — `VerifyFloor.coverage?: { lines: number; funcs: number; exclude?:
  readonly { glob: string; why: string }[] }`, read from `x.verify.json`: the file that
  configures the gate.
- `packages/cli/src/verify-tests.ts:82-86` and the `unit` step in `packages/cli/src/verify-checks.ts`
  — run the unit suite with coverage and hand the report to the check.
- `packages/cli/src/` (new `coverage-floor.ts`) — the measurement and the finding.
- `packages/cli/src/templates/` — `x new` writes `"coverage": { "lines": 95, "funcs": 95 }`: the
  same two numbers the framework holds itself to, not a softer bar for apps.
- `scripts/coverage-gate.ts`, `scripts/lib/coverage-pins.ts` — share the lcov reader with the CLI;
  one parser.
- `examples/dummy/x.verify.json`, `dummy/social-media-clone/x.verify.json` — a stated floor each.

## Steps
1. Measure the app's OWN source: every `.ts` / `.tsx` under `apps/` and `packages/` of the app,
   tests and generated files excluded. A file no test loads counts at 0% — the summary Bun prints
   averages only loaded files, which is how a suite reads 98% over an app it half covers.
   `scripts/coverage-gate.ts:4-9` records the same trap from the other direction; reuse its
   scoping.
2. It is a finding of the existing `unit` step, not a twenty-first step: `VERIFY_STEP_NAMES`
   (`packages/cli/src/verify-step.ts:16-54`) is as stable as an error code. Only the unit suite
   counts — it is the one every run executes; opt-in suites cannot hold a floor a default run
   must meet.
3. `X_COVERAGE_BELOW_FLOOR` (cli): cause states measured and floor to one decimal and lists the
   ten files that lose the most lines; fix is `bun test --coverage <the worst file's test path>`.
4. No floor stated → `X_COVERAGE_FLOOR_UNSTATED`, fix: the exact line to add to `x.verify.json`
   with the app's measured number. An app is never silently held to a default it did not write.
5. The floor only rises. Lowering `coverage.lines`, or adding an `exclude`, without a `why` is a
   finding in the same voice as `X_BUDGET_RAISE_UNSTATED`; read `bun run budget-raises` and reuse
   its mechanism rather than writing a second "stated change" detector.
6. `exclude` is for code a unit test cannot execute — an island's browser-only mount, a container
   entry point. Each entry carries its reason and is printed by `x doctor`.
7. Tracked apps: measure both. State each one's real number as its floor today; if either is
   under 95, the gap is listed in this plan's `status.yml` and raised by the slices that add
   their tests. Do not write 95 where the tree does not hold it.
8. The number is a floor, not the goal. Carry the framework's own rule into the scaffold's
   `AGENTS.md` and the wiki verbatim in meaning (`scripts/lib/coverage-pins.ts:13-27`): a test
   added to raise coverage is proven by mutation — break the source, watch it go red, restore.
   A covered branch whose test cannot fail is worse than an uncovered one.
9. `scripts/`: run the existing gate's measurement over `scripts/**` with its own tests. Add it
   to `scripts/coverage-gate.ts --all` as one more unit beside the packages, pinned in
   `COVERAGE_PINS` with a `why` if it measures under 95.
10. Cost: coverage instrumentation slows the unit step. Measure before and after on the reference
   app and state both in the PR; the downstream app's gate already doubled once (26.7 s → 55 s).
11. Semver: an existing app's gate goes red with `X_COVERAGE_FLOOR_UNSTATED` until it states a
   floor. Same owner ruling as the transport gate; see `overview.md` *Risks*.

## Tests
- `packages/cli/src/coverage-floor.test.ts`: a fixture app at 96% passes at floor 95 and fails at
  97; an unloaded source file drags the number down; no floor stated is its own finding; a
  lowered floor without a `why` is refused.
- `packages/cli/src/cmd-new.test.ts`: the scaffold's `x.verify.json` carries the floor.
- `scaffold-smoke`: a fresh app is green at 95 on what `x new` generates — the scaffold ships its
  own tests or it does not ship the floor.
- Command: `bun test packages/cli/src/coverage-floor.test.ts`.

## Done when
- Deleting one test file from a scaffolded app turns `x verify` red on `unit` with
  `X_COVERAGE_BELOW_FLOOR` naming the uncovered file.
- Both tracked apps state a floor; `bun run scripts/reference-app-gate.ts` green.
- `bun run coverage` reports `scripts/` beside the 30 packages.
