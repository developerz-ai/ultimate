# 24 — CI and gate: no flakes, every skip explained, under 5 minutes

> Part of [`overview.md`](overview.md). Depends on: none. Tier: `scripts/`, `.github/`, `biome.json`. Flake fixes land in sweep 0; the speed cut in sweep 0 too.

## Verified clean (2026-11-09) — do not redo
- `x verify merge` reds a step no part ran (`cli/src/verify-merge.ts:262-304`).
- Every live suite runs in CI: the `gate (live)` part exports all nine service URLs; `scripts/lib/test-service-coverage.ts` refuses a service suite no part starts.
- Biome 2.6 configs fixed on `main` by #1031 (root and `scaffold-repo.ts:283`).
- The S3-gateway pin's source of truth is right.

## Findings
| # | Sev | Site | Fix |
|---|---|---|---|
| G1 | Low (flake) | `cli/src/db-diagnostics.test.ts` (run 42553605952: cold PGlite 12.6 s > 3 s deadline) | pass `deadlineMs: 30_000` ([`03`](03-db.md) D4) or warm the database in `beforeAll` |
| G2 | Low (flake) | `testing/src/drill-run.test.ts:191` | [`18`](18-admin-testing.md) T4 |
| G3 | Low | per-step floor in `x.verify.json`; CI `live`: "713 ran, 3 skipped", reasons not shown | the live step fails on a skip whose reason names a `TEST_*` variable; the part document lists every skip with its reason |
| G4 | Low | Biome warnings: `noTemplateCurlyInString` in `scripts/error-render.test.ts:340,359`, `scripts/lib/test-service-coverage.test.ts:131-132`, `cli/src/upgrade-bun-floor.test.ts:87,129`, `templates/resource-page-db.test.ts:27`, `scripts/lib/health-doc.test.ts:173` (deliberate source-in-string fixtures) | one `overrides` entry for `**/*.test.ts` turning that rule off; prefix unused params with `_` |
| G5 | Med (speed) | last full PR run ≈ 5 m 40 s; critical path `gate (live)` 313 s (live step 280 s serial), `packages (2/2)` 312 s | `live` → `--shard 1/2`, `2/2` (supported) as two matrix rows + the service-coverage map; `packages` → `shard: [1/3, 2/3, 3/3]`. Critical path ≈ 290 s |
| G6 | Low (supply chain) | `.github/workflows/*` | `zizmor` (or `actionlint`) job gated on `changes` when `.github/**` changed |
| G7 | Owner | repo settings | CodeQL default setup; secret scanning + push protection; Dependabot security updates; required `verify` check on `main` — [`90-owner-steps.md`](90-owner-steps.md) |

## Files to change
- `packages/cli/src/db-diagnostics.test.ts`; `biome.json`; the 4 test files with unused params.
- `.github/workflows/ci.yml` (matrix rows, the per-job question comments), `scripts/lib/test-service-coverage.ts`, the live step's skip check in `cli/src/verify-*.ts`.
- `.github/workflows/workflow-lint.yml` (new).
- `docs/history/ci-split.md` — the new shards and why.

## Tests
- `bun test packages/cli/src/db-diagnostics.test.ts scripts/lib/test-service-coverage.test.ts`
- The CI run itself: `gh run list --workflow ci.yml --limit 3` all < 5 min wall time.

## Done when
- Three consecutive `main` runs green, each under 5 minutes, with no rerun.
