# 07 — Cleanup: trash, twins, stale docs (non-breaking)

> Part of [`overview.md`](overview.md). Depends on: 06 merged. Tier: 0–5 + docs. **Sweep 7.**
> Breaking deletions are [`12-major-25.md`](12-major-25.md). Found by the legacy sweep at `d7b8c7fa`.
> Guards already green there: `boundaries`, `llms-txt`, `claude-md-size`, `declaration-readers`,
> `dead-docs-host`, `guards-doc --check`, `gate-steps`; both `expectedRed` tables are `{}`.

## Rule
Every deletion ships with the guard that keeps it deleted (axiom 3). No guard → not done.

## Agents (≤ 4, disjoint)
| Agent | Exclusive paths |
|---|---|
| A — test-support naming + workspace guards (T1, T9 guard) | the 13 test-only modules below (rename + importers), `packages/cli/src/workspace-checks.ts` (`checkPackageShape`, `checkFileSizes`) + test |
| B — twins → core | `packages/{action,query}/src/deprecation.ts`, new `packages/core/src/deprecation.ts`, `scripts/lib/helper-homes.ts`, `packages/core/src/env-example.ts` (doc comment only), `scripts/error-map-backlog.ts`, `scripts/new-error-code.ts`, `packages/storage/src/driver-s3.ts` (T12), `packages/testing/src/sealed-network.ts` + `README.md` (T17) |
| C — docs drift + doc-path guard | package `CLAUDE.md`s listed below, `wiki/*.md` rows below, `docs/architecture/10-cross-cutting.md`, `docs/idea/13-dx.md`, `packages/cli/src/templates/scaffold-repo.ts:188` + `packages/core/src/config.test.ts:241` (T11), `packages/jobs/src/job-handle.ts` doc (T16), `wiki/{Theming,Interface-Rules,Configuration,Testing}.md` (T14, T15, T17 doc), new `scripts/doc-paths.ts` + test |
| D — root trash + plans layout + T9 splits | `.mcp.json`, `.gitignore`, `bin/`, `CONTRIBUTING.md`, root `CLAUDE.md` Layout row, `docs/README.md`, new `scripts/plan-status.ts` + test, the seven 500-line files of T9, `packages/cli/src/write-line.ts` + `scripts/lib/log.ts` (T13) |

Row owners: A = T1, T9-guard · B = T2, T3-code-comment, T4, T12, T17 · C = T3-docs, T5, T6, T11, T14, T15, T16, T17-docs · D = T7, T8, T9-splits, T10, T13.

## Items

| # | Where | What | Step | Guard |
|---|---|---|---|---|
| T1 | `packages/cli/src/thrown-by.ts` (imports `bun:test`!), `cache/src/redis-fake.ts`, `db/src/fake-pglite.ts`, `db/src/fake-reservable.ts`, `realtime/src/idb-fake.ts`, `realtime/src/policy-fake.ts`, `scraping/src/cdp-fake.ts`, `cli/src/browser-launcher-fake.ts`, `ui/src/fake-dom.ts`, `ui/src/sass-probe.ts`, `ui/src/components/qr-reader.ts`, `admin/src/inert-jsx.ts` | Test-only modules ship in npm tarballs (`files` excludes only `*.test.ts`, `*-fixture.ts`); two naming conventions | Rename each to `<name>-fixture.ts`, update importers; rebuild `packages/ui/dist/` | `package-shape`: a `src/` module imported only by tests must match `*-fixture.ts` (new code `X_PACKAGE_TEST_ONLY_SHIPPED`, `--off-socket`) |
| T2 | `packages/action/src/deprecation.ts` ≡ `packages/query/src/deprecation.ts` | Byte-identical twins (comments differ) | Move to `packages/core/src/deprecation.ts` (imports only `counter`); action + query re-export from core so their public names stay (removal of the re-exports → 25.0.0) | `HELPER_HOMES` row `renderDeprecation` → core |
| T3 | `packages/core/src/env-example.ts:124` `assertEnvExample`; `wiki/Known-Gaps.md:44`; `wiki/Configuration.md:584-587`; `docs/idea/13-dx.md:42` | Second, weaker `.env.example` gate nobody calls; wiki claims no gate exists — false (`cli/src/app-env.ts:75` via `verify-checks.ts:356`) | Delete the Known-Gaps row; repoint both docs at the `drift` step; mark `assertEnvExample` `@deprecated` (deletion in 25.0.0) | doc-path guard (T6) + 12-major-25 deletion |
| T4 | `scripts/error-map-backlog.ts:1-16`; `scripts/new-error-code.ts:18` | One list = "undecided, shrink-only" **and** `--off-socket` decided answers (247 entries) | Split `OFF_SOCKET` (decided, may grow) vs `UNDECIDED` (shrink-only); `--off-socket` writes only the first | ratchet test: `UNDECIDED` length ≤ previous |
| T5 | `wiki/Error-Codes.md:1093` "Names used in the design docs" | 13 aliases whose premise is gone (no hits in `docs/idea`, READMEs, `llms.txt`) | Delete the table; keep "Not thrown yet" (`:1083`) | — |
| T6 | `packages/cache/CLAUDE.md:60`, `db/CLAUDE.md:104`, `jobs/CLAUDE.md:50`, `seo/CLAUDE.md:19`, `pwa/CLAUDE.md:52`, `storage/CLAUDE.md:196,253`, `render/CLAUDE.md:32`, `wiki/Entities-And-Migrations.md:617`, `wiki/I18n.md:12`, `docs/architecture/10-cross-cutting.md:69-77` | Dead paths (`dev-*` → `runtime-*` in 22.0.0; `packages/db/src/backfills.ts`; `packages/i18n/catalogs/en.json` → `src/catalogs/`; a `tokens.ts` that never existed) | Rewrite to current paths; delete the fictional tokens block | **New** `scripts/doc-paths.ts` (verify step `drift` or `policy`): every backticked `packages/…`/`scripts/…`/`docs/…` path in a published `.md` exists, unless under a `**Historical:**` marker. `X_DOC_PATH_DEAD` |
| T7 | `.mcp.json` tracked **and** `.gitignore:72` | Maintainer-personal servers committed beside `.mcp.json.example` | `git rm --cached .mcp.json` (keep local); example stays the shared one | `.gitignore` already covers it |
| T8 | root `bin/setup`, `bin/check`, `bin/dev`; `CONTRIBUTING.md:9-20` | Second path beside `bun run setup` / `verify` / `x` | Delete `bin/`; CONTRIBUTING speaks `bun run` | `scripts/` guard: no tracked root `bin/` (or extend `dead-docs-host`) |
| T9 | 7 non-test files at exactly 500 lines (`cli/src/cmd-dev.ts`, `cli/src/prerender.ts`, `core/src/lifecycle.ts`, `core/src/metrics.ts`, `db/src/migrate.ts`, `scripts/config-readers.ts`); 28 at 495–500 | Trimmed to the ceiling instead of split (SRP) | Split the seven by responsibility (each its own file, header comment) | `filesize`: warning band at 450, listed in `--json` output |
| T10 | `docs/plans/` (not in root `CLAUDE.md` Layout nor `docs/README.md`) | Plans corpus undocumented | Add a Layout row: `docs/plans/ dated execution plans; status.yml per plan`; plan trackers reconciled in this plan's own PR (see [`overview.md`](overview.md) § Trackers) | `scripts/plan-status.ts`: every `docs/plans/**/status.yml` has `status` ∈ template enum (refuses `done`) |
| T11 | `packages/cli/src/templates/scaffold-repo.ts:188`, `packages/core/src/config.test.ts:241` | Stale prose: deleted `createOpfsLocalStore` "throws `X_NOT_IMPLEMENTED`" | Delete the sentences | T6 guard |
| T12 | `packages/storage/src/driver-s3.ts:297` `objectNotFound(DRIVER_NAME, key)` | `X_STORAGE_NOT_FOUND` fix names the driver kind, not the registered disk | Pass the disk name | `driver-s3.test.ts` fix names the disk |
| T13 | `packages/cli/src/write-line.ts:28-41`, `scripts/lib/log.ts:66-79` | Unbounded `EAGAIN` retry, no backoff | Bounded retry (≤ 50 × backoff), then drop with a counter | `write-line.test.ts` fake EAGAIN forever → returns |
| T14 | `#441`: `wiki/Theming.md:311`, `wiki/Interface-Rules.md:163-165` | Say `defineTheme()` is not contrast-checked; it is (`ui/src/theme/brand.ts:62-63,202-220`, `X_UI_CONTRAST_INSUFFICIENT`) | Describe the import-time gate: 4.5 / 3 / 1.4:1, changed pairs only, `CONTRAST_PAIRS` | — (`Fixes #441`) |
| T15 | `#442`: `wiki/Configuration.md` | `RuntimeOverrides` undocumented; middleware only wraps a matched route (`http/src/stages.ts:184-193`) | New section listing `packages/cli/src/runtime-overrides.ts:30-85` fields; middleware never sees an unmatched path; redirects need a route or `runtime.routes`; `/healthz` `/readyz` answer before the pipeline. Cross-link Routes page; `bun run doc-commands`, `guards-doc --check` | — (`Fixes #442`) |
| T16 | `packages/jobs/src/job-handle.ts` doc | "same … policy evaluation as the HTTP call" — jobs run with system authority; `enqueuedBy` is attribution | Reword | — |
| T17 | `packages/testing/src/sealed-network.ts:64`; `wiki/Testing.md:43`; `packages/testing/README.md:13` | Docs say any unmocked egress fails; only `fetch` is sealed | Seal `WebSocket` + `Bun.connect` the same way, else narrow the claim + Known-Gaps row. Prefer sealing | `sealed-network.test.ts` `new WebSocket('ws://example.invalid')` → `X_TEST_NETWORK_SEALED` |

## Steps
1. Branch `chore/sweep-7-cleanup`; brief A–D. Expect ~80 files (T1 renames dominate) — recount before commit, split T9 into its own PR if over 100.
2. Coordinator: `new-error-code` for T1/T6 codes, `bun run guards-doc --write`, `bun run manifest`, `bun run verify`, PR with `Fixes #441 #442`.

## Done when
- Every item gone; T1, T6, T9, T10 guards red on a reintroduction (prove each by a deliberate local reintroduction).
- `bun run verify` green; merged.
