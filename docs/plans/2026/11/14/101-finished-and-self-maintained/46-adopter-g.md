# 46 — Adopter G

> Part of [`overview.md`](overview.md). Depends on: [`07`](07-gate-truth.md), [`08`](08-upgrade-without-hands.md) released. **Another repository**: edited from its own checkout, in a git worktree when that checkout is dirty or off its default branch. One PR, ≤ 100 files, more PRs if larger. Never named in this tree.

## Shape
Browser-automation extraction service, in production. As of 2026-11-14: framework 31.22.0, default-branch CI green. Gate steps it never runs: live, e2e, roadmap.

## Files to change
| Item | Where | Replacement |
|---|---|---|
| error scrubbing by value, 545 LOC | `apps/web/app/sentry/reporting.ts:1-20` | [`02`](02-core.md) C2 |
| own HTTP client, for a proxy | `clients/src/direct-http.ts:1-4` | `outbound({ proxy })` ([`02`](02-core.md) C6) |
| retry, limiter, pacing, ~1,060 LOC | `clients/src/{retry,api-retry,api-limiter,line-retry,pace}.ts` | core retry + `limiter()` ([`05`](05-jobs-realtime.md) J6) |
| LLM chooser layer on a vendor SDK, 4,533 LOC | `packages/pilot/src/choosers/` | `fallbackModels` + `providerOptions` ([`06`](06-ai-mail-scraping-ui.md) A1) |
| real-Postgres runner | `scripts/dev/pg-tests.ts:1-15` | [`07`](07-gate-truth.md) G3 |
| 20 of 24 vendored guards differ | `guards/` | [`08`](08-upgrade-without-hands.md) U1 |
| a browser dependency beside `scraping` | `package.json` | the completed port ([`06`](06-ai-mail-scraping-ui.md) S1), where it covers the use |
| nullable keyset keys, settle-all fan-out, global-read proofs | 2026/11/11 slice 46 `:41` | [`03`](03-db-entity-policy.md) E1, E3; [`02`](02-core.md) C4 |

## Steps
1. `x upgrade` to the latest release. Any hand edit it needs is a defect against [`08`](08-upgrade-without-hands.md): file it, do not absorb it.
2. `x.verify.json` → `strict: true`; every step runs or carries a written `why` ([`07`](07-gate-truth.md) G1). `roadmap` may carry a `why`; `live` and `e2e` may not where the app has a database or a page.
3. Delete each workaround in the table for its framework replacement; `x doctor` reports zero superseded workarounds.
4. Turn on the automated framework upgrade ([`31`](31-maintainer-platform.md) P2): stop excluding `@ultimat3/*` from dependency automation.
5. Report back what the framework still lacked. A gap seen here joins [`20`](20-audit-rounds.md)'s next round as evidence.

## Tests
- The app's own gate: `bun x x verify` green with `strict: true`, on its CI.

## Done when
- On the latest release by an `x upgrade`-only PR; strict gate green; the table above empty or each remaining row justified in the PR.
