# Improve Ultimate, end to end

## Goal
Fix what is broken, absorb what adopters keep rebuilding, delete what nobody uses: security, data correctness, outages, upgrades, DX, API, MCP, agents, assets, cache, data stores, frontend, tests, docs, CI, deploys. Value first, so stopping after any sweep still leaves the most valuable work done.

Sources: nine adopters and about 30 other repositories (some only skimmed), a typed-effect library's docs and source, audits of this repository. As of 2026-11, at 29.4.0.

## Context
- Bun only, Postgres with no ORM, SolidJS 1.9.x, `@ultimat3/*` tiers 0–5. No new dependency anywhere in this plan.
- No ninth primitive. New factories, both over `job`: `webhookReceiver()` ([14](14-jobs-inbound-webhooks.md)), `importRows()` ([16](16-jobs-import-rows.md)). Everything else is an option, helper or CLI command.
- The typed-effect library is never a dependency. Guarantees taken: a finished scope refuses writes (02), retry inherits the caller's lifetime, finalizers run LIFO (03), durable step output has one form (06), redaction declared on the schema (10), an event answer tied to its transaction (34). Its programming model is rejected: [`90-deferred.md`](90-deferred.md).
- Evidence: every slice's *Why* cites a probe run on 2026-11-02 or a measured adopter figure. Probes were throwaway; each slice's failing-first test is the durable copy.
- Semver rule for every slice: a new red verdict in the gate, a compile break on an exported type, a required member on an exported interface or a changed exported constant is breaking. A `PRIMITIVE_FACTORIES` row is additive.

## Tiers touched
Land each sweep's lowest tier first. An import up or sideways is a design error. New legal edge: `jobs → http`, runtime, stated in 14.

| Tier | Packages | Main slices |
|---|---|---|
| 0 | `core`, `schema` | 02, 03, 09, 10, 11, 12, `29-data-redis-outage` |
| 1 | `db`, `cache`, `storage`, `i18n`, `time` | 04, 05, 20, `25-pkg-storage-streams`, `28-assets-stored-objects`, `29-data-*`, `35-fix-*` |
| 2 | `entity`, `http`, `auth` | 02, 05, 17, `25-pkg-auth-*`, `26-api-*`, `28-assets-compression`, `35-fix-*` |
| 3 | `action`, `query`, `jobs`, `realtime` | 01, 06, 13–16, 19, `25-pkg-realtime-client-reads`, `30-perf-jobs-claim-relay`, `33-ops-worker-roll`, `34-idea-jobs-event-wait`, `35-fix-*` |
| 4 | `render`, `mcp`, `ai`, `ui`, `scraping` | 01, 07, 18, `23-ui-*`, `24-web-*`, `25-pkg-scraping-wedge`, `27-*`, `35-fix-*` |
| 5 | `admin`, `testing`, `cli` | 08, 19–22, `24-web-admin-audit-trail`, `28-assets-image-contents`, `30-perf-gate`, `31-test-*`, `33-ops-*`, `36-dx-*` |

## Sweeps (one PR each, ≤ 4 agents, ≤ 100 files, merged before the next)
File counts are estimates. Lock rule: each slice's *Files to change* is its agent's exclusive set. Before dispatch, intersect the sets in a sweep; two slices sharing a file go to one agent. An agent finishing early is re-tasked with `SendMessage`, never a fifth spawn.

| Sweep | Batch | Slices | Agents | Est. files | Tiers |
|---|---|---|---|---|---|
| 1 Security | A | 01; 28-stored, then 35-fix-security; 25-totp; the model-id edit from 27-evals (retires 2026-11-30) | 3: gate · storage and render · auth | 71 | 1–5 |
| 2 Tenancy | A | 05 | 2: `db` · `entity` | 14 + regenerated | 1–5 |
| 3 Silent corruption | B | 02, then 03; 06, 35-concurrency K3 K6; 34; 22 | 4: scope · lifetime · jobs · upgrade | 62 | 0–5 |
| 4 Silent corruption | B | 04; 35-logic except L11, L12; 35-concurrency K2 K5 K7; 29-large | 4: migrations · entity and action · realtime and auth · bulk | 73 | 0–5 |
| 5 Outages | C | 29-unanswered, 29-pooler; 30-claim half; 33-roll | 3: `db` · jobs claim · worker roll | 81 | 1–5 |
| 6 Rendering and DX | C | 07, L11; 08; 36-false-fixes; 36-generators | 4 | 94 | 1–5 |
| 7 Wire and assets | C | 26-wire; 26-read; 24-i18n; 25-streams; 28-compression; 28-image | 4: API · i18n · storage and compression · image | 78 | 1–5 |
| 8 Core mechanisms | C | 09, 12; 10; 11 | 3: errors · schema · outbound | 95 | 0–5 |
| 9 Jobs | D | 13, 30-relay half; 14; 15; 16; 19; 30-gate | 4: enqueue · inbound · import and recipes · CLI | 78 | 0–5 |
| 10 Gate and deploys | D | 20; 21; 33-ci; 33-proof; 28-skew | 4 | 90 | 1–5 |
| 11 AI and web | D | 27-dual; 27-evals; 18; 17; 24-errors; 24-admin | 4 | 93 | 1–5 |
| 12 Frontend and sign-in | D | 23-refresh, then 25-reads; 23-table; 25-sign-in | 3 | 85 | 2–5 |
| 13 Later | E | 27-oauth (owner); 27-checkpoint; 27-context; 29-redis; 29-keyset; 30-decode; 25-scraping | 4 | 87 | 0–5 |
| 14 Tests and docs | E | 31-boundary; 31-false-green; 32-claims; 32-guards; 32-findability | 3 | 72 | 5, docs |

- Batch = what shares a release, so adopters upgrade once. A carries the live security holes; B and C the major correctness work; D and E what's left. Whether each batch gets a major, and when, is the owner's.
- Coordinator-only, every sweep: `CHANGELOG.md`, `wiki/Error-Codes.md`, `wiki/Upgrading.md`, `framework.manifest.json` (`bun run manifest`, once), `bun.lock`, `status.yml`, any package's `src/index.ts`, `README.md`, `CLAUDE.md`, and any wiki page two agents both edit. Workers report their text.
- Each PR: `bun run verify`, `bun run scripts/reference-app-gate.ts`, CI green, reviews addressed, merged, `main` pulled. A change to `examples/dummy` budgets regenerates its `x.manifest.json` first.
- A slice with two halves in two sweeps (35-concurrency, 35-logic, 30-claim) stays `in_progress` until both land.

## Plan files
| Slice | Covers | Semver |
|---|---|---|
| [`01-ai-tool-gate`](01-ai-tool-gate.md) | **Security.** The confirmation gate binds in-app agents | breaking |
| [`02-db-entity-cancellation`](02-db-entity-cancellation.md) | A write after the deadline or a finished transaction is refused; `runToCompletion` | breaking |
| [`03-core-lifetime-helpers`](03-core-lifetime-helpers.md) | `retry()` lifetime, joiners survive a leader's abort, LIFO close | breaking |
| [`04-db-migration-safety`](04-db-migration-safety.md) | `NOT VALID`, lock retries, deferred key phase, zero-downtime column drop | breaking |
| [`05-entity-tenant-and-locks`](05-entity-tenant-and-locks.md) | **Security.** Same-tenant composite keys by default; row and key locks | breaking |
| [`06-jobs-step-semantics`](06-jobs-step-semantics.md) | `step.run` gives the stored form on every attempt, and its type says so | breaking |
| [`07-render-stream-hole`](07-render-stream-hole.md) | `<Hole>`, so `stream` streams; the generated default | breaking |
| [`08-testing-mock-fetch`](08-testing-mock-fetch.md) | `mockFetch` by method, in order; `requestLog` | breaking |
| [`09-core-define-error`](09-core-define-error.md) | One declaration for a code, status and class | minor |
| [`10-schema-sensitive-and-rules`](10-schema-sensitive-and-rules.md) | `.sensitive()`, stable issue `rule`, `$view` issues bind | minor |
| [`11-core-outbound`](11-core-outbound.md) | One outbound call: deadlines, caps, safe retry, `dial: 'public'` | minor |
| [`12-core-error-fingerprint`](12-core-error-fingerprint.md) | `errorFingerprint()`: one group for one fault | minor |
| [`13-jobs-bulk-and-rate`](13-jobs-bulk-and-rate.md) | `enqueueMany`; the rate budget that exists, documented | breaking |
| [`14-jobs-inbound-webhooks`](14-jobs-inbound-webhooks.md) | `webhookReceiver()`: exact bytes, durable enqueue, fast ack | minor |
| [`15-jobs-recipes`](15-jobs-recipes.md) | Consumer and cursor-walk recipes pinned by tests; doc corrections | minor |
| [`16-jobs-import-rows`](16-jobs-import-rows.md) | `importRows()`, the twin of `exportRows()` | minor |
| [`17-entity-test-driver`](17-entity-test-driver.md) | The handle follows the migrated test database | minor |
| [`18-ai-scripted-and-meter`](18-ai-scripted-and-meter.md) | `scriptedProvider`, `meteredRun` | minor |
| [`19-cli-deploy-verify`](19-cli-deploy-verify.md) | `x deploy verify`: this build, stable, queues served | breaking |
| [`20-cli-db-diagnostics`](20-cli-db-diagnostics.md) | `x db diagnostics`: blockers, slow queries, unused indexes | minor |
| [`21-cli-verify-and-stop`](21-cli-verify-and-stop.md) | `x verify` alone is the gate, no stale budgets; `x stop` | breaking |
| [`22-cli-upgrade`](22-cli-upgrade.md) | `x upgrade`: one major per run, a section pointer, the gate | minor |
| [`23-ui-live-refresh`](23-ui-live-refresh.md) | `refresh()` keeps focus; polling pauses hidden, stops on session loss | see slice |
| [`23-ui-data-table`](23-ui-data-table.md) | `rowKey` keys, `Pagination` type, list URL state, `Sparkline` `null` | breaking |
| [`24-web-client-errors`](24-web-client-errors.md) | Browser errors reach `ErrorReporter` | breaking |
| [`24-web-i18n-mail-keys`](24-web-i18n-mail-keys.md) | Mail and push keys visible to the gate | see slice |
| [`24-web-admin-audit-trail`](24-web-admin-audit-trail.md) | `/admin/audit` filters and paging | see slice |
| [`25-pkg-auth-totp-replay`](25-pkg-auth-totp-replay.md) | **Security.** TOTP replay across replicas | see slice |
| [`25-pkg-auth-sign-in`](25-pkg-auth-sign-in.md) | `x g sign-in`, `jwtBearerResolver` | breaking |
| [`25-pkg-realtime-client-reads`](25-pkg-realtime-client-reads.md) | `everyMs` over `visibleInterval`; hold only if persisted | see slice |
| [`25-pkg-scraping-wedge`](25-pkg-scraping-wedge.md) | A wedge fire quits; verbs count as activity | breaking |
| [`25-pkg-storage-streams`](25-pkg-storage-streams.md) | `streamRange`, `putStream` | see slice |
| [`26-api-read-contract`](26-api-read-contract.md) | `rows:` in OpenAPI, mount cuts in `contract-diff` | see slice |
| [`26-api-wire-fixes`](26-api-wire-fixes.md) | Mount rate limit honoured, CORS headers, `retry` member, `requestId` | see slice |
| [`27-agents-checkpoint`](27-agents-checkpoint.md) | `onCheckpoint`, crash resume | see slice |
| [`27-agents-context-and-cache`](27-agents-context-and-cache.md) | Compaction from reported usage, overflow recovery | see slice |
| [`27-agents-evals`](27-agents-evals.md) | `defineEval({ agent })`; stale model ids, pulled forward | breaking |
| [`27-mcp-dual-era`](27-mcp-dual-era.md) | Serve MCP `2026-07-28` beside legacy; Origin and version checks | breaking |
| [`27-mcp-oauth-server`](27-mcp-oauth-server.md) | **Owner decision.** OAuth authorization server | breaking |
| [`28-assets-compression`](28-assets-compression.md) | Gzip public text, bounded, never private | breaking |
| [`28-assets-deploy-skew`](28-assets-deploy-skew.md) | **Owner decision on retention.** Old hashed assets survive a roll | see slice |
| [`28-assets-image-contents`](28-assets-image-contents.md) | Tests and docs stay out of the image | see slice |
| [`28-assets-stored-objects`](28-assets-stored-objects.md) | **Security.** Variant fixes, `objectResponse`, `/media` cache headers | see slice |
| [`29-data-large-tables`](29-data-large-tables.md) | Atomic wide bulk write | see slice |
| [`29-data-pg-pooler`](29-data-pg-pooler.md) | Pooler modes, `LISTEN`, idle-in-transaction | breaking |
| [`29-data-pg-unanswered`](29-data-pg-unanswered.md) | Unanswered statements; plain-statement acquire bound | breaking |
| [`29-data-raw-keyset`](29-data-raw-keyset.md) | `keyset()` for raw joins | see slice |
| [`29-data-redis-outage`](29-data-redis-outage.md) | A dead Redis no longer blocks or strands. No adopter runs this tier yet | breaking |
| [`30-perf-entity-decode`](30-perf-entity-decode.md) | Row decode cost | see slice |
| [`30-perf-gate`](30-perf-gate.md) | `errors` step re-masking; split `cli` coverage | see slice |
| [`30-perf-jobs-claim-relay`](30-perf-jobs-claim-relay.md) | Claim scales with due rows; outbox relay | see slice |
| [`31-test-false-green`](31-test-false-green.md) | Skips can't read as green; tests for surviving mutants | minor |
| [`31-test-file-boundary`](31-test-file-boundary.md) | `mock.module` undone at the file boundary | breaking |
| [`32-docs-false-claims`](32-docs-false-claims.md) | Wrong Known-Gaps rows, era stamps, tutorials | patch |
| [`32-docs-findability`](32-docs-findability.md) | `x docs` retrieval, `Upgrading.md` usable | see slice |
| [`32-docs-guards`](32-docs-guards.md) | Guards that stop those drifts recurring | see slice |
| [`33-ops-ci`](33-ops-ci.md) | Tested-tree reuse, named flakes | see slice |
| [`33-ops-deploy-proof`](33-ops-deploy-proof.md) | Proof covers a held job, a migration, six deploys | see slice |
| [`33-ops-worker-roll`](33-ops-worker-roll.md) | Retire on by default, `queue_demand` gauge | breaking |
| [`34-idea-jobs-event-wait`](34-idea-jobs-event-wait.md) | A rolled-back publish wakes nobody; event payload checked | breaking |
| [`35-fix-security`](35-fix-security.md) | **Security.** ISR identity and Host, S3 grants, sniffing, origin, head | breaking |
| [`35-fix-concurrency`](35-fix-concurrency.md) | Parallel replay, cache flights, live-query desync, JWKS | breaking |
| [`35-fix-logic`](35-fix-logic.md) | Replay re-judged, patches unvalidated, parity bugs | breaking |
| [`36-dx-false-fixes`](36-dx-false-fixes.md) | Every false `fix:` the audit hit | breaking |
| [`36-dx-generators`](36-dx-generators.md) | Generators stop inventing entities | breaking |
| [`90-deferred`](90-deferred.md) | Not a slice. Every idea deferred or killed, and what brings it back | n/a |

## Owner decisions
An executor never guesses these. Each row names the recommendation; nothing moves without a yes.

| Decision | Recommendation | If yes |
|---|---|---|
| Release batch A right after sweep 2, as a major | yes: live holes | an outward-facing act: ask first |
| Delete `notify` (0 of 8 adopter repos import it; about 5,600 LOC) | yes, in batch B before 06 | K4 and 06's notify rows go. Also `registrar.ts:88`, runtime schema and purge, tier tables |
| Delete RAG and vector (`ai/src/rag.ts` and friends, about 2,900 LOC; no adopter) | yes. Check `llm-cache.ts` first; it may need `Embedder` | 11's `remote-embedder.ts` row and part of 27-evals go |
| Delete unused `ui` components (8 named; 25 have no tracked use) | decide before sweep 12 | scope of `23-ui-*` changes |
| Delete the rest: `cmd-planned.ts` stubs, `x pr`, `testing/src/harness.ts`, `admin/src/ai-panes.ts`, `time/src/schedule.ts`, `flags/src/projection.ts`, `database.driver`; merge the two fence guards | yes; no slice yet, one PR in batch B | `cmd-planned.ts` before 22. Adopters on old versions may simply not have reached these, so a zero is weaker for newer APIs |
| Prune 1,679 barrel names with no reader | later, name by name | own PR |
| Build the OAuth server (five adopters, 1,000–1,600 LOC each) | yes: security code nobody should rewrite five times, though it's a subsystem and reverses `mcp/src/app-tools.ts:174` | `27-mcp-oauth-server` |
| Keep old hashed assets across a roll | yes, for the zero-downtime goal; no adopter asked | retention half of `28-assets-deploy-skew`; `33-ops-deploy-proof` step 6 needs it |
| `x verify` builds inside `budgets` (21 overrules `cli/src/verify-checks.ts:241`) | yes | `21-cli-verify-and-stop` |
| Adopter names in public docs and source (about 60 non-test lines) | scrub. No slice: a plan cannot list them. The list is the executor's to regenerate with a grep | one PR, then a guard |

## Done when
- Each slice's *Done when*, and its failing-first test failed before the change.
- Reproduced holes refused: an in-app agent on a gated tool, an anonymous visitor on a signed-in user's ISR page, a cross-tenant reference on both drivers, TOTP replay on a second replica.
- Reproduced corruption gone: a write after a 504 or a rollback; parallel steps re-running; a partial `insertAll`.
- Each new code carries a `fix:` and a `wiki/Error-Codes.md` row. Each convention names its build error.
- `wiki/Known-Gaps.md` true and current.
- `bun run verify` green, all 20 steps; `bun run scripts/reference-app-gate.ts` green; `scaffold-smoke` green twice per shape.

## Risks / open questions
- **Upgrade load.** Batches cost adopters real edits, and all six surveyed are behind (^6 to ^28). That's why 22 lands in sweep 3, not with the CLI work. An old app's first `x upgrade` is a re-exec of the newest CLI: test it.
- **05 can find real data.** A validate failing `X_DB_FOREIGN_KEY_VIOLATION` means rows already cross tenants: a finding for the app's owner.
- **02 changes what lands.** A write past `requestTimeoutMs` now rolls back. Accepted cost: a keyed handler's raw `fetch` under `runToCompletion` has no deadline until it uses `outbound()`.
- **07's `async` hydration** rests on HTML semantics. Its enforced-CSP e2e test is the proof; if it fails, the generated default must not flip.
- **S4 refuses XML over 64 KiB at promotion**, because active markup needs the whole body.
- **Slice size.** Sweep totals are estimates from each slice's list. Over 100 at dispatch: split.
- **Evidence limits.** Absence claims come from greps backed by source reads. Probes ran on a loaded shared box with RAM-disk Postgres, so trust ratios over absolutes. Not exercised: live S3, CDN, NATS blackhole, real replica lag, helm or kind, end-to-end `x dev` under load. Adopters on old versions understate demand for newer APIs.
- **Reviewed, not reproduced as bugs:** `x dev` failing to start, the `sync` role dying in `startMetricsEndpoint`, `/feed` and `/runs` 500 in the perf probe. Read as probe environment (second role on one host; `APP_URL` not matching `PORT`). Retest with `APP_URL` set; a row in 36 corrects the metrics fix text.
- **Not covered:** tutorials 1, 5, 6; `docs/ops` claims; realtime multi-node internals; `e2e` and `eval` test quality; hydration mismatches; `Drawer`, `Menu`, `Popover` focus; other frameworks' docs.
- **Open:** `defineFactory` has zero uses in four adopters; `realtime/src/socket-wire.test.ts:10` failed 6 of 6 on one loaded box, and its premise depends on `tcp_wmem`. Worth a look with 31.
- **Claims the code disproved, not planned:** a renamed code passing `contract-diff`; `llm()` reporting no usage; no per-session streaming route; a missing rate budget; `x.verify.json` steps being needed (a guard can spawn).
