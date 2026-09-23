# 14 — guards and the gate: one corpus, one ratchet, and no green on nothing

> Part of [`overview.md`](overview.md). Depends on: none (it only touches `scripts/`, `packages/cli/src/verify-*`, `biome.json`). Can start any time.

Rule: the tree is read and masked once per process. A guard that scanned below its floor refuses
to answer. A ratchet pin that goes **up** needs a stated reason, the same shape as budgets.

Evidence (measured 2026-09-23, 12 cores):
- `bun run verify` takes 3m19s wall; CI's verify job takes 249 s.
- Wall time per step: unit 107 s, errors 59 s, live 52 s, lint 32 s.
- `biome lint` takes 41 s with `nursery/noFloatingPromises` and 8.5 s without it.
- About 20 whole-tree guards each glob and mask separately. `collectSourceFiles` alone is called from 23 places at 0.33–0.46 s each.
- The same tree yields 5 different corpus sizes: 5,250 / 5,022 / 4,890 / 3,474 / 3,223.
- `scripts/*.test.ts` sums to 268 s.

## Files to change

| # | Change | File:line |
|---|---|---|
| a | `bun run verify --only <step>` silently runs all 20 steps. Forward `--only` (validated against `VERIFY_STEP_NAMES`) and refuse unknown flags with `X_CLI_BAD_FLAG` | `scripts/verify.ts:305-310` |
| b | `scripts/lib/corpus.ts`: named scopes (`shipped` = `packages/*/src` minus tests, `tests`, `apps`, `scripts`, `docs`), each read and masked once per process with `packages/core/src/source-mask.ts`, cached. Each scope has a **floor** (e.g. `shipped ≥ 1000` files) and refuses `X_CORPUS_UNSCANNED` below it. Every guard moves onto it. Delete the 7 spellings of `'packages/*/src/**/*.{ts,tsx}'` (`flight-copies.ts:20`, `frozen-records.ts:273`, `render-modes.ts:318`, `config-readers.ts:76`, `declaration-readers.ts:64`, `lib/i18n-scan.ts:15`, `lib/browser-barrel-set.ts:25,126`) | new `scripts/lib/corpus.ts`; `scripts/boundaries.ts:272` `collectSourceFiles` |
| c | delete the private maskers: `error-render.ts:126` `maskToCode`, `lib/i18n-scan.ts:36` line stripper (and its `TEST_FILE` at `:17`, use `isTestPath`), and the double pass at `flight-copies.ts:99,123`. Delete the two `closingParen` copies (`secret-compare.ts:117`, `finite-bounds.ts:209`) in favour of `lib/balanced-paren.ts` | listed |
| d | merge `error-render`, `catch-render` and `fix-shell-arg` into one render rule with three checks over one pass (together about 30 s today). Keep the three `bun run` aliases and the codes | `scripts/error-render.ts`, `scripts/catch-render.ts`, `scripts/fix-shell-arg.ts` |
| e | merge the zero-pinned "one home for X" rules into one table of `{ pattern, home, code }`: `render-modes`, `flight-copies`, `sql-literal-copies`, `async-context-guard`, `dead-docs-host` (widened to `*.yaml`, `*.yml` and `*.md` URLs, catching `docker/helm/Chart.yaml:16`) | new `scripts/one-home.ts` |
| f | `scripts/lib/ratchet.ts`: `defineRatchet({ prefix, pinsFile, shape })` yields over/stale/unscanned findings and `--unpin`. Delete the 13+ hand-rolled gap unions, `*PinnedFor` and regex `apply*Unpin` (`lib/dead-docs-host-pins.ts:33`, `lib/proto-index-pins.ts:116`, …). `packageOf` moves out of `test-fix-citations.ts` into `lib/` (10 guards import it from a guard) | `scripts/lib/*-pins.ts`, `scripts/lib/unpin.ts` |
| g | **`pin-raises`**: a pin row higher than at `origin/main`'s tip needs `why:` on the row, else `X_PIN_RAISE_UNSTATED`. It has the same shape and fetch as `budget-raises`. History shows silent raises: secret-compare 53 → 63, `node-import-pins` 3→12, `proto-index-pins` 1→9 | new `scripts/pin-raises.ts`, wired as a `unit` step check |
| h | delete the empty pin tables (catch-render, dead-docs-host, declaration-readers, index-of-order, doc-config-keys) and `test-typecheck-pins.ts`'s 30 zero rows. A zero-pinned rule enforces outright | `scripts/lib/*-pins.ts` |
| i | `budget-raises` compares nothing without `origin/main`, including on a tag checkout in `release.yml`. When the ref is missing, fetch it (`git fetch --no-tags --depth=1 origin main`) or refuse `X_BUDGET_BASE_MISSING`, never pass | `scripts/budget-raises.ts` |
| j | lint cost: scope `nursery/noFloatingPromises` to `packages/*/src/**` excluding tests. Add `!**/.codegraph`, `!**/dist` to `files.includes` | `biome.json:57` |
| k | move `manifest` into the static group so it runs beside `live` | `packages/cli/src/verify-run.ts:132` |
| l | `scripts/manifest.test.ts` builds the manifest ~4× (`:27,53,290-296`). Build once in `beforeAll` | `scripts/manifest.test.ts` |
| m | stale claim: "the whole gate costs ~18s" | `packages/cli/src/verify-step.ts:83` |
| n | a gate step refusing "unreleased" next to a version that has a dated `CHANGELOG.md` heading (about 90 stale lines today, slice 17) | new rule in `scripts/changelog-check.ts` |
| o | `llms.txt` claims to be generated and is not (notify is missing). Write a generator from `scripts/list-workspaces.ts` and the wiki sidebar, plus a drift check `X_LLMS_TXT_DRIFT` | new `scripts/llms-txt.ts`; `llms.txt` |
| p | `CLAUDE.md` byte ceiling: refuse root `CLAUDE.md` above 16 KB, and a package `CLAUDE.md` above 24 KB (a ratchet, since several are 40–60 KB today) | new rule, paired with slice 17 f |
| q | one import scanner: delete `boundaries.ts`'s copy (its own header, `:15-23`, proposes this) and move `workspace-graph.ts:151` (regex, the cause of #493), `lib/import-closure.ts:36-38`, `side-effects-scan`, `server-barrels` and `transport-calls` onto `app-boundaries.ts` `scanRuntimeImports` (transpiler). Closes #493 | listed |

## Steps
1. a (one-line fix, immediate payoff), then j and k.
2. b: land the corpus, then migrate guards one PR at a time. Each migration PR shows the guard's file count before and after; the count must not drop.
3. g before f, so the ratchet rewrite cannot raise a pin unnoticed.
4. c, d, e, h, q as deletions on top of b/f.
5. n, o, p alongside slice 17.

## Tests
- Each guard's `*.test.ts` keeps its violation fixtures. Add one shared test that runs every guard against a temp root where `packages/` is unreadable and expects `X_CORPUS_UNSCANNED`, never exit 0.
- `bun run verify`, timed before and after in the PR.

## Done when
- `bun run verify --only lint` runs one step.
- No guard exits 0 on an empty corpus.
- A raised pin without `why:` fails.
- The gate is at least 30% faster in wall time on the same machine.
- `scripts/` is at least 1k LOC smaller.
