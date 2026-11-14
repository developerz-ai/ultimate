# 49 — Adopter J

> Part of [`overview.md`](overview.md). Depends on: [`07`](07-gate-truth.md), [`08`](08-upgrade-without-hands.md) released. **Another repository**: edited from its own checkout, in a git worktree when that checkout is dirty or off its default branch. One PR, ≤ 100 files, more PRs if larger. Never named in this tree.

## Shape
Read-only operations console nested inside a larger repository that is not a framework app. As of 2026-11-14: framework 31.22.0 on its default branch (a local checkout sits on a fix branch at 28.0.0: use a worktree), default-branch CI green. Gate steps it never runs: live, job, e2e, roadmap.

## Files to change
| Item | Where | Replacement |
|---|---|---|
| a loader shim so imported repository scripts do not read the parent's `.env` | `console/packages/infra/src/env-shim.ts:1-20` | check whether `FRAMEWORK_ENV` scoping covers it; if not, a nested-app option in the dotenv loader, raised to [`20`](20-audit-rounds.md) |
| import allow-list guard | `lib-allowlist.ts:1-3` | stays an app guard |
| 9 vendored guards differ | `console/guards/` | [`08`](08-upgrade-without-hands.md) U1 |
| island coverage exclude | `x.verify.json` | [`07`](07-gate-truth.md) G4 |

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
