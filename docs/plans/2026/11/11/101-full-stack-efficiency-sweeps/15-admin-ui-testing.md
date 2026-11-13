# 15 — admin, ui and testing: bounded dashboards, stable toasts, three test kinds the gate lacks

> Part of [`overview.md`](overview.md). Depends on: [`05`](05-entity.md) E7 (trigram search) for D1. Tier: 4 (`ui`) and 5 (`admin`, `testing`).

## Findings — admin

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| D1 | P2 | confirmed (read) | `packages/admin/src/search.ts:80,180`; `repo-entity.ts:29,68` | Search justifies one query per field as "indexed lookups", but `contains` is `like '%term%'` (no btree serves it); resources are searched one after another; the match is case-sensitive ("alice" misses "Alice") | the entity's `search_tsv` (GIN) where `.searchable()`, else the trigram `contains` from [`05`](05-entity.md) E7; resources in parallel under `mapBounded`; fix the comment |
| D2 | P2 | confirmed (read) | `packages/admin/src/jobs/overview-data.ts:114-120` | One `counters()` query per job name that settled in the range, sequentially, behind an `expectedQueryLoop`: ~100 statements per visit for an app with 100 jobs | `introspect.counters({ jobs: [...], sinceMs })`: one `IN` read in the jobs introspection (`packages/jobs/src/introspection.ts`; the jobs file joins this slice's lock) |
| D3 | P3 | confirmed (read) | `packages/admin/src/screen-home-counts.ts:35-37`; `list-scope.ts:103-112` | Home tiles and scope tabs run an exact `COUNT(*)` per resource or scope on every visit; `approximateCount()` (`packages/entity/src/repo.ts:167`) is unused | `count: 'estimate'` on a resource uses `approximateCount` when the predicate is the row scope alone, exact otherwise; the tile shows `~` |

## Findings — ui

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| V1 | P2 | confirmed (read) | `packages/ui/src/components/Toaster.tsx:65-74` | Toasts render through a non-keyed `.map`: every publish rebuilds every visible `<li>`. The live region re-announces every surviving toast (against `Toast.tsx:46`'s `aria-atomic="false"` contract), and a keyboard user focused on toast A's Undo loses focus to `<body>` when toast B arrives | keep nodes by `item.id`, the `keyedRows` pattern of `data-table-rows.ts` (one `createRoot` per key) |
| V2 | P3 | confirmed (read) | `packages/ui/src/components/SearchableSelect.tsx:95-102,185,226`; `Combobox.tsx:62-63,95,103,105-107` | `view()` / `matches()` are plain functions read several times per keystroke: several O(n) passes over all options per key | `rt.createMemo`, as `Tree.tsx:56-64` does |
| V3 | P3 | confirmed (read) | `packages/ui/src/components/Drawer.tsx:48,64-69` | `snap` is seeded once: after a drag to `full`, close and reopen opens at `full`, against the prop's doc | reset in the open branch of the effect |

~85 components were not read individually ([`overview.md`](overview.md) *Risks*); T3 below is the mechanical net under them.

## Findings — testing (mechanisms the gate lacks)

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| T1 | P2 | absent (catalogue) | no generator in the tree | No property-based tests on the encoders and decoders that mint durable keys or face hostile input | `property(gen, fn, { runs, seed })` in `packages/testing/src/property.ts`: seeded, no dependency, a failure prints its seed and the shrunk-by-halving input. First properties: cursor encode/decode, canonical JSON, money parse/format round trip, byte-range parse, cookie parse, pgoutput decode, i18n interpolate, `estimateBytes` ([`04`](04-cache-seo.md) K2) |
| T2 | P2 | absent (catalogue) | point checks only (`packages/money/src/format.test.ts:109`) | Nothing asserts the heap is flat under load: the one regression class no gate sees until a pod is killed | a soak canary on the `live` step: 20k requests through the in-process pipeline (`packages/core/src/in-process-fetch.ts`) across SSR, action, query and 4xx paths, `Bun.gc(true)`, heap growth under a stated bound (a measurement: raise it with the reason in the same diff) |
| T3 | P2 | partial (static guards + token contrast only) | `packages/testing/src/cdp-e2e-page.ts:309` (the AX tree is already available) | No rendered accessibility check | on every page the `e2e` step visits: a focusable node with no accessible name, or a form control with no label, is `X_A11Y_UNNAMED_CONTROL` with the selector and the route |

Island coverage mapping is [`13`](13-cli-exercise-verify.md) X9.

## Files to change
- `packages/admin/src/search.ts`, `repo-entity.ts`, `jobs/overview-data.ts`, `screen-home-counts.ts`, `list-scope.ts`, `resource.ts`; `packages/jobs/src/introspection.ts`.
- `packages/ui/src/components/Toaster.tsx`, `SearchableSelect.tsx`, `Combobox.tsx`, `Drawer.tsx`.
- `packages/testing/src/property.ts` (new), `soak.ts` (new), `e2e-a11y.ts` (new), `index.ts`; the eight property tests next to their sources (`packages/<pkg>/src/<file>.property.test.ts` runs in `unit`: keep the suffix-free name if the step globs by suffix — check `VERIFY_STEP_NAMES` first).
- `examples/dummy` — the soak canary's host (`apps/web/soak.live.test.ts`).
- Coordinator only: `bun run new-error-code X_A11Y_UNNAMED_CONTROL --package testing … --off-socket`, changelog + `wiki/Upgrading.md` (T3 turns new findings red in apps with e2e: lands report-only for one release), `bun run manifest`.

## Steps
1. W1 admin; W2 ui; W3 `property.ts` + the eight properties; W4 soak + a11y.
2. T1: each property must find a planted bug (flip one comparison in the encoder, show red, revert) — the proof the generator reaches the edge.
3. T2: run it three times before choosing the bound; the bound is the max observed × 1.5, written with the three figures.
4. T3: run against the three tracked apps first; fix what it finds in `ui` in this slice (it will find component defects — that is the unread-components net).

## Tests
- `packages/admin/src/search.test.ts` — a case-insensitive hit; statement count bounded. `jobs/overview-data.test.ts` — ≤ 4 statements with 100 jobs. `screen-home-counts.test.ts` — estimate mode issues no `COUNT`.
- `packages/ui/src/components/Toaster.test.ts` (real Solid) — show A, show B: A's `<li>` is the same node. `SearchableSelect.test.ts` — a counting spy runs once per query change. `Drawer.test.ts` — reopen at `half`.
- `packages/testing/src/property.test.ts` — a failing property reports its seed; the same seed reproduces.
- Command: `bun test ./packages/<pkg>/src/<file>.test.ts`.

## Done when
- The admin jobs overview and search are a bounded statement count on any app size.
- A toast arriving does not move focus or re-announce its neighbours.
- Eight round-trip properties, a heap canary and a rendered a11y check run in the gate.

## Outcome (15, local)

Ships as 31.18.0. `As of 2026-11-13`, measured before release.

| ID | Outcome |
|---|---|
| D1 | **partial.** The search box, a list's `contains` filter and a lookup are now the entity's `contains`, a bound `ilike` that a `gin_trgm_ops` index serves (`repo-entity.ts`), so `alice` finds `Alice`. Resources are read four at a time under `mapBounded` (`search.ts`, `SEARCH_WIDTH`); every decision is still audited before any read. Statements per search are unchanged (≤ 3 per resource); latency overlaps instead of adding. **Coordinator decision:** a `contains` the app DECLARES (`rows`, a scope's `where`) stays case-sensitive on the read (`like`) and the write (`row-scope-write.ts`), marked `caseSensitive: true` by `declaredFilters`, because a row scope is authorization and must never widen (`row-scope-case.test.ts`). **Deferred:** the `search_tsv` path. The admin IR has no OR/`matches` operator, and the memory driver refuses `matches` |
| D2 | shipped. Optional `JobIntrospection.countersMany` on the Postgres and memory drivers (Redis keeps no counters). The jobs overview costs 4 statements at 100 job names, where it was 3 + N (`overview-data.test.ts`). A driver without it falls back to one `counters()` per name |
| D3 | shipped for home tiles. `count: 'estimate'` reads `approximateCount()` when the row scope adds no predicate and the estimate is ≥ 10,000 (`ESTIMATE_COUNT_FLOOR`), and the tile shows `~N` (`admin.dashboard.records.approximate`). Everything else is exact. Scope tabs keep the exact count: a tab is a predicate, and the estimate is whole-table |
| V1 | shipped. `<Toaster>` keeps one node per toast id (`keyedRows`). A new toast leaves the surviving `<li>` in place: no rebuild, no re-announce, and focus on Undo survives |
| V2 | shipped. `<SearchableSelect>` and `<Combobox>` filter once per keystroke (`createMemo`); counting spies in both tests. Reference-app settings island: +14 B (74,687 → 74,701), page 108,523 B, still under its 106kb budget, so no raise |
| V3 | shipped. `<Drawer grabber>` resets `snap` to the prop on every open (`Drawer.test.ts`) |
| T1 | shipped. `property(gen, fn, { runs, seed })` + `gen`, with the eight properties as `packages/testing/src/property-*.test.ts`. Each was mutation-checked against a planted bug. They found **two real bugs, fixed here**: `parseAmount` refused BHD in `ar-EG` (bidi mark stripped after the trim), and pgoutput's `ByteReader` accepted a negative length (the cursor moved backwards, a silent misread); the decoder now also refuses trailing bytes. A third was in test support: the replication fixture framed values by UTF-16 length. `X_TEST_PROPERTY_FAILED` registered |
| T2 | shipped, in `packages/testing/src/soak.live.test.ts` rather than `examples/dummy`: the framework's own pipeline (SSR, action, query, 404, 400), 20,000 requests, bound 404 KB = 1.5 × the largest of three runs (265,050–269,194 B). `soak()` / `measureSoak()` are public; `X_TEST_SOAK_HEAP_GROWTH` registered. The canary is the framework's own `live` suite and never an app's red |
| T3 | **already shipped** (#987, `X_E2E_A11Y_VIOLATION`, the CDP AX tree audit on every page `e2eTest` visits). **Deferred, ledger for `next`:** the listbox/option/menuitem*/treeitem roles and focusable-without-role. The audit has no warn mode, so adding them would turn existing apps red on main |
