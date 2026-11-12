// The serve graph's module count for `ROLE=migrate`, each raise stated with its number and reason.
// `serve-graph.test.ts` holds a build to it; the serving roles' ledger is
// `serve-graph-serving-ceiling-fixture.ts` and the web role's `serve-graph-web-ceiling-fixture.ts`,
// each split off at the file ceiling.

/**
 * measured: 558 modules (`Bun.build` metafile, static edges from `serve-entry.ts`, 2026-10-01) —
 * 869 until the services and the role boot went behind `serveApp`'s `await import()`.
 * why: every ceiling here is the measurement plus 10%, so a real feature on the boot path fits and
 * a whole subsystem arriving does not. Raise one with the new measured number in the same diff.
 * raised 615 → 620, measured 620 (2026-10-06, plan 101 sweep 10b): the modules named on
 * `SERVING_ROLE_CEILING` for sweep 10b that `ROLE=migrate` reaches through the db and entity
 * barrels — the append-only trigger it must create and the drift check that refuses a missing one.
 * raised 620 → 622, measured 622 (2026-10-06, plan 101 sweep 10c): `mcp/src/confirmation-schema.ts`
 * (the leaf `@ultimat3/mcp/schema` the boot applies `x_mcp_confirmations` from) and
 * `http/src/request-facts.ts` (the one request-facts builder mcp and the bearer mount share).
 * raised 622 → 623, measured 623 (2026-10-06, plan 101 sweep 10d): `core/src/config-mail.ts` — the
 * `mail.retainMime` app-config key, validated where every config section is.
 * raised 623 → 624, measured 624 (2026-10-06, plan 101 sweep 11): `schema/src/unstorable-text.ts`
 * — the one NUL/lone-surrogate predicate `t.json()` and now every string builtin share (a lone
 * surrogate was a jsonb 500 and a silent U+FFFD on text), split out of `validators.ts` at 486 lines.
 * raised 624 → 625, measured 625 (2026-10-07, plan 101 sweep 12c): `core/src/config-jobs.ts` — the
 * per-queue `jobs.concurrency` table (#676), validated where every config section is.
 * raised 625 → 628, measured 628 (2026-10-07, sweep 13a): `schema/src/array-schema.ts` (array
 * item-count bounds, split out of `validators.ts` at 484 lines), `db/src/db-executor.ts` (the one
 * `PgExecutor` builder, #688) and `cache/src/value-codec.ts` (one value shape on every cache tier).
 * raised 628 → 629, measured 629 (2026-10-07, sweep 13b): `jobs/src/errors-tenant.ts` — the terminal
 * `X_JOB_TENANT_MISMATCH` a webhook delivery or a queued agent refuses a wrong org with.
 * raised 629 → 630, measured 630 (2026-10-07, sweep 14): `entity/src/transition-pins.ts` — the
 * columns a transition's policy read, pinned into its compare-and-set (#702).
 * raised 630 → 631, measured 631 (2026-10-07, 26.0.0 app feedback): `core/src/log-tee.ts` — `addLogSink`,
 * the supported log tee, reached through `logger.ts` by every module that logs (retired in 31.0.0:
 * the tee is `subscribe('log.record', …)` on core's instrumentation bus).
 * raised 631 → 632, measured 632 (2026-10-08, Web Push): `pwa/src/push-schema.ts` — the leaf
 * `@ultimat3/pwa/schema` the boot applies `x_push_subscriptions` from, as the mcp leaf above.
 * raised 632 → 634, measured 634 (2026-10-09, #738): `core/src/app-dir.ts` (the one walk to the app
 * root, so every `.x/` path resolves from it, never the cwd) and `core/src/cache-eviction.ts` (the
 * eviction the PGlite snapshot cache runs when it writes a new version), both through the core barrel.
 * raised 634 → 636, measured 636 (2026-10-09, #710): `core/src/wire-dates.ts` — the query route
 * names its answer's instants in `x-ultimate-dates` — and `core/src/default-locale.ts`, the default
 * locale split out of `context.ts` so an island's translator reads it without the async context;
 * both reached through the core barrel.
 * raised 636 → 637, measured 637 (2026-10-09, #710 row 9): `auth/src/login-identity.ts` — which
 * account a login names, an email or a handle `defineAuth({ handles })` resolves, through the auth barrel.
 * raised 637 → 639, measured 639 (2026-10-10, #752): `entity/src/pg-array-literal.ts` and
 * `entity/src/pg-array-decode.ts` — an `arrayOf()` cell read by its declaration, because `Bun.SQL`
 * hands `uuid[]` back as its text literal and every read of such a row was refused. The grammar
 * moved out of `realtime/src/pg-array.ts`, which stays for its oid table, so nothing left the graph.
 * raised 639 → 641, measured 641 (2026-10-10, an outage is one fact in the log): `core/src/outage-log.ts`
 * — failures 1, 2, 4, 8, … and one closing line, through the core barrel — and
 * `cache/src/partial-log.ts`, which thins `cache.invalidate.partial` per failing tier with it.
 * raised 641 → 642, measured 642 (2026-10-11, an isr page is one entry however its URL is spelled):
 * `http/src/route-path.ts` — a pathname's segments, their decoding and its one spelling, moved out
 * of `router.ts` so the matcher and the `isr` key share them; reached through the http barrel.
 * raised 642 → 643, measured 643 (2026-10-11, sitemap sections): `core/src/config-sitemap.ts` — the
 * shape of `seo.sitemap.sections` / `pageSize` and the one validator `defineConfig` and
 * `@ultimat3/seo` refuse them with; split from `config-site.ts`, reached through the core barrel.
 * raised 643 → 644, measured 644 (2026-10-14, #773): `core/src/error-stack.ts` — the one reader of a
 * thrown value's stack, recomposing the `name: message` header Bun 1.4 loses when a collection runs
 * before the first `.stack` read; through the core barrel, for `jobs/src/execute.ts`'s failure row.
 * raised 644 → 645, measured 645 (2026-10-17, a DB blip degrades the limiter):
 * `http/src/rate-limit-degrade.ts` — which failures mean "the database is unreachable" and the
 * per-process fallback the shared rate-limit store decides from meanwhile; reached through
 * `rate-limit-postgres.ts` on the http barrel.
 * raised 645 → 648, measured 648 (2026-10-17, #790): `jobs/src/jobs-retention.ts`,
 * `outbox-retention.ts` and the batch loop they share, `purge-batches.ts` — the `x.purge` targets
 * that delete finished `x_jobs` rows and published `x_outbox` rows, reached through the jobs barrel.
 * raised 648 → 649, measured 649 (2026-10-20, an unknown predicate operator is refused):
 * `entity/src/operator.ts` — the one runtime list `Operator` is derived from and its refusal, read
 * by both drivers' predicate switches and `andWhere`; reached through the entity barrel.
 * raised 649 → 651, measured 651 (2026-10-22, Bun idle timeout + `seo.robots.groups`):
 * `http/src/idle-timeout.ts` — the socket `idleTimeout` derived from `requestTimeoutMs`, reached
 * through `server.ts` on the http barrel — and `core/src/config-robots.ts`, the `seo.robots`
 * refusals `defineConfig` raises, reached through `config-site.ts` on the core barrel.
 * raised 651 → 652, measured 652 (2026-10-26, a filtered update judged as ONE batch):
 * `entity/src/memory-update.ts` — the merge of a patch into a row and the judgement of a
 * filtered update's whole result before any of it lands, split out of `memory-repo.ts` so that
 * file stays under the 500-line ceiling; reached through the entity barrel.
 * raised 652 → 654, measured 654 (2026-10-28, `jobWorker({ maxInFlight })`):
 * `jobs/src/worker-process-cap.ts` (the per-process count, read before each claim) and
 * `worker-claim-sweep.ts` (which queue a pass asks, rotated) — `worker.ts` is at the 500-line
 * ceiling; reached through the jobs barrel.
 * raised 654 → 660, measured 660 (2026-10-31, `indexes: [{ concurrently: true }]`): the migrator
 * applies a `-- transaction: false` step outside a transaction — `db/src/migration-step.ts` (one
 * script, tx or not, plus the INVALID-index recovery, split out of `migrate.ts`),
 * `concurrent-index.ts` (the marker and the statements that need it), `marker-line.ts` (the one
 * marker scan, shared with `destructive.ts`), and on the generator's side of the db barrel
 * `concurrent-plan.ts` and `generate-steps.ts`; `entity/src/index-identity.ts` (the index dedupe,
 * split out of `entity.ts` at the 500-line ceiling).
 * raised 660 → 666 (2026-10-31, `query({ download })`): `query/src/download{,-token,-http,-errors}.ts`
 * and `search-string.ts` through the query barrel, `http/src/byte-range.ts` through the http one.
 * raised 666 → 692, measured 692 (2026-11-02, plan 101 wave 1, 26 modules that are real function):
 * stored-object responses `http/src/{object-response,stored-object-headers}.ts`; the TOTP replay
 * ledger `auth/src/mfa-replay-postgres.ts`; durable job steps
 * `jobs/src/{errors-steps,steps-output,steps-store}.ts`; `entity/src/{touch,table-locks,
 * lock-unsupported,bulk-write-send,pg-lock,lock-key,entity-patch}.ts` and the memory repo's
 * parity splits `memory-{batch,lock,same-tenant,seek,transactor}.ts`; `cache/src/tier-leading.ts`;
 * expand-contract and migration safety `db/src/{retired,rolling,rolling-errors,same-tenant,
 * transaction-guard,migrate-lock-retry}.ts`; `core/src/json-storable.ts`.
 * raised 692 → 706, measured 706 (2026-11-03, plan 101 wave 2): the pooled-Postgres profile
 * `db/src/{pooler,pooler-fix,pool-gate,pool-listeners,pool-pins,pool-retire,pool-sweep,
 * pool-timer}.ts` (a transaction pooler's bounds, and a pinned or wedged connection retired);
 * the claim by queue demand `jobs/src/{worker-queue-demand,driver-pg-claim-sql,
 * driver-pg-demand-sql}.ts`; `http/src/{compress,compress-read}.ts` (a compressed answer, and a
 * compressed body read bounded); `entity/src/memory-observed.ts`.
 * raised 706 → 726, measured 726 (2026-11-03, plan 101 wave 3): one outbound HTTP call and its
 * breaker, `core/src/{outbound,outbound-attempt,outbound-dial,outbound-errors,outbound-hops,
 * outbound-read,outbound-types,outbound-subpath,deadline-signal,breaker}.ts`, reached through the
 * jobs, cache and auth barrels' vendor calls; the OTLP retry `core/src/otlp-post.ts` and
 * `error-fingerprint.ts`; `core/src/error-status-declared.ts` (`defineError`'s status rows);
 * `.sensitive()` and the schema rules `schema/src/{sensitive,schema-rules,record-schema}.ts`;
 * `entity/src/view-issue.ts` — 17 new files, and 3 existing modules they newly reach.
 * raised 726 → 738, measured 738 (2026-11-03, plan 101 wave 4a): 12 new files, all on the jobs
 * barrel `framework-schema.ts` and `runtime-queue.ts` already evaluate whole — `enqueueMany`
 * (`jobs/src/{job-enqueue-many,enqueue-record,driver-pg-enqueue-many}.ts`), the code registry
 * split out of `errors.ts` at its ceiling (`error-codes.ts`), `importRows()`
 * (`import,import-pass,import-format,import-source,import-errors`) and `webhookReceiver()`
 * (`webhook-receiver,webhook-receiver-route,webhook-receiver-errors`). No existing module newly
 * reached: `@ultimat3/http`, the one new package edge, was already in this graph whole.
 * raised 738 → 740, measured 740 (2026-11-03, plan 101 wave 4b): `core/src/config-assets.ts`
 * (`assets.retain`) and `core/src/config-client-errors.ts` (`clientErrors`) — two `app.config.ts`
 * sections, validated where every config section is, through the core barrel. Nothing else moved.
 * raised 740 → 741, measured 741 (2026-11-03, wave 4c): `entity/src/test-driver.ts`; `dbDiagnostics()`'s
 * five modules moved to `@ultimat3/db/diagnostics`, held out by `NEVER_AT_BOOT`.
 * raised 741 → 745, measured 745 (2026-11-05, wave 5a): `{core,action}/src/declared-errors.ts`,
 * `core/src/route-path-{template,merge}.ts`. → 747 (wave 5b): `auth/src/jwt-bearer-resolver.ts`,
 * `core/src/client-paths-pins.ts`. → 748 (wave 6a): `entity/src/memory-journal.ts`. No existing
 * module newly reached by any of the three.
 * raised 748 → 804, measured 804 (2026-11-06, plan 101 wave 7): 54 new files and 2 existing modules
 * newly reached — one is `http/src/set-cookie.ts`, the one `setCookie` the replica position cookie
 * now writes through. `authorizationServer()` (21, `auth/src/{authorization-server*,grant-*,
 * token-endpoints,oauth-bearer-resolver,verification-purposes}.ts`) through the auth barrel that
 * `framework-schema.ts` reads for `AUTH_TABLES` and the five `x_oauth_*` tables; row security and
 * fresher reads in db (17: `row-security*`, `row-secure-client`, `transaction-settings`,
 * `local-settings`, `read-transaction`, `statement-bound`, `replica-position`,
 * `drift-row-security`, `generate-row-security`, `generate-snapshot`, `introspect-rows`,
 * `partitioned-tables`), entity's `describe-tenancy` and `row-security-settings`; jobs' consumer,
 * saga and event-wake modules (14: `consumer*`, `errors-saga`, `steps-{unwind,wait}`,
 * `execute-{ctx,unwind}`, `driver-pg-event-wake-sql`, `step-resolve`, `backfill-{source,reader}`)
 * through the jobs barrel; `cli/src/runtime-replica-position.ts`.
 * raised 804 → 822, measured 822 (2026-11-06, wave 8): 18 new files (time series and views,
 * `db/src/keyset.ts`, the Redis client and deadlines, `error-reporter-chain`, `error-groups-schema`).
 * raised 822 → 852, measured 852 (2026-11-06, wave 9): 30 new files (failure capture, `config-time`,
 * entity lifecycle, subject data, `failure-row`, action streaming), each through its barrel.
 * raised 852 → 853, measured 853 (2026-11-07, plan 101 wave 10): `core/src/hmac.ts`, the one keyed
 * hash every HMAC site now calls (a Bun keyed-hasher bug). No existing module newly reached.
 * raised 853 → 878, measured 878 (2026-11-07, #990–#999), 25 new files through their barrels:
 * `auth/src/{passkey-*,webauthn-data,cbor,cose-key,base64url}.ts` (14), `action/src/{meter*,
 * errors-meter}.ts` (7), `http/src/{problem-meta-framework,server-websocket,websocket-mounts}.ts`,
 * `notify/src/push-device-pg.ts`. No existing module newly reached.
 * raised 878 → 879, measured 879 (2026-11-07, sweep 2): `db/src/drift-missing.ts`, split off drift-findings.
 * raised 879 → 880, measured 880 (2026-11-07, fix/exercise-tenancy): `entity/src/read-only.ts`,
 * `entity({ readOnly })`'s refusal, which every repository returns through. No module newly reached.
 * raised 880 → 883, measured 883 (2026-11-07, sweep 3): the mount's after-scan `exposedPrimitives()`
 * keeps the barrels' `core/src/{mcp-exposure,tool-description}.ts`, `action/src/tool-gate.ts`.
 * raised 883 → 884, measured 884 (2026-11-07, fix/exercise-fidelity): `jobs/src/step-scope.ts`,
 * `currentStep()` — the step body in flight, which the crash proof names. No module newly reached.
 * raised 884 → 885, measured 885 (2026-11-08, fix/followups): `entity/src/json-null.ts`, the one
 * rule the parsers, the pg binder/decoder and the memory matcher read for a JSON `null`. No module newly reached.
 * raised 885 → 894, measured 894 (2026-11-09, plan 101 v31 wave A): nine NEW modules, each a split
 * or a new rule reached through its package's barrel — `core/src/{gate-shapes,
 * error-reporter-sentry-hooks}.ts`, `schema/src/issue-cap.ts`, `db/src/statement-cancel.ts`,
 * `cache/src/redis-buckets.ts`, `http/src/{body-ceiling,rate-limit-config}.ts`,
 * `policy/src/{denial-parts,guard-primitive}.ts`. No existing module newly reached.
 * raised 894 → 902, measured 902 (2026-11-09, plan 101 v31 wave B): seven NEW modules —
 * `entity/src/{declared-index,tenant-index}.ts` (the derived `(tenant, pk)` index), the entity
 * driver kit's `entity/src/{driver-errors,driver-registry,driver-rows,row-key}.ts`, and
 * `jobs/src/events-cursor.ts` (an event never missed between INSERT and COMMIT) — and one existing
 * module newly reached: `core/src/page.ts`, which `action/src/errors*.ts` now import instead of
 * core's barrel (slice 11, K6) so the browser client carries no titles table.
 * raised 902 → 908, measured 908 (2026-11-09, plan 101 v31 wave C, slice 20): the instrumentation
 * bus — eight NEW modules, `core/src/{instrument,instrument-semconv,logger-record,metrics-semconv,
 * otlp-batch,otlp-log-exporter,outbound-instrument}.ts` and `jobs/src/job-instrument.ts` — less two
 * deleted, `core/src/log-tee.ts` (the tee is `log.record`) and `db/src/observe.ts` (the slot). No
 * existing module newly reached.
 * raised 908 → 909, measured 909 (2026-11-09, plan 101 v31 wave C gate fix): one NEW module,
 * `core/src/instrument-stacks.ts` — the ref-counted opt-in that makes `db.statement` carry the
 * stack it was sent from (the `statements` fixture names a loop's line by it), split out of
 * `instrument.ts`. No existing module newly reached.
 * raised 909 → 913, measured 913 (2026-11-09, plan 101 v31 slice 21 W2): `cli/src/runtime-ports.ts`
 * (the one install loop over `ADAPTER_PORTS`), `cli/src/runtime-port-bindings-queue.ts` (the queue
 * phase's rows, split so migrate never loads the AI/auth/mail/notify/scraping adapters), and the
 * `jobs/src/adapter.ts` / `action/src/adapter.ts` entries the queue installers now come from.
 * raised 913 → 915, measured 915 (2026-11-09, same slice): `cli/src/runtime-boot-ports.ts` and
 * `core/src/adapter.ts` — `ROLE=migrate` installs `runtime.ts`'s clock and secret source too.
 * raised 915 → 916, measured 916 (2026-11-09, same slice): `core/src/sleep-clock.ts`, the waiting
 * `systemClock` core split out of `clock.ts` so a browser bundle never carries `sleep`.
 * raised 916 → 919, measured 919 (2026-11-09, same wave): `cli/src/runtime-keys.ts` (an unknown
 * `runtime.ts` key refused at load), core's `adapter-slot.ts` (the shared release-restoring slot)
 * and auth's `port-clock.ts` (auth reads the ambient clock port).
 * raised 919 → 959, measured 959 (2026-11-09, plan 101 v31 wave F, metafile diff against HEAD
 * de915544e): 40 modules, every one a barrel export of a package migrate already loads, none from
 * the cli. auth 17 — SAML SSO and the `IdentityProvider` port (`identity-provider{,-cookie,-oidc,
 * -route-core,-routes,-status}.ts`, `saml-{assertion,c14n,certificate,dom,dsig,errors,metadata,
 * provider,request,response,xml}.ts`); jobs 10 — `accountExport`/`accountErase`, `withLock`,
 * `reindex`, `ledger()`, partition retention (`gdpr-{audit,coverage,errors}.ts`, `ledger{,-book,
 * -errors}.ts`, `lock{,-errors}.ts`, `reindex.ts`, `partitions.ts`); entity 8 — `partitionBy`,
 * `personalData()`, the `SearchIndex` port (`partition.ts`, `personal-data{,-kind}.ts`,
 * `search-index{,-installed,-memory,-postgres}.ts`, `search-repo.ts`); db 2 — partition DDL
 * (`entity-shape.ts`, `generate-partition.ts`); notify 2 — the `SmsTransport` port
 * (`sms-{errors,transport}.ts`); cache 1 — `redis-pubsub.ts`, cross-replica invalidation.
 * raised 959 → 964, measured 964 (2026-11-10, wave F review fixes, metafile diff against HEAD
 * de915544e): five NEW modules — `auth/src/saml-email-trust.ts` (which IdP an asserted email is
 * trusted from), `entity/src/search-index-{sync,version}.ts` (the index kept in step with its
 * rows, by version), `db/src/branch-errors.ts` and `db/src/generate-partition-run.ts` (split at
 * the file ceiling). No existing module newly reached: `jobs/src/reindex.ts` reads
 * `searchVersionColumn` from the entity barrel, never `@ultimat3/entity/adapter`, whose
 * `entityDriver` kit (8 modules) stays the serving roles'.
 * raised 964 → 976, measured 976 (2026-11-10, plan 101 v31 wave G, metafile diff against HEAD
 * c00cb32b0): four NEW modules — `entity/src/search-mirrored-repo.ts` (a repo's writes mirrored
 * into the search index), `search-written-rows.ts` (the rows a write touched, deletes included),
 * `write-commit.ts` (the after-commit hook they ride), `jobs/src/reindex-sweep.ts` (the sweep that
 * drops index ids no longer in the table). And 8 existing modules newly reached: the
 * `entityDriver` kit (`entity/src/{adapter,define-driver,driver-delete,driver-kit-types,
 * driver-repo-reads,driver-repo-writes,driver-scope,driver-write-scope}.ts`), because
 * `reindex-sweep.ts` imports `kindOf` and `rowKey` from `@ultimat3/entity/adapter`. Both are leaves
 * (`cursor.ts`, `row-key.ts`): reached another way, the 8 leave and this ceiling falls to 968.
 * lowered 976 → 969, measured 969 (2026-11-10, wave G): `reindex-sweep.ts` reads both leaves from
 * the entity barrel, so the 8 driver-kit modules left (−8), and `entity/src/memory-upsert.ts` (the
 * memory driver's upsert, split out of `memory-repo.ts` at 489 lines) arrived (+1).
 * raised 969 → 970, measured 970 (2026-11-10, wave G, D5): `jobs/src/retry-jitter.ts`, which
 * `job()` calls to refuse a `retry.jitter` that is not core's `JitterMode` — reached through the
 * jobs barrel. No existing module newly reached.
 * raised 970 → 971, measured 971 (2026-11-10, wave G, g-search): `entity/src/search-mirror-batch.ts`
 * — one transaction's search-index ops, merged per key and sent at commit. No existing module
 * newly reached.
 * raised 971 → 973, measured 973 (2026-11-10, fix/adopter-round-2): two auth modules every role
 * reaches through the auth barrel (`framework-schema.ts` reads `AUTH_TABLE_NAMES` and the auth
 * DDL off it) — `auth/src/sign-in-callback-path.ts` (an app's own `oauthLogin({ callbackPath })`,
 * refused at construction when unmountable) and `auth/src/oauth-handshake-cookie.ts` (the
 * handshake cookie for a hand-built leg, split out of `oauth-cookie.ts`). No existing module newly
 * reached. An `@ultimat3/auth/schema` leaf would take the whole auth barrel off this path.
 * raised 973 → 977, measured 977 (2026-11-10, 31.3.0 gate fix): four new modules through the
 * entity and auth barrels — `entity/src/history-read.ts` and `entity/src/history-order.ts` (the
 * `history(table, id)` read and its one before→after ordering), `entity/src/expr-verdict.ts` (an
 * invariant's NULL judged in three values, the same on the app side and in the CHECK) and
 * `auth/src/auth-ports.ts` (the limiters and TOTP guard read where used, never captured by
 * `defineAuth`). No existing module newly reached: the delta is exactly these four.
 * lowered 977 → 873, measured 873 (2026-11-10, #1051, metafile diff against HEAD 37b0d74cc):
 * why: `framework-schema.ts` reads the auth DDL from the leaf `@ultimat3/auth/schema`
 * (`auth/src/tables.ts`, which re-exports `authorization-server-schema.ts`) instead of the barrel,
 * so 104 auth modules left (106 reached before, these 2 stay) and nothing else moved. A new auth
 * runtime module no longer raises this pin.
 * raised 873 → 887, measured 887 (2026-11-11, sweep 1, metafile diff against b74acc672): cache's
 * `{approx-bytes,byte-length,memo-flights,memo-per-request,memo-store}.ts` (bounded memos); core's
 * `{breaker-retry-budget,config-cache,logger-redact,sentry-frames,bunfs}.ts` and the off-loop
 * raster `image/{raster-pool,raster-wire,raster-worker-bundle,transform-inline}.ts` — the image
 * ones ride the core barrel; an `@ultimat3/core/image` subpath would take them off this path.
 * raised 887 → 902, measured 902 (2026-11-11, sweep 2 db+http, metafile diff against 3635eb9b5):
 * db's `{drift-index-keys,index-extension,index-key-ddl,introspect-index,migration-lock-lint,
 * slow-statement-log,table-storage}.ts` and http's `{admit-stage,compress-cache,etag-form,lag-shed,
 * refusal-log,request-charset,request-timings,slow-request-log}.ts`. No existing module newly
 * reached. The http ones ride `action/src/invoke.ts`'s edge to the http barrel, which every role,
 * migrate included, evaluates; cutting that edge would take the whole pipeline off this path.
 */
export const MIGRATE_CEILING = 902;

// One import site for the test, which reads both pins from here.
export { SERVING_ROLE_CEILING } from './serve-graph-serving-ceiling-fixture';
