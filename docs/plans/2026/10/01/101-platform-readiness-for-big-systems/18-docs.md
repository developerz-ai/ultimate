# 18 — Docs: what shipped, and what agents did not find

> Part of [`overview.md`](overview.md). Depends on: 01–17. Tier: docs.

Rule: a feature an agent cannot find is a feature that does not exist. Three shipped mechanisms
were rebuilt by hand in a downstream app because the wiki never led to them.

## Files to change
| File | Change |
|---|---|
| `wiki/Jobs-And-Workflows.md` | keyed concurrency and `finalAttempt`; a section for `webhook()` (`packages/jobs/src/webhook.ts:1-16`) — a downstream app wrote ~1,800 LOC of outbound webhooks a month after it shipped |
| `wiki/Theming.md:80` | the three breakpoint mixins, `rem()`, `fluid()`; a table of the layout mixins `row` / `column` (`packages/ui/src/tokens/_mixins.scss:225,234`) — 691 hand-written `display: flex` in one app |
| `wiki/Scraping.md` | egress, the CDP resolver with a 20-line vendor wrapper as an app-side example, usage, sealed sessions, `eventPrompt` |
| `wiki/Entities-And-Migrations.md` | `.sealed()`; the repo section shows the typed handle |
| `wiki/Admin-Dashboard.md` | served screens with zero host code; filters, scopes, relation labels and pickers, row scoping; sections, related rows, form groups; `when` and `batch` on actions; the durable audit sink. Fix `:115`, whose "custom bulk operation" row describes a plain action |
| `wiki/Client-Data.md:7` | stale: says 21.0.0 is "not released" |
| `wiki/Client-Data.md:33-35` | the transport rule is a `boundaries` finding |
| `wiki/Client-Data.md` | a row for the non-live read: `useQuery` with no `live` is one HTTP GET and needs no socket; when to set `islands: { sharedChunks: true }` (`packages/core/src/config-islands.ts:9-17`), and its layering: the last config layer that states it wins, absent is `false` (`:30-37`) |
| `docs/architecture/16-build-pipeline.md:71-72` | stale: "No client bundle / No hydration" |
| `docs/architecture/21-client-data-layer.md` | the client type at scale; `pathStyle` stated once |
| `docs/idea/19-mechanism-not-convention.md:84-89` | two worked rows: *usage* (measurement ships, quota does not), *credentials* (sealing ships, a vault model does not) |
| `wiki/Known-Gaps.md:36` | remove the proxy row; add the deferred table from `overview.md` |
| `wiki/Error-Codes.md` | verify the six new rows exist (written by `new-error-code`) |
| `llms.txt` | the run console as the idiomatic long-run example |
| `CHANGELOG.md` | one entry per slice under `[Unreleased]`; `BREAKING —` on slice 09 if the owner rules it a major |
| each touched package's `README.md` + `CLAUDE.md` | public API and boundary; keep each `CLAUDE.md` ≤ 24 KB (`bun run scripts/claude-md-size.ts`) |

## Steps
1. Delegate to the `docs-author` agent with this file and the merged diffs; it verifies each
   claim against the code.
2. House style: lead with the rule, fragments, tables for ≥3 rows, date load-bearing claims
   `As of 2026-10`.
3. `bun run scripts/guards-doc.ts --write` after slices 08–10 and 13–16.
4. Do not name any surveyed application, vendor or client in a committed file.

## Tests
- The gate: the `drift` and `manifest` steps of `bun run verify`.
- Also run by hand — check first whether each is already reached through a gate step, and say so
  in the PR: `bun run scripts/guards-doc.ts --check`, `bun run scripts/claude-md-size.ts`,
  `bun run changelog-check`.

## Done when
- Every `file:line` this plan cites as stale reads true.
- `bun run verify` green, all 20 steps.
