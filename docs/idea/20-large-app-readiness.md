# Ready for a very large app

**The primitives were enterprise-grade; the boot was not.** A seven-part audit of every package `As of 2026-08` found that the dominant defect was not a missing feature — it was a mechanism **fully built, publicly exported, and never called by the shipped boot**. The transactional outbox, the durable scheduler watermark, the shared cache tier, WebSocket authentication, live-query re-authorization, the policy decision trace: each existed, each was good, none ran.

That failure mode is worse than absence. An absent feature is discovered on day one. A built-and-uncalled one is discovered in production, because the docs, the manifest and `x jobs show` all read as if it ships — and the audit found the same shape three more times over: a `job.concurrency` enforced by nothing, an `X_CACHE_UNTAGGED_QUERY` reserved and never raised, a `rotateSession` listed as a non-negotiable with no caller.

**Every row in the table below is now closed**, and closing them was mostly wiring rather than building. The diagnosis is kept here rather than deleted because it is the part that generalises: the next capability will arrive the same way, and the question to ask of it is not "is it built" but "who calls it".

This doc grades Ultimate on the two axes a company like Uber, Amazon or Meta actually applies — **what the framework already does** and **whether they can plug their own infrastructure into it** — and names what is missing. It is the *capability* axis. Deployment rungs are [`17-scale-ladder.md`](./17-scale-ladder.md); client platforms are [`16-app-targets.md`](./16-app-targets.md); the ship/don't-ship rule every judgement below is scored against is [`19-mechanism-not-convention.md`](./19-mechanism-not-convention.md).

## What is already there

Not hedging: this list is long, and a large-app team would keep every row.

| Capability | Why it counts at size | Anchor |
|---|---|---|
| Deny-by-default authz, enforced by the **type system** | An action without a policy does not compile. Not a lint, not a review item | [`action/src/action.ts:84`](../../packages/action/src/action.ts) |
| One `Policy` object, four surfaces, one adapter table | A fifth surface is one adapter. Two authz systems is how Meteor-likes died | [`policy/src/surfaces.ts:114`](../../packages/policy/src/surfaces.ts) |
| Permission typos are **compile** errors, validated at declaration time | `PermissionRegistry` module augmentation, not a runtime string | [`policy/src/permissions.ts:17`](../../packages/policy/src/permissions.ts) |
| Tenant derived from the actor; a disagreeing predicate **refused, never rewritten** | Rewriting answers the wrong question correctly. Covers the write path and `on conflict` targets | [`entity/src/tenancy.ts:135`](../../packages/entity/src/tenancy.ts) |
| Keyset-only pagination; no `offset` exists on the read surface | Includes the millisecond-window seek that stops a `Date` cursor silently dropping a row against `timestamptz` | [`entity/src/pg-sql.ts:58`](../../packages/entity/src/pg-sql.ts) |
| Migration advisory lock on **one pinned session**, checksum ledger, live post-migrate drift check | An edited applied migration is refused; `ROLE=migrate` exits non-zero on drift | [`db/src/migrate.ts:178`](../../packages/db/src/migrate.ts) |
| N+1 detection as a **failing test**, not a warning | Grouped by `entity.op`, with one explicit suppression mechanism | [`entity/src/n-plus-one.ts:24`](../../packages/entity/src/n-plus-one.ts) |
| Lease heartbeat checking expiry on **both** sides of the renewal call | Rare and correct: a hung connection never rejects, and a late success must not restart the clock | [`jobs/src/heartbeat.ts:76`](../../packages/jobs/src/heartbeat.ts) |
| One serial FIFO lane per query id, entered for all entries before any is awaited | The strongest engineering in the repo. A slow lane cannot set the node's pace | [`realtime/src/live-query.ts:300`](../../packages/realtime/src/live-query.ts) |
| Cache promotion carries **remaining** life read from `PTTL`, server-side | Survives clock skew, and a hot key still goes stale enough to refetch | [`cache/src/tiers.ts:121`](../../packages/cache/src/tiers.ts) |
| Body cap enforced **while streaming**, stream cancelled the instant the total passes | Most frameworks check `content-length` and lose | [`http/src/request.ts:38`](../../packages/http/src/request.ts) |
| Upload content type decided by **magic bytes**; declared/sniffed contradiction rejected | Closes stored XSS at the one seam it enters | [`storage/src/upload.ts:75`](../../packages/storage/src/upload.ts) |
| One generic credential failure on every rejection path | Account enumeration closed by construction, on passwords and API keys alike | [`auth/src/api-keys.ts:88`](../../packages/auth/src/api-keys.ts) |
| Revocation with **no stale-claims window** — the user row is re-read every request | Better than a JWT-claims design, and easy to lose by accident | [`auth/src/auth.ts:251`](../../packages/auth/src/auth.ts) |
| Money as integer minor units + currency, with conversion **provenance** | A finance audit can reproduce every converted amount | [`money/src/convert.ts:31`](../../packages/money/src/convert.ts) |
| Flag expiry as a **compile-time** proof | Axiom 3 done properly: an unexpiring temporary flag does not typecheck | [`flags/src/flag.ts:78`](../../packages/flags/src/flag.ts) |
| Stable machine-readable error contract, one rendering across terminal / `problem+json` / overlay / `--json` | Closed framework status table; `registerErrorStatus` refuses to remap a framework code | [`http/src/error-map.ts:12`](../../packages/http/src/error-map.ts) |

## The dominant defect: built, exported, never called

Every row is a mechanism that exists and works, whose only missing piece is a call site in [`packages/cli/src/dev-runtime.ts`](../../packages/cli/src/dev-runtime.ts) or [`dev-roles.ts`](../../packages/cli/src/dev-roles.ts).

The **Was** column is the state the audit found. The **Now** column is this sweep's result — every row was closed by calling a mechanism that already existed, not by building one.

| Mechanism | Was — what actually happened | Now |
|---|---|---|
| Transactional outbox | `SQL_OUTBOX_*` had **zero non-test callers**, `x_outbox` was never created, no relay started — so every `enqueue()` published outside the caller's transaction, and both failure modes [`04-jobs.md`](./04-jobs.md) claims it removes were live | **closed** — `createPgOutboxStore`, relay started per role |
| Durable scheduler watermark + leader | The boot passed neither `state` nor `leader`, so the watermark was a `Map` and every pod was leader. A missed nightly run was never *detected* as missed | **closed** — and `createPgLeader` turned out unsafe on a pool (a session advisory lock dies when the connection returns), so a lease row replaced it |
| Shared cache tier | `createRedisTier`, `createLruTier`, `createCacheStack` — **zero callers**. Twelve pods held twelve private LRUs and `x cache bust` cleared one | **closed** — tiers selected from the environment, plus a cross-instance invalidation seam |
| WebSocket authentication | Did not exist. `actorId: null` was **hardcoded** at upgrade, so every channel guard, live-query gate, presence row and tenant cap evaluated against `null` | **closed** — `createSyncNode({ authenticate })`. Realtime was single-tenant-only before this |
| Live-query re-authorization | `reauthorize` and `onActorChange` were well written and called only by their own tests, so a socket once accepted was authorized forever | **closed** — re-auth on a timer; a revoked actor closes the socket |
| Policy decision trace | `evaluate()` built a full trace and **all four adapters discarded it**, so "who accessed this record, and which rule allowed it" had no answer | **closed** — one `DecisionSink`, emitted inside `evaluate()` so a fifth surface inherits it |
| `job.concurrency` | Declared, documented, in the manifest, enforced by nothing — `concurrency: 1` ran on every worker while `x jobs show` confirmed the guarantee | **closed** — a fleet lease, and a driver that cannot enforce it now refuses at startup |
| OTLP export | `OTEL_EXPORTER_OTLP_ENDPOINT` was in the shipped chart and **no code read it** | **closed** — `otlpSpanExporter()`/`otlpMetricExporter()`, OTLP/HTTP JSON, no new dependency |

**The root cause is one missing field.** `ServeOptions` is `{ root, env, role?, port?, metricsPort? }` ([`cli/src/serve.ts:111`](../../packages/cli/src/serve.ts)) — there is nowhere to hand the framework a driver. And the one override path that does exist is a race: `startServices` captures its own drivers into `RunningServices`, *then* `loadApp` imports the app module that calls `setJobDriver(theirs)`. The ambient slot changes; the captured object does not. **`enqueue()` writes to their queue and the worker claims from Postgres, silently** — and the `/_x` panel reads the ambient driver, so the dashboard agrees with the enqueue side and disagrees with reality.

## Extensibility: better than advertised, and one field short of true

[`19-mechanism-not-convention.md`](./19-mechanism-not-convention.md) says there is no plugin API and none is planned. As a description of the code that is **false, in the framework's favour**: there are **38 named driver/adapter/transport interfaces, 37 of them publicly exported**, and ~25 registration functions. That is a plugin API by every property that matters. The cost of denying it is that nobody wrote the page listing them — which is why half are unwired.

| BigCo wants to plug in | Reachable today? |
|---|---|
| Their metrics backend, error reporter, tracer | **Yes** — `configureMetrics` / `configureErrorReporting` / `configureTelemetry`, no-op defaults, driver on the wire |
| Their object store | **Yes**, interface-wise — but see the capture race above |
| Their secret manager | **Yes** — *"the real environment always wins"* ([`core/src/secrets-store.ts:127`](../../packages/core/src/secrets-store.ts)); write into `process.env` before `defineEnv` |
| Their identity service | **Yes** for authorization — `configureAuthenticator` resolves an `Actor` per request, and `ActorFacts` carries their permission service's answer, resolved once at the boundary |
| Their feature-flag control plane | **Yes** — `applyFlagSnapshot`, with unknown keys reported not thrown, *because a control plane is routinely ahead of a deploy* |
| Their own row store | **Yes** — `Driver` is one method, and the package exports every error factory **so a third-party driver can raise the same refusals**. The best-documented seam in the repo |
| Their queue | **Interface yes, boot no** — `JobsConfig.driver` has no reader; the boot always builds `createPgDriver` |
| **Their enterprise IdP** | **Now yes.** It was a closed union of `github \| google \| apple` — Okta, Entra and Ping were unrepresentable, and the constraint was a **type**, so there was no runtime escape. A provider now registers; PKCE stays the literal `true`, so the opening cannot be used to register a PKCE-less provider |
| **Their model gateway** | **Now yes.** `ModelId` was a closed three-entry union threaded through `Provider`, `GenerateRequest` and the pricing table: naming a foreign model did not typecheck, and naming a Claude id to get past `tsc` charged Anthropic list prices to their budget ledger. A model now registers with its own spec, which is also how a negotiated rate is expressed |
| Global HTTP middleware, a shared rate-limit store, a shared ISR store | **Fields exist, boot must pass them** — `createServer` and `createIsrController` have always accepted them. A shared **rate-limit store** still has no driver, so `scope: 'shared'` is a declaration nothing can yet satisfy; that refusal is deliberate and loud |

**The reference app is the proof, from the inside.** [`examples/dummy/CLAUDE.md`](../../examples/dummy/CLAUDE.md) records that its own OAuth `start`/`callback` descriptors are *"declared and driven by `login.test.ts`, but not served"* — because an app's HTTP surface is composed inside [`cli/src/serve.ts`](../../packages/cli/src/serve.ts) out of actions, queries, assets, storage, islands and page routes, and **there is no seam by which an app contributes a raw `Route`**. `configureAuthenticator()` is the only app-installed hook of that shape. The consequence, stated in the app's own words: nobody can hold a session in the reference app. That is the missing injection field observed from inside an application rather than inferred from the framework, and it is the cheapest available acceptance test for closing it.

Two structural exceptions are worth copying rather than reinventing. **`guards/` is the best gate seam in the repo** — a directory scan, no registration, held to the error contract, riding an existing `x verify` step so "green" keeps meaning one thing. And the **env schema is fully app-owned**: unknown keys are reported, never fatal, *because apps set keys nothing declares*.

## What a very large app must still build itself

Scored against axiom 8. "Ship" means four teams would otherwise build the **same** thing; "never" means they would build **different** things.

| Missing | Verdict | Because |
|---|---|---|
| Notifications — channel fan-out, preference gate, digest window, delivery ledger, in-app inbox | **Ship**, as a job factory | Both tracked apps already hand-rolled it: 484 lines in the demo, 250 more in the reference app, structurally identical. The notification *taxonomy* and `quietHours` must never ship |
| Entity-level full-text search + faceting | **Ship**, as a query factory over a `searchable()` column | The framework already contains a correct FTS + RRF implementation — bound to the RAG table and unreachable from an entity. A hand-rolled `to_tsquery` from user input is an injection or a seq scan |
| Outbound webhooks + inbound verifier | **Ship**, as a job factory | [`19-mechanism-not-convention.md`](./19-mechanism-not-convention.md) names this by hand as a mechanism the framework should own. Neither direction ships today |
| Form binding to an action's input schema | **Ship** | Every ingredient exists and none are connected: the schema, `safeParse`'s issue paths, the typed client, `Field`'s error slot. The 40th form in a monolith is 40 hand-written issue-path mappings |
| Async export of a large dataset | **Ship**, as a job factory | Streaming a paged read to object storage with a resumable cursor is identical for a bank and a blog. The *columns* are the app's |
| Durable admin audit sink | **Ship** | The interface is right; the default is an in-memory ring. Compliant in dev, silently amnesiac in production |
| State machine over an entity column | **Ship**, as a mutator factory | An illegal transition is a defect in every business. An *approval chain* is not — that stays the app's |
| Streaming and a tool loop from `llm()` | **Ship** | Without them the first agentic feature calls the gateway directly and loses policy, budget, schema, span and manifest row — every property `llm()` exists to provide |
| Read replicas | **Ship, or refuse in writing** | No read/write split exists at any layer. Leaving it undecided means every team that saturates a primary forks the framework |
| Payments, invoices, tax, subscriptions | **Never** | Ruled out by name. `allocate` and `ConvertedMoney` are the two hard parts, and they ship |
| Charts | **Never** | `tokens.ts` is the declared seam and it is the right one |
| Plans, tiers, entitlements, a seat ledger | **Never** | Business convention. The reference app proves the seam works in ~80 lines |

Nothing on the ship list needs a ninth primitive. Each is a **factory over an existing one** — the rule [`llm()`](../../packages/ai/src/llm.ts) and [`backfill()`](../../packages/jobs/src/backfill.ts) already established.

## What breaks at each rung

The app code does not change. What changes is which of the above stops being optional.

| Rung | What newly breaks | Root |
|---|---|---|
| **Laptop** | Nothing. This is the rung the framework is genuinely finished for | — |
| **One small server** | Idle-slide writes one row per authenticated request; a cache stampede at each TTL boundary; `updateWhere` materialises every row it touches | Single-process assumptions that are correct here |
| **Many big servers** | Idempotency, rate limits and job concurrency all silently multiply by replica count; cache invalidation clears one pod; a cross-node reconnect always full-snapshots; the scheduler double-fires during every rolling restart | **Per-process defaults with no shared store shipped**. `assertRateLimitScope` refuses a `'shared'` declaration nothing can satisfy |
| **Datacenter** | Change fanout is at-most-once over core NATS with **no gap detection** — a 2-second blip leaves a node's subscribers stale forever, on healthy sockets, with nothing to trigger a re-snapshot | `entry.lsn = change.lsn` accepts any forward jump silently |

**The 50,000-socket benchmark measures the first three rungs, not the fourth.** The bench server registers zero live queries, has no database, no policy, no presence and no auth, and never crosses NATS — so *"156,851 attempts shed before any query path"* is true because there is no query path. What it proves is Bun's accept path, the `AcceptBudget` and channel fanout over an in-process transport, recovering from `SIGKILL`. The number that matters for a large app is the other one: **p90 time to the first patch on the reconnected socket, 105 seconds**, budget-bound, on one node. That is reachability; whether anything was *lost* is the delivery run's question, and it is answered only at 10,000 clients — 1,666,882 patches, 0 lost, `As of 2026-08`. [`scripts/bench/restart-bench.ts`](../../scripts/bench/restart-bench.ts).

## True today vs intended

| Claim | State |
|---|---|
| Deny-by-default authz, one rule, every surface | **true** |
| Tenant isolation on read and write, refused not rewritten | **true** as mechanism; **unproven end to end** — no tracked app demonstrates it, and the reference app is pinned red on `X_TENANCY_UNSCOPED` |
| `x verify` green = shippable | **true of the framework**; no Ultimate *application* in this repo is green — 7 of 17 steps pinned red on the reference app, 2 on the deployed demo ([`scripts/lib/gated-apps.ts`](../../scripts/lib/gated-apps.ts)) |
| Transactional outbox on by default | **true**, newly — it was built and never installed |
| A trace crosses HTTP → job | **true**, newly. The HTTP root span honours the inbound `traceparent` and mints a valid 32-hex id where it used to mint a dashed UUID no collector accepts; `x_jobs` carries `traceparent` and the worker parents the job span to it |
| …and on to a live query | **false** — the realtime path carries a producer id and sequence for gap detection, not a trace context |
| An app can swap any driver without forking | **true** — both closed type unions are open: an OIDC provider registers, and so does a model with its own prices. The built-ins register through the same call an app uses, so there is still one way |
| Rate limits and idempotency enforce the number they declare | **true where declared** — both now refuse at boot rather than silently multiplying by replica count. A shared idempotency store ships; a shared **rate-limit** store does not, so `scope: 'shared'` is a declaration only Postgres-backed idempotency can currently satisfy |
| Realtime is multi-tenant safe | **true** as mechanism, newly — a socket is authenticated at upgrade and re-authorized on a timer. The per-tenant subscription cap is reachable but needs both `maxPerTenant` and `tenantOf` to arm |
| Errors carry a stable code, cause and executable fix | **true** — the six `fix:` lines naming commands that do not exist are corrected, and the gate now refuses a `fix:` citing an unshipped command. Note the check is conditional: an env-var or code edit is executable without citing a command |
| A `cause:` cannot leak a rejected value | **false** — `error-render` refuses an `unknown` reaching a `cause:`, and is structurally blind to a caller-controlled `string`. Three log-injection holes shipped under a green check ([#97](https://github.com/developerz-ai/ultimate/issues/97)) |

## What would make this a mistake

The thesis is that one very large app can be built entirely inside Ultimate. Two measurable triggers would falsify it.

**If closing the ship list above takes more than two new packages.** The audit's answer is `notify` and `search` — everything else is a factory over an existing primitive in an existing package. A third and fourth new package would mean the eight primitives do not span what a large product needs, and the primitive set, not the roadmap, is what needs revisiting.

**If a real adopter's first week produces a `packages/platform/` the framework should have owned.** The estimate from both tracked apps is 8–12k lines — notifications, search, webhooks, exports, forms. That number is the metric. If it does not fall as the ship list lands, the gap was never the features; it was the boot that never called them.
