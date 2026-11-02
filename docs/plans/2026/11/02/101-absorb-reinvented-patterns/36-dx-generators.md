# 36 — Generators: green on arrival, no invented tables, a loop that fails

> Part of [`overview.md`](overview.md). Depends on: [`36-dx-false-fixes`](36-dx-false-fixes.md) for D4's and D3's fix text; [`07`](07-render-stream-hole.md) also edits `cli/src/templates/`, so land after it. Tier: 2 (`entity`), 5 (`cli`, `testing`).

## Why
`x g` is an agent's first move, so what it writes is what the agent copies. Scaffolded app, 2026-11-02: a generated action fails the gate; a generated query creates a table nobody asked for; a single-tenant app still gets `orgId`; a package may import an app; an N+1 in a generated test passes.

## Fixes
| # | Sev | Site | Failure, as printed | Smallest fix | Failing-first test |
|---|---|---|---|---|---|
| D1 | High | `cli/src/templates/action.ts:293-296,353` | `x g action closePost --feature post` on a hand-written policy: `close-post.contract.test.ts:8:7 lint/correctness/noUnusedVariables`, `x verify --only lint` red. Generated, so every such action; `x g action closeThing`, which writes its own policy, passes | `id`, `orgId`, `input` consts gated on `scaffoldPolicy`, the only branch reading them (`:345`) | `cli/src/templates/emitted-routes.test.ts`-style generated-action test: both shapes pass `biome check` on the emitted text. Scaffold smoke: `x g action` into a hand-written slice gates |
| D5 | High | `cli/src/cmd-generate.ts:90,340-345` | `x g query order`: 14 files, entity, repo, `next: bunx x db gen "create orders"`. `x g backfill reindex`: 12 files, `create reindexes`. A read and a one-off job each lay down a new table | a kind in `READS_SLICE` other than `job`, `task`, `action`, `mutator` needs `--feature` when no slice of that name exists: `X_FEATURE_REQUIRED`. A slice of that name: today's path. `x g resource` stays the one thing creating a table | `cli/src/generate-feature.test.ts`: both refused, 0 files written; `--feature post` writes under the slice; `x g query post` with slice `post` writes |
| D11 | Med | `cli/src/templates/action.ts:52,89,159-160,294-295`, `cli/src/templates/job.ts:307` | delete `tenant: 'orgId'` per the entity's own comment, `x g action shipPost --feature post`: `input: t.object({ id: t.uuid, orgId: t.uuid })`. The comment says the generators decide per slice; `job` does, via `isTenantScopedSlice`, `action` does not | `action` and `mutator` read the slice as `job` does: no tenant, no `orgId` in input, tests or the org rule | `cli/src/templates/action.test.ts`: entity with no tenant emits no `orgId`; scaffold smoke gates a single-tenant slice twice |
| D8 | Med | `cli/src/app-boundaries.ts:31-38` | `packages/domain/src/index.ts` importing `apps/web/app/post/repo`: `boundaries` green. No rule looks at `packages/`, so a shared package silently depends on one app | new rule in `BOUNDARY_CODES`: a file under `packages/` resolving into `apps/`. Runtime imports only, `scanRuntimeImports`'s reading. No per-package tiers: an app's package layout is its own | `cli/src/app-boundaries.test.ts`: refused; `import type` from `apps/` passes, as the scan reads runtime imports only; `packages/` to `packages/` passes |
| D9 | Med | `entity/src/memory-repo.ts:78`, `testing/src/fixture-statements.ts:84`, `cli/src/templates/{action,query}.ts` | 8 `where({ id }).one()` on the memory driver under `testStatements()`: **statements seen 0**. Generated unit tests run on memory, so asserting through it as proposed cannot fail. `wiki/Testing.md:487` claims "a `findById` loop in a unit test" is what it catches: true on Postgres only | `memoryRepo` reports through `statementObserver()` with `statementFingerprint`-compatible attribution (`<table>.findById`), one event per operation; no SQL text. Then generated query and action tests destructure `statements` and assert the handler's count | `testing/src/fixture-statements.test.ts`: the probe throws `X_N_PLUS_ONE_QUERY` on memory; `expectedQueryLoop` still suppresses. Generated query test fails when its handler gains a loop: mutation in `cli/src/templates/query.test.ts` |

## Dropped
| Finding | Reason |
|---|---|
| no `x g package` | a feature request. No failure, no adopter count. `packages/` in an app is the app's; [`90-deferred.md`](90-deferred.md) when coordinator next edits it |
| D9 as written | generators alone give a test that cannot fail; the memory half above is the real defect |

## D5, the decisions
| Question | Answer |
|---|---|
| Why not write the query with no entity | a generated query's test reads the slice's repo (`READS_SLICE`); with no slice it has nothing to read. Refusing names the two real paths |
| `job`, `task` | already write no entity with no slice (`templates/job.ts:49`). Unchanged |
| `action` | still scaffolds `policy.ts` with no slice, today's passing shape. Entity-less. Unchanged |
| `route`, `island` | name no slice (`cmd-generate.ts:325`). Unchanged |
| Docs saying `x g query <name>` | `wiki/CLI-Reference.md:22,405`, `wiki/The-Eight-Primitives.md`, `docs/architecture/12-generated-app.md:246`, `15-adding-a-feature.md`, `wiki/Realtime.md:136`, `wiki/Migrations-And-Backfills.md`: each gains `--feature <slice>` |

## Files
`cli/src/cmd-generate.ts`, `cli/src/generate-feature.ts`, `cli/src/templates/{action,query,backfill}.ts`, `cli/src/app-boundaries.ts`, `entity/src/memory-repo.ts`, `testing/src/fixture-statements.ts`, tests beside each. `packages/cli/src/templates/` regenerates scaffold emitted tests; `examples/dummy` unchanged unless the manifest moves. Docs above plus `wiki/Testing.md`, `wiki/Error-Codes.md`, `wiki/Upgrading.md`, `packages/cli/CLAUDE.md`, `packages/entity/README.md`. No guard copy touched: `x doctor` lists nothing new.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_FEATURE_REQUIRED` (new, tier 5) | `x g query` or `x g backfill` with no `--feature` and no slice of that name | `x g query <name> --feature <closest slice>`, or `x g resource <name>` for a new table. `bun run new-error-code X_FEATURE_REQUIRED --package cli --title '…' --cause '…' --fix '…'` |
| `X_BOUNDARY_PACKAGE_TO_APP` (new, tier 5) | a file under `packages/` imports from `apps/` at runtime | move the shared code into the package, or import in the opposite direction. Same command, `--package cli` |
| `X_N_PLUS_ONE_QUERY` (existing) | now also on the memory driver | existing `preload()` fix |

## Tests
Each row's test fails today. `bun test packages/cli/src/generate-feature.test.ts packages/cli/src/app-boundaries.test.ts packages/testing/src/fixture-statements.test.ts`. Scaffold smoke over both shapes is the proof D1 and D11 stay fixed: a second gate catches broken generators.

## Semver
**Breaking, three rows.** The `x` CLI surface and verdicts are held as stable. Generators' output changes only new files: patch.
- D5 Upgrading: "`x g query` and `x g backfill` no longer create an entity. Pass `--feature <slice>`, or `x g resource <name>` for a new table."
- D8 Upgrading: "`boundaries` refuses a `packages/*` file importing `apps/*`. Move the code down."
- D9 Upgrading: "`statements` now counts memory-driver reads. A loop in a memory-backed test that uses it now fails: `preload()` or `expectedQueryLoop('<why>', …)`."

## Done when
- `x g action` into any slice, `x g query --feature`, `x g backfill --feature` each leave `x verify` green on a scaffold, twice.
- No generator but `x g resource` and `x g entity` writes an `entity.ts`.
- `wiki/Testing.md`'s claim about unit-test loops holds on both drivers.
- `bun run verify`, `scaffold-smoke`, `bun run scripts/reference-app-gate.ts` green.
