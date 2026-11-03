# Make Ultimate the best framework for the world to build on

## Goal
Ultimate is for the world; our own apps are the first users and the battle test. This plan fixes what is broken, adds what serious teams need, and removes what stops a stranger from adopting it. Nothing shipped is deleted. Value first, so stopping after any sweep still leaves the most valuable work done.

The bar for every slice: would a serious team anywhere need this, and is it a mechanism? "Our apps didn't ask" is not an objection; our apps' pain raises priority.

Sources: nine adopters and about 30 other repositories (some only skimmed), a typed-effect library's docs and source, audits of this repository, a stranger's clean-machine run. As of 2026-11, at 29.4.0.

## Context
- Bun only, Postgres with no ORM, SolidJS 1.9.x, `@ultimat3/*` tiers 0–5. No new dependency anywhere in this plan.
- No ninth primitive. New capabilities are factories over a primitive (`PRIMITIVE_FACTORIES`, `packages/core/src/registrar.ts`), options, helpers or CLI commands.
- The typed-effect library is never a dependency: its guarantees are copied, its programming model is not ([`90-deferred.md`](90-deferred.md)).
- Evidence: a slice's *Why* cites a probe run on 2026-11-02, a measured figure, or what a complete framework owes. Probes were throwaway; each slice's failing-first test is the durable copy.
- Semver rule for every slice: a new red verdict in the gate, a compile break on an exported type, a required member on an exported interface or a changed exported constant is breaking. A `PRIMITIVE_FACTORIES` row is additive.

## Decisions, made
An executor doesn't reopen these.

| Decision | Call |
|---|---|
| Delete `notify`, RAG, unused `ui` components, stubs, `x pr`, unread exports | **No.** Keep all of it. K4 in `35-fix-concurrency` fixes `notify` |
| OAuth authorization server | Build, in `auth` (`41-add-identity`) |
| Old hashed assets survive a roll | Yes (`28-assets-deploy-skew`) |
| `x verify` builds inside `budgets`, overruling `cli/src/verify-checks.ts:241` | Yes (`21-cli-verify-and-stop`) |
| `isr` default keys on no query, as promised | Yes (`35-fix-isr-default`) |
| Row security | Off by default, same `tenant:` declaration, a second enforcer (`41-add-row-security`) |
| Scrub adopter names; guard reads names from a secret, never a committed file | Yes (`37-scrub-adopter-names`) |
| Docs site built by Ultimate, reversing `docs/idea/14-roadmap.md:45-46` | Yes (`42-adopt-docs-site`) |
| Release schedule | Below (`42-adopt-stability`) |

## Release schedule
**One new major, v30, carrying the whole plan.** Breaking changes are fine. PRs merge to `main` in sweep order, and no bump is cut until the last sweep lands.

- Before v30: a non-breaking fix to a live hole, and the model-id edit (that id retires 2026-11-30), ship as a patch on `release/29.x`.
- After v30: `42-adopt-stability` applies, with at most one major per 90 days and minors weekly.

Merging the bump PR is the release. **Stop and ask the owner** only for what the slices mark as the final owner step, all outward-facing: publishing the docs site, DNS, repo description, enabling discussions, signing governance, filing issues, asking npm about the name `x`.

## Tiers touched
All of them; each slice's header names its own. Land each sweep's lowest tier first. An import up or sideways is a design error. New legal edges, stated in their slices: `jobs → http` (14). A new subpath, `@ultimat3/core/render-nodes` (`39-testing-render-nodes`).

## Sweeps (one PR each, ≤ 4 agents, ≤ 100 files, merged before the next)
File counts are estimates, about 2,800 in all. Split anything over 100 at dispatch. Lock rule: each slice's *Files to change* is its agent's exclusive set. Before dispatch, intersect the sets in a sweep; two slices sharing a file go to one agent, in the listed order. An agent finishing early is re-tasked with `SendMessage`, never a fifth spawn.

| Sweep | Focus | Release | Slices, in order | Est. files |
|---|---|---|---|---|
| 1 | Security | v30 | `01-ai-tool-gate`, `28-assets-stored-objects`, `35-fix-security`, `25-pkg-auth-totp-replay` | 71 |
| 2 | Tenancy | v30 | `04-db-migration-safety`, `05-entity-tenant-and-locks` | 30 |
| 3 | Name scrub, docs and source | patch | `37-scrub-adopter-names` | 54 |
| 4 | Name scrub, tests and guard | patch | continues the sweep above | 65 |
| 5 | Silent corruption | v30 | `02-db-entity-cancellation`, `03-core-lifetime-helpers`, `06-jobs-step-semantics`, `34-idea-jobs-event-wait`, `22-cli-upgrade` | 62 |
| 6 | Silent corruption | v30 | `35-fix-logic`, `35-fix-concurrency`, `29-data-large-tables`, `35-fix-isr-default` | 60 |
| 7 | Outages | v30 | `29-data-pg-unanswered`, `29-data-pg-pooler`, `30-perf-jobs-claim-relay` | 53 |
| 7b | Deploys | v30 | `19-cli-deploy-verify`, `33-ops-worker-roll` | 49 |
| 8 | Rendering and DX | v30 | `07-render-stream-hole`, `08-testing-mock-fetch`, `36-dx-false-fixes`, `36-dx-generators` | 94 |
| 9 | First hour | v30 | `42-adopt-stability`, `21-cli-verify-and-stop`, `32-docs-false-claims`, `42-adopt-first-hour` | 99 |
| 10 | Front door | v30 | `32-docs-findability`, `42-adopt-agents`, `42-adopt-front-door`, `32-docs-guards`, `42-adopt-outsiders` | 96 |
| 11 | Wire and assets | v30 | `26-api-wire-fixes`, `26-api-read-contract`, `24-web-i18n-mail-keys`, `25-pkg-storage-streams`, `28-assets-compression`, `28-assets-image-contents` | 78 |
| 12 | Core mechanisms | v30 | `09-core-define-error`, `12-core-error-fingerprint`, `10-schema-sensitive-and-rules`, `11-core-outbound` | 95 |
| 13 | Core mechanisms | v30 | `39-core-breaker`, `39-core-otlp-retry`, `39-testing-render-nodes` | 92 |
| 14 | Jobs | v30 | `13-jobs-bulk-and-rate`, `14-jobs-inbound-webhooks`, `15-jobs-recipes`, `16-jobs-import-rows`, `30-perf-gate` | 48 |
| 15 | Gate and deploys | v30 | `20-cli-db-diagnostics`, `33-ops-ci`, `28-assets-deploy-skew`, `33-ops-deploy-proof` | 57 |
| 16 | AI and web | v30 | `18-ai-scripted-and-meter`, `27-mcp-dual-era`, `27-agents-evals`, `17-entity-test-driver`, `24-web-client-errors`, `24-web-admin-audit-trail` | 93 |
| 17 | Live frontend, sign-in | v30 | `23-ui-live-refresh`, `25-pkg-realtime-client-reads`, `23-ui-data-table`, `25-pkg-auth-sign-in` | 85 |
| 18 | Contract | v30 | `39-testing-property`, `39-action-declared-errors`, `39-api-mount-paths` | 83 |
| 19 | The gate attacks | v30 | `40-next-exercise-pass`, `40-next-tenant-proof`, `39-web-a11y-audit` | 94 |
| 20 | Identity and tenancy | v30 | `41-add-reads`, `41-add-identity`, `41-add-row-security` | 88 |
| 21 | Durable jobs | v30 | `39-jobs-event-wake`, `39-action-sagas`, `40-next-job-crash-proof`, `41-add-consumers` | 86 |
| 22 | Data modelling | v30 | `39-db-partitioned-tables`, `41-add-time-series` | 30 |
| 23 | Resilience | v30 | `27-agents-checkpoint`, `27-agents-context-and-cache`, `29-data-redis-outage`, `29-data-raw-keyset`, `30-perf-entity-decode`, `25-pkg-scraping-wedge` | 71 |
| 24 | Production insight | v30 | `41-add-operations`, `39-ops-chart-alerts`, `40-next-fault-drills` | 79 |
| 25 | Plans, data, repro | v30 | `40-next-query-plans`, `40-next-subject-data`, `40-next-repro` | 99 |
| 25b | Entity lifecycle | v30 | `41-add-entity-lifecycle` | 20 |
| 26 | Agents and MCP | v30 | `41-add-agent-wire`, `39-mcp-inline-then-job`, `39-mcp-recipes`, `39-ai-prompt-cache`, `39-testing-cassettes` | 82 |
| 27 | Clients, uploads, content | v30 | `41-add-api-clients`, `41-add-uploads`, `41-add-locale-and-content` | 88 |
| 28 | Capture, graph, shapes | v30 | `41-add-page-capture`, `40-next-app-graph`, `42-adopt-shapes` | 86 |
| 29 | UI kit | v30 | `23-ui-chart-kit`, `23-ui-searchable-select` | 82 |
| 30 | UI kit | v30 | `38-ui-commands`, `38-ui-navigation` | 91 |
| 31 | UI kit | v30 | `38-ui-lists`, `38-ui-pickers` | 82 |
| 32 | UI kit | v30 | `38-ui-drag-layout`, `38-ui-viewers` | 88 |
| 33 | Docs site app | v30 | `42-adopt-docs-site` | 100 |
| 34 | Docs site wiring | v30 | continues the sweep above | 40 |
| 35 | Tests and proof | v30 | `31-test-file-boundary`, `31-test-false-green`, `42-adopt-proof` | 44 |

- Coordinator-only, every sweep: `CHANGELOG.md`, `wiki/Error-Codes.md`, `wiki/Upgrading.md`, `framework.manifest.json` (`bun run manifest`, once), `bun.lock`, `status.yml`, any package's `src/index.ts`, `README.md`, `CLAUDE.md`, and any wiki page two agents both edit. Workers report their text.
- Each PR: `bun run verify`, `bun run scripts/reference-app-gate.ts`, CI green, reviews addressed, merged, `main` pulled. A change to `examples/dummy` budgets regenerates its `x.manifest.json` first.
- Slices landing across sweeps stay `in_progress` until done: `37-scrub-adopter-names` (sweeps 3, 4), `42-adopt-docs-site` (33, 34), `35-fix-concurrency` (K3, K6 in 5, the rest in 6), `35-fix-logic` (L11 in 8, L12 before 18), `30-perf-jobs-claim-relay` (relay half in 14, after 13), `27-agents-evals` (its model-id edit in sweep 1).
- A slice in phases, such as `40-next-exercise-pass` or `40-next-repro`, ships its minor phases first where that helps.

## Plan files
| Slice | Covers | Sweep | Semver |
|---|---|---|---|
| [`01-ai-tool-gate`](01-ai-tool-gate.md) | The confirmation gate reaches in-app agents | 1 | breaking |
| [`02-db-entity-cancellation`](02-db-entity-cancellation.md) | A finished scope refuses writes | 5 | breaking |
| [`03-core-lifetime-helpers`](03-core-lifetime-helpers.md) | Lifetimes in core: retry, joiners, close order | 5 | minor |
| [`04-db-migration-safety`](04-db-migration-safety.md) | Migrations a rolling deploy survives | 2 | breaking |
| [`05-entity-tenant-and-locks`](05-entity-tenant-and-locks.md) | Same-tenant foreign keys; row and key locks | 2 | breaking |
| [`06-jobs-step-semantics`](06-jobs-step-semantics.md) | A step answers what it stored | 5 | breaking |
| [`07-render-stream-hole`](07-render-stream-hole.md) | `<Hole>`: the marker `stream` has been waiting for | 8 | breaking |
| [`08-testing-mock-fetch`](08-testing-mock-fetch.md) | `mockFetch` that can answer a retry test | 8 | breaking |
| [`09-core-define-error`](09-core-define-error.md) | `defineError`: one declaration for a code, its title, its status and its class | 12 | minor |
| [`10-schema-sensitive-and-rules`](10-schema-sensitive-and-rules.md) | Schema facts the framework already wants: `.sensitive()` and an issue's `rule` | 12 | minor |
| [`11-core-outbound`](11-core-outbound.md) | One outbound HTTP call | 12 | minor |
| [`12-core-error-fingerprint`](12-core-error-fingerprint.md) | `errorFingerprint()`: one group for one fault | 12 | minor |
| [`13-jobs-bulk-and-rate`](13-jobs-bulk-and-rate.md) | Jobs: bulk enqueue, and the fleet rate budget that already exists | 14 | breaking |
| [`14-jobs-inbound-webhooks`](14-jobs-inbound-webhooks.md) | Inbound webhooks | 14 | minor |
| [`15-jobs-recipes`](15-jobs-recipes.md) | Long-lived jobs: the pins and doc corrections a consumer rests on | 14 | minor |
| [`16-jobs-import-rows`](16-jobs-import-rows.md) | `importRows()` | 14 | minor |
| [`17-entity-test-driver`](17-entity-test-driver.md) | The handle follows the migrated test database | 16 | minor |
| [`18-ai-scripted-and-meter`](18-ai-scripted-and-meter.md) | `scriptedProvider` and `meteredRun` | 16 | minor |
| [`19-cli-deploy-verify`](19-cli-deploy-verify.md) | `x deploy verify`: production serves this build and stays there | 7b | breaking |
| [`20-cli-db-diagnostics`](20-cli-db-diagnostics.md) | `x db diagnostics` | 15 | minor |
| [`21-cli-verify-and-stop`](21-cli-verify-and-stop.md) | `x verify` alone is the gate; `x stop` ends this checkout's `x dev` | 9 | breaking |
| [`22-cli-upgrade`](22-cli-upgrade.md) | `x upgrade`: one major per run, a pointer to its section, the gate | 5 | minor |
| [`23-ui-chart-kit`](23-ui-chart-kit.md) | Charts a live, mobile dashboard can stand on | 29 | breaking |
| [`23-ui-data-table`](23-ui-data-table.md) | A table that survives live rows and the framework's own pages | 17 | breaking |
| [`23-ui-live-refresh`](23-ui-live-refresh.md) | A server-rendered page that stays true | 17 | minor |
| [`23-ui-searchable-select`](23-ui-searchable-select.md) | Choosing one of many, by value | 29 | breaking |
| [`24-web-admin-audit-trail`](24-web-admin-audit-trail.md) | `/admin/audit` is a trail one can search and page | 16 | minor |
| [`24-web-client-errors`](24-web-client-errors.md) | Browser failures reach the one `ErrorReporter` | 16 | breaking |
| [`24-web-i18n-mail-keys`](24-web-i18n-mail-keys.md) | A catalog key only a mail or a push names is seen by the gate; a mail with a miss is not sent | 11 | breaking |
| [`25-pkg-auth-sign-in`](25-pkg-auth-sign-in.md) | Sign-in that a deployed app can actually use | 17 | breaking |
| [`25-pkg-auth-totp-replay`](25-pkg-auth-totp-replay.md) | A spent TOTP code stays spent across replicas | 1 | breaking |
| [`25-pkg-realtime-client-reads`](25-pkg-realtime-client-reads.md) | Client reads: `useQuery({ everyMs })`, no pointless hold | 17 | minor |
| [`25-pkg-scraping-wedge`](25-pkg-scraping-wedge.md) | The scrape watchdog ends the run on an attached browser | 23 | breaking |
| [`25-pkg-storage-streams`](25-pkg-storage-streams.md) | Storage: a ranged stream and a streamed write | 11 | breaking |
| [`26-api-read-contract`](26-api-read-contract.md) | A read's rows and a mount's cut are published contract | 11 | breaking |
| [`26-api-wire-fixes`](26-api-wire-fixes.md) | Four wire defects and one missing fact | 11 | breaking |
| [`27-agents-checkpoint`](27-agents-checkpoint.md) | `onCheckpoint`: an agent run survives a dead worker | 23 | minor |
| [`27-agents-context-and-cache`](27-agents-context-and-cache.md) | Compaction reads what the provider reported; a real overflow recovers | 23 | breaking |
| [`27-agents-evals`](27-agents-evals.md) | `defineEval({ agent })`, and current model ids in the examples | 16 | breaking |
| [`27-mcp-dual-era`](27-mcp-dual-era.md) | MCP: serve the current protocol revision beside the old ones | 16 | breaking |
| [`28-assets-compression`](28-assets-compression.md) | Public text responses are gzipped | 11 | breaking |
| [`28-assets-deploy-skew`](28-assets-deploy-skew.md) | Hashed assets survive a deploy | 15 | minor |
| [`28-assets-image-contents`](28-assets-image-contents.md) | The scaffolded image carries no tests | 11 | minor |
| [`28-assets-stored-objects`](28-assets-stored-objects.md) | A stored object's variants and its one response | 1 | breaking |
| [`29-data-large-tables`](29-data-large-tables.md) | Large tables: bulk writes all-or-nothing | 6 | minor |
| [`29-data-pg-pooler`](29-data-pg-pooler.md) | Postgres through a connection pooler | 7 | breaking |
| [`29-data-pg-unanswered`](29-data-pg-unanswered.md) | A statement nobody answers | 7 | breaking |
| [`29-data-raw-keyset`](29-data-raw-keyset.md) | Keyset paging for a raw join | 23 | minor |
| [`29-data-redis-outage`](29-data-redis-outage.md) | Redis down is a slow read, not a hang | 23 | breaking |
| [`30-perf-entity-decode`](30-perf-entity-decode.md) | Perf: row decode stops re-deriving column names | 23 | patch |
| [`30-perf-gate`](30-perf-gate.md) | Perf: the gate re-masks every file, and one unit sets CI's wall clock | 14 | patch |
| [`30-perf-jobs-claim-relay`](30-perf-jobs-claim-relay.md) | Perf: the claim seeks, the relay publishes in batches | 7 | minor |
| [`31-test-false-green`](31-test-false-green.md) | Where a green test run says less than it reads | 35 | minor |
| [`31-test-file-boundary`](31-test-file-boundary.md) | The file boundary undoes `mock.module` | 35 | breaking |
| [`32-docs-false-claims`](32-docs-false-claims.md) | Docs: the claims a cold read proved false | 9 | patch |
| [`32-docs-findability`](32-docs-findability.md) | Docs: finding the one way to do X, offline | 10 | minor |
| [`32-docs-guards`](32-docs-guards.md) | Docs: a guard per class of drift that survived the existing ones | 10 | none |
| [`33-ops-ci`](33-ops-ci.md) | CI under five minutes, no tested bytes retested, no named flake left | 15 | minor |
| [`33-ops-deploy-proof`](33-ops-deploy-proof.md) | Prove what zero-downtime claims: jobs, a migration, six deploys | 15 | none |
| [`33-ops-worker-roll`](33-ops-worker-roll.md) | A deploy never cuts a running job, and scaling reads real demand | 7b | breaking |
| [`34-idea-jobs-event-wait`](34-idea-jobs-event-wait.md) | An event wait: atomic answer, parsed payload | 5 | breaking |
| [`35-fix-concurrency`](35-fix-concurrency.md) | Concurrency fixes: replays, stale joins, quiet subscribers | 6 | breaking |
| [`35-fix-isr-default`](35-fix-isr-default.md) | An `isr` route keys on no query unless it says so | 6 | breaking |
| [`35-fix-logic`](35-fix-logic.md) | Logic fixes: drivers that disagree, retries refused, wrong bills | 6 | breaking |
| [`35-fix-security`](35-fix-security.md) | Security fixes: one visitor's answer served to another, unchecked bytes | 1 | breaking |
| [`36-dx-false-fixes`](36-dx-false-fixes.md) | A `fix:` that is false is a bug | 8 | breaking |
| [`36-dx-generators`](36-dx-generators.md) | Generators: green on arrival, no invented tables, a loop that fails | 8 | breaking |
| [`37-scrub-adopter-names`](37-scrub-adopter-names.md) | Adopter names out of the public tree, and kept out | 3 | none |
| [`38-ui-commands`](38-ui-commands.md) | Confirmations, hotkeys and a palette that works by itself | 30 | breaking |
| [`38-ui-drag-layout`](38-ui-drag-layout.md) | Reordering, boards and panes | 32 | breaking |
| [`38-ui-lists`](38-ui-lists.md) | Long lists, trees, timelines and facts | 31 | breaking |
| [`38-ui-navigation`](38-ui-navigation.md) | The mobile frame and the ways around an app | 30 | breaking |
| [`38-ui-pickers`](38-ui-pickers.md) | Dates, windows and bounded values | 31 | breaking |
| [`38-ui-viewers`](38-ui-viewers.md) | Reading what agents and machines write | 32 | breaking |
| [`39-action-declared-errors`](39-action-declared-errors.md) | `errors:` on an action and a query, closed by a red build | 18 | minor |
| [`39-action-sagas`](39-action-sagas.md) | Durable compensation and at-most-once steps | 21 | breaking |
| [`39-ai-prompt-cache`](39-ai-prompt-cache.md) | Prompt-cache rows an app can declare | 26 | minor |
| [`39-api-mount-paths`](39-api-mount-paths.md) | Path parameters: `http.path` is the one spelling | 18 | minor |
| [`39-core-breaker`](39-core-breaker.md) | `breaker()`: one state machine, the trigger stays the caller's | 13 | minor |
| [`39-core-otlp-retry`](39-core-otlp-retry.md) | OTLP export survives a transient failure | 13 | minor |
| [`39-db-partitioned-tables`](39-db-partitioned-tables.md) | Partitioned tables are tables | 22 | minor |
| [`39-jobs-event-wake`](39-jobs-event-wake.md) | A published event wakes its waiter | 21 | breaking |
| [`39-mcp-inline-then-job`](39-mcp-inline-then-job.md) | A long tool that answers inline when it can | 26 | minor |
| [`39-mcp-recipes`](39-mcp-recipes.md) | MCP recipes that cannot go stale | 26 | minor |
| [`39-ops-chart-alerts`](39-ops-chart-alerts.md) | Alert rules an app gets from its chart | 24 | minor |
| [`39-testing-cassettes`](39-testing-cassettes.md) | Cassettes over `mockFetch`, with the written bytes checked | 26 | minor |
| [`39-testing-property`](39-testing-property.md) | Generated inputs inside the `contract` step | 18 | breaking |
| [`39-testing-render-nodes`](39-testing-render-nodes.md) | Public `renderNodes`, from a tier that can be imported | 13 | minor |
| [`39-web-a11y-audit`](39-web-a11y-audit.md) | Every e2e page audited by the browser's own accessibility tree | 19 | breaking |
| [`40-next-app-graph`](40-next-app-graph.md) | `x graph` and `x impact`: the app as one typed graph | 28 | minor |
| [`40-next-exercise-pass`](40-next-exercise-pass.md) | Every primitive runs once, with no test written | 19 | minor, then breaking |
| [`40-next-fault-drills`](40-next-fault-drills.md) | `x drill`: real roles, real services, every failure this plan found | 24 | minor |
| [`40-next-job-crash-proof`](40-next-job-crash-proof.md) | Every job is killed at every step boundary, and races run from a seed | 21 | minor, then breaking |
| [`40-next-query-plans`](40-next-query-plans.md) | A statement no index can serve fails the build, with zero rows | 25 | breaking |
| [`40-next-repro`](40-next-repro.md) | `x repro <id>`: a production failure becomes a failing test | 25 | minor, then breaking |
| [`40-next-subject-data`](40-next-subject-data.md) | `subjectExport()`, `subjectErase()`: one person's data, provably found | 25 | minor |
| [`40-next-tenant-proof`](40-next-tenant-proof.md) | The gate attacks every action, query and job from another tenant | 19 | breaking |
| [`41-add-agent-wire`](41-add-agent-wire.md) | Agents on the wire: tokens to the client, other servers' tools, recall under a filter | 26 | minor |
| [`41-add-api-clients`](41-add-api-clients.md) | One OpenAPI compiler: a client for your customers, a client for your vendors | 27 | minor |
| [`41-add-consumers`](41-add-consumers.md) | `consumer()` and a backfill over a remote source | 21 | minor |
| [`41-add-entity-lifecycle`](41-add-entity-lifecycle.md) | Declared on the entity: how long a row lives, what it was, how many it has | 25b | minor |
| [`41-add-identity`](41-add-identity.md) | Identity: an authorization server, third-party grants, more purposes, a fake provider | 20 | breaking |
| [`41-add-locale-and-content`](41-add-locale-and-content.md) | What a site says: `llms.txt`, mail previews, grammatical choice, amounts typed by a person, the visitor's zone | 27 | minor |
| [`41-add-operations`](41-add-operations.md) | Knowing production: real-user timings, a trace across a live query, error groups, an honest rollback | 24 | breaking |
| [`41-add-page-capture`](41-add-page-capture.md) | Pages as files: PDF, social cards, and images a static site can actually serve | 28 | breaking |
| [`41-add-reads`](41-add-reads.md) | A read's freshness: conditional answers, a null's lease, a replica that has caught up, a bound per read | 20 | minor |
| [`41-add-row-security`](41-add-row-security.md) | The database refuses another tenant's row | 20 | minor, then breaking |
| [`41-add-time-series`](41-add-time-series.md) | Time buckets, rollups, and views the framework can read | 22 | minor |
| [`41-add-uploads`](41-add-uploads.md) | Large uploads that resume, and objects that expire | 27 | minor |
| [`42-adopt-agents`](42-adopt-agents.md) | Adoption: any vendor's coding agent, cold | 10 | minor |
| [`42-adopt-docs-site`](42-adopt-docs-site.md) | Adoption: a docs site, built by Ultimate | 33 | none |
| [`42-adopt-first-hour`](42-adopt-first-hour.md) | Adoption: a stranger's first hour, through the first deploy | 9 | minor |
| [`42-adopt-front-door`](42-adopt-front-door.md) | Adoption: 30 seconds on the README, the npm page, the wiki home | 10 | none |
| [`42-adopt-outsiders`](42-adopt-outsiders.md) | Adoption: contributors, governance, telemetry, third-party packages | 10 | breaking |
| [`42-adopt-proof`](42-adopt-proof.md) | Adoption: comparison pages, migration guides, benchmarks anyone can re-run | 35 | none |
| [`42-adopt-shapes`](42-adopt-shapes.md) | Adoption: starters for the common app shapes | 28 | minor |
| [`42-adopt-stability`](42-adopt-stability.md) | Adoption: a stability promise, and slower majors | 9 | none |
| [`90-deferred`](90-deferred.md) | Not a slice. What was rejected, and why | n/a | n/a |

## Done when
- Each slice's *Done when*, and its failing-first test failed before the change.
- Reproduced holes refused: an in-app agent on a gated tool, an anonymous visitor on a signed-in user's ISR page, a cross-tenant reference on both drivers, TOTP replay on a second replica.
- Reproduced corruption gone: a write after a 504 or a rollback, parallel steps re-running, a partial `insertAll`.
- A stranger on a clean machine goes from nothing to a deployed app with no edit by hand, and the first page, first feature and first deploy are timed in CI.
- The gate attacks: every action, query and job runs with no test written and from another tenant, and every job is killed at each step boundary.
- Each new code carries a `fix:` and a `wiki/Error-Codes.md` row. Each convention names its build error.
- `wiki/Known-Gaps.md` true and current.
- `bun run verify` green, all 20 steps; `bun run scripts/reference-app-gate.ts` green; `scaffold-smoke` green twice per shape.

## Risks / open questions
- **Upgrade cost.** v30 is one large hop for existing apps. `x upgrade` lands in sweep 5, and its first run on an old app re-execs the newest CLI: test it. `wiki/Upgrading.md` needs v30 entries a reader can follow.
- **Live holes until v30.** Breaking security rows reach users only with v30, so sweeps 1–2 go first and v30 should not wait on anything optional.
- **New kit surface carries a cost.** Every new component and factory is API under semver, forever. Each slice has one idiomatic use in `examples/dummy` so it can't rot silently.
- **05 can find real data.** A validate failing `X_DB_FOREIGN_KEY_VIOLATION` means rows already cross tenants: a finding for the app's owner.
- **02 changes what lands.** A write past `requestTimeoutMs` now rolls back. Accepted cost: a keyed handler's raw `fetch` under `runToCompletion` has no deadline until it uses `outbound()`.
- **07's `async` hydration** rests on HTML semantics. Its enforced-CSP e2e test is the proof; if it fails, the generated default must not flip.
- **Row security, sagas and the event-wake race** were designed from code but not fully run: `39-action-sagas` unprobed, the wake race not run, `41-add-row-security` needs a non-superuser role on every engine. Their first tests are the proof.
- **The exercise step's budget is unmeasured.** `40-next-exercise-pass` and `39-testing-property` must fit the gate's time target or lower their run count.
- **Evidence limits.** Absence claims come from greps backed by source reads. Probes ran on a loaded shared box with RAM-disk Postgres, so trust ratios over absolutes. Not exercised: live S3, CDN, NATS blackhole, real replica lag, helm or kind, macOS and Windows first runs, host recipes.
- **Reviewed, not reproduced as bugs:** `x dev` failing to start and `/feed`, `/runs` 500 in the perf probe, read as probe environment (`APP_URL` not matching `PORT`). Retest. A row in 36 fixes the `sync` metrics port message.
- **Not covered:** tutorials 5, 6; realtime multi-node internals; hydration mismatches; other frameworks' docs (only the typed-effect library was read).
- **Open:** `realtime/src/socket-wire.test.ts:10` failed 6 of 6 on one loaded box, and its premise depends on `tcp_wmem`. Worth a look with 31.
