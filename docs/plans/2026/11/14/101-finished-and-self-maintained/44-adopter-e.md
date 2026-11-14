# 44 — Adopter E

> Part of [`overview.md`](overview.md). Depends on: [`07`](07-gate-truth.md), [`08`](08-upgrade-without-hands.md) released. **Another repository**: edited from its own checkout, in a git worktree when that checkout is dirty or off its default branch. One PR, ≤ 100 files, more PRs if larger. Never named in this tree.

## Shape
Regulated multi-tenant SaaS, in production: mail, PDF, signatures, jobs. As of 2026-11-14: framework 31.22.0, default-branch CI green. Gate steps it never runs: roadmap.

## Files to change
| Item | Where | Replacement |
|---|---|---|
| four shipped guards downgraded to warnings: 406 raw-SQL findings, 670 hand-written error classes, raw lengths, raw breakpoints | `guards/repo-raw-sql.ts:358`, `error-declared.ts:168`, `raw-length.ts:224`, `raw-breakpoint.ts:111` | the typed handle; `defineError` with problem meta ([`02`](02-core.md) C3). Several PRs, ≤ 100 files each |
| ~1,168 `sql` templates | repository files | same |
| transitive `overrides` (three packages) | `package.json:72-74` | [`08`](08-upgrade-without-hands.md) U5 |
| tracker-to-issue triage, ~800 LOC + a workflow | `scripts/lib/glitchtip/*` | [`31`](31-maintainer-platform.md) P1 + `framework_version` ([`02`](02-core.md) C1) |
| real-Postgres probe | `bin/probe:5` | `live` in the gate ([`07`](07-gate-truth.md) G3) |
| inbound mail parsed in app | a mail-parsing dependency | `inboundMail()` ([`06`](06-ai-mail-scraping-ui.md) M1) |
| a retried provider-event job pages on each attempt | production tracker | [`01`](01-production-hotfixes.md) H2 |
| boot preflight warnings repeat on every role (~250 each) | production logs | `bootWarning({ roles, once })` ([`02`](02-core.md) C5) |
| carried from 2026/11/11 slice 44: E2, E6, E8–E10, E12–E15, row security | that slice file | as written there |

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
