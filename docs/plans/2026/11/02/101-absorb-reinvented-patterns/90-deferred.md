# 90 — Deferred and killed

> Part of [`overview.md`](overview.md). Not a slice: nothing here executes. It stops these being re-proposed without new evidence.

## Deferred: real, but not worth it yet
| Candidate | Evidence | Why not now | Comes back when |
|---|---|---|---|
| `breaker()` in `core` | four repositories; one private copy at `db/src/replica-client.ts:78`; `ai/src/gateway.ts:339` re-spends its retry budget on a down provider | adopters agree on the state machine and disagree on the trigger (one folds durable app rows), which `docs/idea/19-mechanism-not-convention.md` treats as weak; it also rewrites a working replica breaker | two adopters on [`11-core-outbound.md`](11-core-outbound.md) wrap it the same way |
| `action({ errors })` projected to OpenAPI and MCP | probe: paths byte-identical across thrown codes, keys `200, 400, 403, 422` | no adopter asked; optional, and "declared means closed" could only be a log line, which fails axiom 3. A renamed code already fails `contract-diff` (`manifest/src/diff-registries.ts:86-92`) | an adopter's client needs per-operation refusals, or closure can be a build error |
| `arbitrary()`, `exerciseAction()` | probe: `.contract()` passes with 0 handler runs; a real call gives an uncoded `TypeError` | no adopter; off the gate by necessity; a second schema walker beside `action/src/sample-input.ts:169` | it can run inside the `contract` step in budget |
| MCP recipes, `defineAppMcp({ recipes })` | two adopters, 428 and 915 LOC | `resources:` carries recipes by hand (`mcp/src/resources.ts:21`); four codes for optional text | a third adopter, or a stale-recipe incident. Until then `UltimateError.docs`' `docs://recipes/…` example (`core/src/errors.ts:38`) resolves only if the app serves it |
| Cassette record and replay | three adopters, about 140 hand-scrubbed fixtures in one | [`08-testing-mock-fetch.md`](08-testing-mock-fetch.md) already covers what their helpers add; recording plus a redactor is four codes | adopters still hand-write fixtures after 08. The property worth keeping: no value of a redacted env key may appear in the written bytes |
| `x db diagnostics` admin screen | six adopters use a dashboard | the same function, one more projection | after [`20-cli-db-diagnostics.md`](20-cli-db-diagnostics.md) is used |
| Codemod registry, per-row `Codemod` marker for `x upgrade` | 202 breaking entries in one major | the first codemod edits pins; no engine earned yet | the checklist shows one mechanical edit repeating across hops |

## Killed: false, shipped, a second way, or a business convention
| Candidate | Reason |
|---|---|
| Structured-concurrency helper `all()` plus a raw `Promise.all` guard | a second way; tracked apps' sites are reads. The real defect, a straggler autocommitting after rollback, is fixed in [`02-db-entity-cancellation.md`](02-db-entity-cancellation.md) |
| Dead-letter uncoded defects on attempt 1 | retries are bounded, a hotfix can rescue a run, a vendor's HTML 502 is a `SyntaxError`; `core/src/error-retry.ts:176` documents the choice |
| `step.run(…, { compensate })`, `step.once` | no adopter evidence for compensation; needs a new row state across three drivers. `once` has one adopter and unclear failure semantics |
| Fleet rate seam on `job()` | the public limiter already defers uncounted; documented in [`13-jobs-bulk-and-rate.md`](13-jobs-bulk-and-rate.md) |
| `consumer()`, remote-cursor `backfill.source` | keyed concurrency, a `task` and `ctx.signal` express them; recipes in [`15-jobs-recipes.md`](15-jobs-recipes.md). `ROLES` stays closed |
| OpenAPI-driven `serviceClient`, generic delivery ledger | generator cost against a small measured adopter; weak signal, endpoint-shaped seam |
| `$input` on entities | `$view` as input already works; its path defect is fixed in [`10-schema-sensitive-and-rules.md`](10-schema-sensitive-and-rules.md) |
| `toJson()`, JSON readers | `parse(t.json(), value)` is the one way |
| Inline-then-job MCP tools, fail-closed MCP audit | `.job()` plus a query composes it; `audit: true` already fails the call (`action/src/audit-gate.ts`) |
| Docs compiled from source | `llms.txt` is generated; the 181-fence ratchet ships |
| `x db query --readonly`, sealed-column refusal | `db.query` over `x mcp serve` is that path; sealed columns hold ciphertext |
| `entity({ retain })`, `entity({ history })`, counter caches, scoped `statement_timeout` | `purge()` expresses retention; `setRowObserver` plus a wrapper, and audit fields are business; `upsertAll`, `lock` and `readOnlyQuery`'s `timeoutMs` cover the rest |
| `x run --as --reason` | `action.as` and audited admin actions over MCP exist; a reason is business; a CLI `--as` is unauthenticated |
| `x.verify.json` external steps | a guard is any async function and already spawns (`cli/src/guards.ts:33`) |
| Dev services in `x stop`; worker sizing and Bun pin in `x verify` | the app's compose file; stale claim, memory budget since 22.7; floor enforced |
| Browser time-zone cookie writer | the cookie means a person's choice (`time/src/context.ts:40`); an auto-writer overrides it |
| Feature-tax ledger, one-implementation ratchet, silent-kinds census | a falling ceiling games axiom 9; retry shape unprovable by lint; needs production data |
| Secret-scan verify step | dependency bar; a guard can spawn a scanner |
| `errorIssueJob()`, stored views, behavioural monitors | business choices; `ErrorReporter` is the seam. One adopter, composes over primitives. App-level `task` |
| `fallbackModels` | owner-rejected, `docs/history/ai.md:578` |

## Cut in the whole-plan review
Drafted, evidence kept here, slice file removed.

| Candidate | Evidence | Why not now | Comes back when |
|---|---|---|---|
| Chart alert rules in the Helm chart | two adopters | off by default, hand-copied into app charts | an adopter's chart can consume them as they stand |
| OTLP export retry | probe: one 503 lost 2 of 4 spans | no adopter evidence | a lost-trace incident |
| Accessibility audit in e2e, no engine | four apps, two repositories | existing apps opt in by hand, against axiom 3 | it can be on by default for a scaffold, in budget |
| Searchable select | four apps | adopters import `Combobox` zero times; the cause is unknown | someone learns why they don't |
| Chart gaps, tones, `StatTile` | four apps | adopters render zero of today's charts. The `Sparkline` `null` bug stays, in [`23-ui-data-table.md`](23-ui-data-table.md) | an adopter renders a framework chart |
| Mount path parameters | reopened on new evidence: two adopters and one other API, one 792-LOC `/v1` | a third URL spelling beside `http.path` and `runtime.routes` (axiom 1) | it can replace one of the two |
| Worker wake on a durable event | 2,880 replays per 24 h wait at the defaults, arithmetic | the wake statement was never run, and no tracked app calls `waitForEvent`. The rollback fix and schema check stay in [`34-idea-jobs-event-wait.md`](34-idea-jobs-event-wait.md) | an adopter's waits show the cost |
| Partitioned-table drift | one design doc; children cause a false `X_DB_DRIFT` | no partitioned table exists yet | the first one does |
| Provider `promptCache` option | one adopter | weakest agent candidate | a second adopter |
| Render-node test helper | 43 test moves, two adopters | a `ui → testing` import fails `boundaries` as drafted | it has a legal home |

## Killed in the end-to-end sweeps
| Area | Candidates and reason |
|---|---|
| API | ETag on reads, `rpc` reaching a mount, SSE streaming client, bulk endpoints, API key wrappers: no adopter on the framework asks, or the wrapper holds business columns. TypeScript SDK generation stays killed |
| MCP, agents | Parking or deferred tools (`docs/history/ai.md:766`), production-failure eval harvest (a business detector), agent `.stream()`, remote MCP client, registered cache rules |
| Assets | Site image renditions (needs an encoder), font subsetting (a one-off toolchain), OG generator (`x shot` covers it), PDF and video (app-owned), `modulepreload`, per-route CSS |
| Data stores | Multi-database (false claim), negative query TTL, rollups and time buckets (shapes differ), row-level security, vector, replica LSN, multipart, lifecycle, backup commands, NATS changes |
| Packages | Flag store and report, notify additions, open verification purposes, API key extras, amount parsing, live-query traceparent |
| UI | Confirm dialog (three designs), time range, toast, copy, skeleton, status map, hotkeys, virtual list, motion, density, multi-step forms, pull-to-refresh: a look, or already shipped |
| Web | `llms.txt` generator (contents disagree; a route carries it), OG rendering, `formatNumber` (`Intl` is the documented way, `wiki/I18n.md:179`), ICU (no usage), saved views (the URL is the view), web vitals (no collectors), mail preview. Sitemap, hreflang, JSON-LD, locale routing, RTL, service worker, push, offline queue, bulk actions, CSV, upload UI, contrast, reduced motion: shipped |
| Ops | `x rollback`, tag pruning, production `x status` and `x logs`, incident tool, backups, dashboard JSON: platform or app-specific (axioms 7, 8) |
| Perf | Pipeline overhead (flat, 137 µs), reading steps at settle, Babel at boot, per-island runtime, `manifest` memory: measured, not worth a change |
| Docs | Dead links, CLI flags, prose signatures, planned claims, unknown code citations: sampled clean |
| Tests | Mutation gate step (too slow for free runners), assertion, sleep and fixed-port guards (under 0.5% hits), retry and flake quarantine (`wiki/Testing.md:813` forbids), snapshot helper, fake IdP (two adopters, one owner) |

## From the typed-effect library, rejected as a model
Its core program type, generators, `pipe`, `Layer`, fibers, in-process `Queue`/`PubSub`/`Ref`, `Stream`/`Sink` as public API, Schedule combinators, implicit request batching, `Config` providers, `Exit`/`Result` values, cluster and workflow modules, RPC, event log, HTTP API builder, CLI builder, atoms. Each is a second programming model or a second path beside a primitive. A later read of its framework modules' source confirmed this, with thin spots: its sharding internals, event log, devtools, most of atom and its RPC client were read by header or grep only. The ideas that survived are in slices 02, 03, 06, 10 and the event-wait guarantee in 34.
