# 90 — Rejected, and why

> Part of [`overview.md`](overview.md). Not a slice: nothing here executes. It stops these being re-proposed without new evidence. "No adopter asked" is not a reason on this page: the framework is for the world, and everything that was deferred on that ground is back in the plan.

## Decided: nothing shipped is deleted
An audit scanned for code with no callers in tracked apps or adopters: `notify`, RAG and vector search, unused `ui` components, `cmd-planned.ts` stubs, `x pr`, `testing/src/harness.ts`, `admin/src/ai-panes.ts`, `time/src/schedule.ts`, `flags/src/projection.ts`, `database.driver`, 1,679 unread barrel names. Owner: keep all of it. Zero use among first adopters, most on old versions, says little about what the world needs.

## Rejected, by ground
| Ground | Candidates |
|---|---|
| Already shipped | CDN tag purge (`cache/src/cdn.ts`), on-demand renditions (`cli/src/runtime-assets.ts:183`), bulk endpoints (`ai/src/hive.ts:65`), delivery ledger (`jobs/src/webhook-ledger.ts`), fail-closed audit (`action/src/audit-gate.ts`), snapshots (`toMatchSnapshot`), `x run --as` (`action.as`, audited admin actions over MCP), read-only SQL (`db.query` over `x mcp serve`), external gate steps (a guard can spawn, `cli/src/guards.ts:33`), docs compiled from source (fence ratchet), full-text search (`.searchable()`), `x plan` (`x g --dry-run`), fleet rate seam (slice 13 documents it), API surface for sitemap, hreflang, JSON-LD, locale routing, RTL, service worker, push, offline queue, CSV, contrast, reduced motion |
| A second way | Structured-concurrency helper and a `Promise.all` guard (the defect is fixed in 02), ICU syntax (suffix plurals, `i18n/src/interpolate.ts:393`), `formatNumber` (`wiki/I18n.md:179`), `x status` (19 and `x doctor`), `rpc` reaching a mount (the generated client in `41-add-api-clients`), flake quarantine (green with a known red breaks axiom 5), `$input` (`$view`), `toJson` (`parse(t.json(), v)`), `StatGrid`, `Sheet`, activity feed, number stepper |
| Platform primitive (axiom 7) | `x rollback` (`x deploy --image <old>`; the refusal kernel survives in `41-add-operations`), `x logs` (stdout is the platform's), bucket lifecycle rules, backups as commands |
| Business convention (axiom 8) | Behavioural monitors, `errorIssueJob()` (`onNewGroup` is the seam), analytics and experiment analysis, saved per-person admin views, incident tooling, vendor verifiers |
| Dependency or OS codec | AVIF (`core/src/image/pipeline.ts:22`), font subsetting, video processing, rich-text editor, maps, terminal emulator, a secret-scan rules database |
| Wrong for any team | Dead-letter uncoded defects on attempt 1 (`core/src/error-retry.ts:176`), a falling feature-tax ceiling (games axiom 9), mutation testing in the gate (too slow for free runners) |
| Too large for this plan, not rejected | `x branch` preview environments, expand/contract renames, CRDT collaboration, mobile M13–14 (`docs/idea/14-roadmap.md:138`), scatter, treemap, Gantt, DAG charts (`ChartFrame` is the seam), N-pane docking. Each needs its own plan |

## From the typed-effect library, rejected as a model
Its core program type, generators, `pipe`, `Layer`, fibers, in-process `Queue`, `PubSub` and `Ref`, `Stream` and `Sink` as public API, Schedule combinators, implicit request batching, `Config` providers, `Exit` and `Result` values, sharding, RPC, event log, HTTP API builder, CLI builder, atoms. Each is a second programming model or a second path beside a primitive. Guarantees taken: 02, 03, 06, 10, 34, `39-jobs-event-wake`, `39-action-sagas`. Its sharding internals, event log, devtools, most of atom and its RPC client were read by header or grep only.
