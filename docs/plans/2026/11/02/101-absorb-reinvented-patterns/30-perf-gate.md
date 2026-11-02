# 30 — Perf: the gate re-masks every file, and one unit sets CI's wall clock

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0 (`core`), plus `scripts/`.

## Why
**`errors` step.** Every guard re-masks every file. Profile of `bun run verify --only errors`: `blankRegions` plus `blank` (`core/src/source-mask.ts:115,122`) 42% of CPU, one regex (`LOCAL_DUCK_RENDERER`, `scripts/error-render.ts:301`) 16%. The mask ran 74,031 times for 11,298 distinct inputs. Patched in by preload, same box, consecutive runs at load about 10–40:

| Variant | Wall | User CPU | RSS |
|---|---|---|---|
| today | 33.5 s (50–54 s earlier, more load) | 30.2 s | 653 MiB |
| mask memo + regex pre-check | 16.6 s | 14.7 s | 1,000 MiB |

**CI wall clock.** Four recent green `main` runs: `packages (2/2)` 258–313 s, `packages (1/2)` 105–135 s. Run total 5m19s against the 5-minute target in `CLAUDE.md`, and that job is the last to finish. One unit is the reason: `cli` at 299.4 s in one `bun test --coverage` process, 450 s of summed test time over 540 files (`scripts/coverage-gate.ts:297`). Moving units between shards cannot help a single 299 s unit. The next longest job is `windows`, 231 s.

An app's `unit` step already solved this: `verify-coverage-run.ts` runs fixed slices, one plain `bun test` each, and folds the lcov (`coverage-lcov.ts:114`). 1,192 files, 8 processes, 56 s, per that file's header.

## Files to change
- `packages/core/src/source-mask.ts:151,154` — memo per function, capped.
- `scripts/error-render.ts:305` — `localDuckRenderers` returns early when `code` lacks `instanceof Error`; the regex needs that substring to match.
- `scripts/coverage-gate.ts:281` — `measure` runs `coverageSlices` when the unit has more than `COVERAGE_SLICE_FILES × 4` test files.
- `scripts/coverage-gate.ts:87,128` — `scopeLcov`, `unimportedSources` read a merged record list, not one report's text.
- `packages/cli/src/verify-coverage-run.ts:61`, `coverage-lcov.ts:114` — imported, not changed. The script already imports the leaf `coverage-lcov.ts`.
- `scripts/coverage-gate.ts:286` — the comment: `--isolate` stays refused, plain slices are not `--isolate`, and the one in-process boot rule (`cmd-dev.test.ts`) holds per process.

## Steps
1. Memo keyed on the text, one `Map` per mask, cleared whole when held input passes 128M UTF-16 units (the corpus is 55.6M). Clear-all and not LRU: a guard walks every file in order, and an LRU smaller than the corpus misses every time. The cap keeps a long `x dev` bounded.
2. The regex pre-check, with its reason in one line.
3. Coverage slices: `pool` the slices under the same `--jobs` the units use, so a shard never runs more than its core count. Fold with `mergeCoverage`, scope to the unit. A slice whose suite fails is the same `suiteFailure` finding, naming the slice's files.
4. `manifest` left alone: 75 s CPU and 2 GiB RSS is mostly the two `tsc` programs that typecheck tests and README fences. That is the function.

## Error codes
None. Existing `X_COVERAGE_UNMEASURED` and `X_COVERAGE_PIN_STALE`. A union can read higher than one process did, so a pin may need raising in this PR, with the number.

## Tests
- `core/src/source-mask.test.ts`: past the cap the map is cleared (exported test seam, or observed by object identity of the returned string); answers equal the unmemoized ones for an astral character and a regex literal.
- `scripts/coverage-gate.test.ts`: a unit over the threshold spawns more than one `bun test`, with a fake runner; a line hit only in slice 2 counts as hit; a failing slice is red. Each fails on today's code.
- `scripts/error-render.test.ts`: a file with a local duck renderer is still found.
- `bun test packages/core/src/source-mask.test.ts scripts/coverage-gate.test.ts`.

## Semver
Patch. Nothing public moves.

## Done when
- `bun run verify --only errors` takes at most 60% of its CPU today, on one box, both numbers in the PR.
- `packages (2/2)` under 200 s on CI, and the `ci` run under 5 minutes. **Expected, not measured**: the slices were not run here, because a 450 CPU-second suite was too heavy for the shared box.
- `bun run scripts/coverage-gate.ts --all` agrees with today on every unit within `PIN_SLACK`.
