# 47 — Adopter H

> Part of [`overview.md`](overview.md). Depends on: [`07`](07-gate-truth.md), [`08`](08-upgrade-without-hands.md) released. **Another repository**: edited from its own checkout, in a git worktree when that checkout is dirty or off its default branch. One PR, ≤ 100 files, more PRs if larger. Never named in this tree.

## Shape
Agent-driven content factory over MCP, in production. As of 2026-11-14: framework 31.22.1, default-branch CI green. Gate steps it never runs: live, job, e2e, roadmap.

## Files to change
| Item | Where | Replacement |
|---|---|---|
| own LLM route + retry, ~1,950 LOC | `packages/gateway/src/llm/route.ts`, `retry.ts` | [`06`](06-ai-mail-scraping-ui.md) A1 |
| prompt cache for a custom host | `docs/roadmap/ultimate-gaps.md:40` | `openAiProvider({ promptCache: { rules } })` (31.23.0) — delete the workaround |
| SSRF guard duplicating the public dial, 168 LOC | `packages/gateway/src/media/url-guard.ts:1-3` | `outbound({ dial: 'public' })` |
| says `x token` is unimplemented | `apps/web/app/api-keys/mint-cli.ts:1` | `x token` (shipped) |
| real-Postgres runner | `scripts/dev/pg-tests.ts:1-9` | [`07`](07-gate-truth.md) G3 |
| 218 hand-written error classes | repository | [`02`](02-core.md) C3 |
| named limiters, batches | `docs/roadmap/ultimate-gaps.md:17` | [`05`](05-jobs-realtime.md) J6 |
| `memoPerRequest` forget; `lockKeys` move | 2026/11/11 slice 47 `:40` | [`03`](03-db-entity-policy.md) K1 |
| media generation, sandboxed jobs | `docs/roadmap/ultimate-gaps.md:13,19` | stay app code ([`90`](90-owner-decisions.md) OD7); update the note |

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
