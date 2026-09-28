# 07 — release, CI, guards

> Part of [`overview.md`](overview.md). Depends on: none. Tier: — (scripts, workflows).

## Files to change
| File | Defect | Verdict |
|---|---|---|
| `scripts/lib/workspaces.ts:146` (`publishOrder`), `.github/workflows/release.yml:244` | within a tier, publish is alphabetical → `core` before `schema`, `cli` before `testing` (declared sideways edges). 22.4.0 died after `core`, leaving an uninstallable `core@X` on npm | CONFIRMED, high |
| `.github/workflows/release.yml:141` | `check` waits only on ci.yml's `verify` job; `scaffold-smoke`, `container`, `packages`, `reference-app-verify` can be red and the release still publishes | CONFIRMED, med |
| `scripts/lib/corpus.ts:24`, `skip-if-cleanup.ts:60` | `tests` scope misses `packages/*/e2e/**` (12 files) → `test-bare-error`, `to-throw-returns`, `test-fix-citations` silently green there | CONFIRMED, med |
| `scripts/lib/verify-args.ts:60-63` | `--workers abc/0/-2` dropped silently, `4x` → 4; positional (`bun run verify lint`) ignored → full gate at full width (OOM case) | CONFIRMED, low |
| `.github/workflows/deploy-social-demo.yml:138` | every run retags `:latest`; out-of-order runs roll it back; `workflow_dispatch` on a PR branch ships unmerged code | PLAUSIBLE, low |
| `.github/workflows/wiki.yml`, setup action `actions/cache@v6` | tag refs, not SHAs (no publish credentials — low) | low |

## Steps
1. `publishOrder`: topological sort by `@ultimat3/*` deps within each tier (ties alphabetical). Workflow jq consumes that order instead of `group_by(.tier)` — derived by `scripts/release-workflow.ts`, never hand-listed.
2. `release.yml` `check`: require the ci.yml run's overall `conclusion == success` for the tagged SHA (not one job).
3. Add `'packages/*/e2e/**/*.test.{ts,tsx}'` to both glob lists; fix any hits the guards now surface.
4. `verify-args.ts`: parse `--workers` through `packages/cli/src/flag-number.ts` → `X_CLI_BAD_FLAG`; refuse positionals with the same code, fix names `--only <step>`.
5. `deploy-social-demo.yml`: push `:latest` only when `$SHA == origin/main` tip.
6. Pin `wiki.yml` / setup-action refs by SHA.

## Tests
- `scripts/release-workflow.test.ts` — every dep index < dependant index across the full plan.
- `scripts/release-workflow-shape.test.ts` — `check` gates on run conclusion.
- `scripts/lib/corpus.test.ts` — `tests` scope contains an `/e2e/` path.
- `scripts/lib/verify-args.test.ts` — bad `--workers` and positionals refused.
- `bun test scripts/release-workflow.test.ts scripts/lib/corpus.test.ts`

## Not a bug (don't reopen)
- `id-token: write` scoped to `publish`; release actions SHA-pinned; `budget-raises`/`pin-raises` base handling; `release.ts` refusals; `reference-app-gate` skipped-step handling.

## Done when
- `bun run scripts/release-workflow.ts --json` lists `schema` before `core`, `testing` before `cli`; `bun run verify` green.
