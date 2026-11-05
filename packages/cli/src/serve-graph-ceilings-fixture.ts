// The serve graph's module count per role, each raise stated with its number and reason.
// `serve-graph.test.ts` holds a build to them; the file is the ledger, kept out of that test at the
// file ceiling.

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
 * the supported log tee, reached through `logger.ts` by every module that logs.
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
 * raised 740 → 741, measured 741 (2026-11-03, plan 101 wave 4c): `entity/src/test-driver.ts`
 * (`testDriver()`, which a scaffolded `packages/db/src/client.ts` names) through the entity barrel.
 * `dbDiagnostics()`'s five modules were 746 on the db barrel; they moved to
 * `@ultimat3/db/diagnostics` (one caller, `x db diagnostics`) and `NEVER_AT_BOOT` holds them out.
 * Measured against a copy of HEAD with its own workspace links.
 * raised 741 → 745, measured 745 (2026-11-05, plan 101 wave 5a): `errors:`'s rule on `invoke`'s path
 * (`core/src/declared-errors.ts`, `action/src/declared-errors.ts`) and a `:param` pin's URL merged
 * into the input before `invoke` (`core/src/route-path-template.ts`, `route-path-merge.ts`), all
 * through the action and core barrels. No existing module newly reached.
 * raised 745 → 747, measured 747 (2026-11-05, plan 101 wave 5b): `jwtBearerResolver()`
 * (`auth/src/jwt-bearer-resolver.ts`) through the auth barrel, and the server-stamped path pins
 * (`core/src/client-paths-pins.ts`) through the core barrel. No existing module newly reached.
 * raised 747 → 748, measured 748 (2026-11-05, plan 101 wave 6a): `entity/src/memory-journal.ts`, the
 * memory store's ambient transaction, which the memory repo and transactor now read. Nothing else.
 */
export const MIGRATE_CEILING = 748;

/**
 * measured: 796 — the 558 above plus what `serve-boot.ts` adds: the services and the roles.
 * raised 875 → 880, measured 880 (2026-10-04, plan 101 sweep 1): eight modules that are real function
 * on every role's path — the per-primitive rate-limit gates (`action/src/rate-limit-gate.ts`,
 * `query/src/rate-limit-gate.ts`), their shared header rendering and installed-limiter seam
 * (`http/src/rate-limit-headers.ts`, `http/src/rate-limit-installed.ts`), and the live-query
 * delivery split (`realtime/src/live-deliver.ts`, `live-spend.ts`, `socket-defaults.ts`), and
 * `cli/src/trusted-hops.ts`, moved out of `role-start.ts` so the sync role reads the same hop count.
 * raised 880 → 885, measured 885 (2026-10-05, plan 101 sweep 1c): the sync node's per-principal caps
 * (`realtime/src/subscription-count.ts`, `principal-sockets.ts`) and three splits the 500-line
 * ceiling forced (`live-reauth.ts` out of `live-query.ts`, `sync-actor-change.ts` out of
 * `sync-node.ts`, `db/src/migration-ledger.ts` out of `migrate.ts`).
 * raised 885 → 887, measured 887 (2026-10-05, plan 101 sweep 2): `action/src/idempotency-redact.ts`
 * (an idempotent answer redacted at rest, #591) and `jobs/src/webhook-attempt.ts` (the webhook
 * transport, split out so `webhook.ts` stays under the ceiling once the attempt carries its signal).
 * raised 887 → 888, measured 888 (2026-10-05, plan 101 sweep 8b, native Windows): `cli/src/posix-path.ts`
 * (`app-load` sorts module paths by their `/` form, so every OS imports an app in one order) and
 * `core/src/bunfs.ts` (`isCompiledBundle`, the Windows `B:\~BUN\` prefix beside `/$bunfs/`), against
 * sweep 7's 886.
 * raised 888 → 893, measured 893 (2026-10-05, plan 101 sweep 8c, zero-downtime deploys): a worker
 * that lets a running job FINISH on SIGTERM — `jobs/src/worker-drain-cutoff.ts` (cancel only at
 * the deadline less a margin), `worker-held.ts` (hand every held claim back before the driver
 * closes), `worker-tally.ts` (counters split so `worker.ts` stays under the ceiling) — plus
 * `core/src/drain-deadline.ts` (`drain.deadlineMs`) and `db/src/migrate-rollback.ts` (a rollback
 * onto a newer build's ledger is accepted, not `X_MIGRATION_CONFLICT`).
 * raised 893 → 894, measured 894 (2026-10-05, plan 101 sweep 9, #506): `render/src/island-hold.ts`
 * — a realtime island on a page-boot document is held hidden until every held island has mounted
 * over the restored store and outbox, so an offline reload never paints the stale count first.
 * raised 894 → 900, measured 900 (2026-10-06, plan 101 sweep 10a): `schema/src/json-value.ts`
 * (`t.json()`), `core/src/aws-sigv4.ts` (the one SigV4 signer), and S3 Object Lock in storage —
 * `object-lock.ts`, `driver-s3-signed.ts` (the signed PUT a locked or metadata-carrying put takes),
 * `driver-s3-lock.ts` (its headers and the retention reads) and `driver-s3-client.ts` (moved out so
 * `driver-s3.ts` stays under the ceiling).
 * raised 900 → 907, measured 907 (2026-10-06, plan 101 sweep 10b): `entity({ appendOnly: true })` —
 * `entity/src/append-only.ts`, `append-only-errors.ts`, `db/src/generate-append-only.ts` (the
 * trigger) and `drift-append-only.ts` (a missing trigger is drift); audited reads —
 * `core/src/audit.ts` (the one audit contract action and query share), `query/src/audit-gate.ts`
 * and `audit-errors.ts`.
 * raised 907 → 912, measured 912 (2026-10-06, plan 101 sweep 10c): the two named on
 * `MIGRATE_CEILING` for 10c, and the SES transport a worker sends mail through —
 * `mail/src/driver-ses.ts`, `ses-failure.ts` (SES error types onto retry classes) and
 * `retain-mime.ts`. The SNS/Resend receivers stay off every role, behind `@ultimat3/mail/events`.
 * raised 912 → 914, measured 914 (2026-10-06, plan 101 sweep 10d): `core/src/config-mail.ts` (named
 * on `MIGRATE_CEILING`) and `cli/src/runtime-mail.ts`, which hands that key to the mail driver a
 * worker sends through.
 * raised 914 → 917, measured 917 (2026-10-06, plan 101 sweep 11): the module named on
 * `MIGRATE_CEILING` for 11, `realtime/src/sync-bus-handlers.ts` (the bus handlers, moved out so
 * `sync-node.ts` stays under the ceiling once `start()` is memoised and `stop()` waits it out), and
 * `storage/src/driver-memory-conflict.ts` (the memory disk refusing the key conflicts local does).
 * raised 917 → 918, measured 918 (2026-10-06, plan 101 sweep 11b): `realtime/src/nats-subscriptions.ts`
 * — the kept subscription list a `NatsTransport` re-binds once the library has closed its client for
 * good, which left every realtime role dead until a manual restart.
 * raised 918 → 920, measured 920 (2026-10-07, plan 101 sweep 12c): the module named on
 * `MIGRATE_CEILING` for 12c, and `realtime/src/record-publisher.ts` — committed rows published as
 * channel records with no replicator (#682), which the `x dev` bridge reads to skip a claimed table.
 * raised 920 → 923, measured 923 (2026-10-07, sweep 13a): the three modules named on
 * `MIGRATE_CEILING` for 13a, reached through the same db, schema and cache barrels.
 * raised 923 → 924, measured 924 (2026-10-07, sweep 13b): `jobs/src/errors-tenant.ts` — the terminal
 * `X_JOB_TENANT_MISMATCH` a webhook delivery or a queued agent refuses a wrong org with.
 * raised 924 → 925, measured 925 (2026-10-07, sweep 14): `entity/src/transition-pins.ts` — the
 * columns a transition's policy read, pinned into its compare-and-set (#702).
 * raised 925 → 926, measured 926 (2026-10-07, 26.0.0 app feedback): `core/src/log-tee.ts` — `addLogSink`,
 * the supported log tee, reached through `logger.ts` by every module that logs.
 * raised 926 → 927, measured 927 (2026-10-08, 26.1.0 route-presented modals):
 * `render/src/navigation-modal-rules.ts` — `NAVIGATION_PRESENTATION_META`, the meta a
 * `navigation: 'modal'` document names, reached through `navigation-tags.ts` by the render barrel.
 * raised 927 → 929, measured 929 (2026-10-08, Web Push): the leaf named on `MIGRATE_CEILING`, and
 * `cli/src/runtime-push.ts` — `pwa.push` read and its VAPID pair resolved before the queue starts;
 * `@ultimat3/pwa` itself stays behind its `await import()`.
 * raised 929 → 930, measured 930 (2026-10-09, 27.2.0): `storage/src/errors-promote.ts` — promotion's
 * three refusals, `X_STORAGE_ALREADY_PROMOTED` new among them, split out of `errors.ts` at its
 * 500-line ceiling and reached through the storage barrel.
 * raised 930 → 932, measured 932 (2026-10-09, #738): the two core modules named on `MIGRATE_CEILING`.
 * raised 932 → 934, measured 934 (2026-10-09, #710): the two modules named on `MIGRATE_CEILING`
 * for #710.
 * raised 934 → 935, measured 935 (2026-10-09, #710 row 9): `auth/src/login-identity.ts`, the module
 * named on `MIGRATE_CEILING`.
 * raised 935 → 936, measured 936 (2026-10-10, channel events from app code):
 * `realtime/src/channel-publish.ts` — `publishChannelEvent` and the process bus the boot installs
 * (`setChannelTransport`), so a job or an action publishes on a declared channel with no hub.
 * raised 936 → 938, measured 938 (2026-10-10, #752): the two entity modules named on
 * `MIGRATE_CEILING` for #752, which every role reaches through the entity barrel.
 * raised 938 → 939, measured 939 (2026-10-10, the bus is not a boot dependency of a publisher):
 * `cli/src/runtime-bus.ts` — which roles await the NATS dial (`sync`, the replicator) and which
 * dial it in the background and boot (`web`, `worker`, `scheduler`), the `transport` readiness
 * check and the boot line's `bus=`. Split out of `runtime-services.ts`, which sat at the ceiling.
 * raised 939 → 940, measured 940 (2026-10-10, PR #755 review): `realtime/src/nats-dial-wait.ts` —
 * one dial's connect timeout and the bounded wait a `sync` node puts on the retry loop, split out
 * of `nats-transport.ts` when the dial-loop fixes took it past the 500-line ceiling.
 * raised 940 → 945, measured 945 (2026-10-10, isr purge + keyed query): `render/src/render-isr.ts`
 * sat at 487 of 500 lines and split by job before it grew — `render-isr-key.ts` (the key and the
 * request URL narrowed to `revalidate.query`), `render-isr-routes.ts` (which route a stored key
 * belongs to, and what it declared) and `render-isr-result.ts` (an entry as a response) —
 * `render/src/revalidate-shape.ts` screens `onInvalidate` / `maxStale` / `query` at `defineRoute`,
 * and `render-isr-cooldown.ts` is the one-second memory of a failed render that stops a page whose
 * read is down from being one failing render per request.
 * raised 945 → 950, measured 950 (2026-10-11, a channel recovers after a bus outage): the two
 * modules named on `MIGRATE_CEILING`, and three every role carries — `realtime/src/nats-reports.ts`
 * (the transport's reporting, split out of `nats-transport.ts` at the 500-line ceiling: a fault
 * every time, an outage thinned, at the role's level), `realtime/src/sync-bus-outage.ts` (what a
 * `sync` node says while its bus is away) and `cli/src/role-sync-bus-wait.ts` (`x dev` starts its
 * node when the bus answers, where a container refuses the boot).
 * raised 950 → 951, measured 951 (2026-10-11, an isr page is one entry however its URL is spelled):
 * the module named on `MIGRATE_CEILING`.
 * raised 951 → 956, measured 956 (2026-10-11, sitemap sections): the module named on
 * `MIGRATE_CEILING`; three in seo, which every role reaches through the render barrel —
 * `sitemap-sections.ts` (which named section a page files under), `sitemap-datetime.ts` (a page's
 * `lastmod` as W3C Datetime, no ambient zone) and `sitemap-xml.ts` (the urlset and index XML and
 * the split on both caps, moved out of `sitemap.ts` at the file ceiling); and
 * `render/src/prerender-enumerate.ts` — `prerender()`'s three item forms normalised, moved out of
 * `render-static.ts` with the entry form (`{ params, lastmod, locales }`).
 * raised 956 → 957, measured 957 (2026-10-14, #773): the module named on `MIGRATE_CEILING`.
 * raised 957 → 958, measured 958 (2026-10-17, a DB blip degrades the limiter): the module named on
 * `MIGRATE_CEILING`.
 * raised 958 → 962, measured 962 (2026-10-17, #790): the three modules named on `MIGRATE_CEILING`
 * for #790, and `cli/src/runtime-jobs-retention.ts` — the three `jobs.*RetentionMs` windows read
 * off the loaded config into the two targets `installRetentionSweep` takes.
 * raised 962 → 963, measured 963 (2026-10-20, an unknown predicate operator is refused): the one
 * module named on `MIGRATE_CEILING` for that change, `entity/src/operator.ts`.
 * raised 963 → 965, measured 965 (2026-10-22, Bun idle timeout + `seo.robots.groups`): the two
 * modules named on `MIGRATE_CEILING` for that change.
 * raised 965 → 966, measured 966 (2026-10-26, a filtered update judged as ONE batch): the one
 * module named on `MIGRATE_CEILING` for that change, which every role reaches through the entity
 * barrel.
 * raised 966 → 968, measured 968 (2026-10-28, `jobWorker({ maxInFlight })`): the two modules named
 * on `MIGRATE_CEILING` for that change.
 * raised 968 → 969, measured 969 (2026-10-29, `navigation: { modal: true, prefetch: 'intent' }`):
 * `render/src/route-navigation.ts`, the declaration's one reader, which `route.ts` imports and so
 * every role reaches through the render barrel.
 * raised by 6 more (2026-10-31, `indexes: [{ concurrently: true }]`): `MIGRATE_CEILING`'s six.
 * raised 969 → 983, measured 983 (2026-10-31, `query({ download })` + ranged storage reads): the
 * six modules on `MIGRATE_CEILING` for it, storage's `range.ts`, `errors-range.ts` and
 * `driver-s3-range.ts`, and core's `seal.ts` closure (5) — the download token is sealed.
 * raised 989 → 1018, measured 1018 (2026-11-02, plan 101 wave 1): `MIGRATE_CEILING`'s 26, and
 * `storage/src/{errors-sniff,driver-s3-copy}.ts` (a promoted object is re-sniffed and copied) and
 * `render/src/head-attributes.ts`, which every role reaches through the storage and render barrels.
 * raised 1018 → 1047, measured 1047 (2026-11-03, plan 101 wave 2): `MIGRATE_CEILING`'s 14; the
 * streamed upload `storage/src/{byte-pump,put-stream,errors-stream,multipart,driver-local-stream,
 * driver-s3-presign,driver-s3-put-stream,driver-s3-settle,driver-s3-sse,driver-s3-multipart}.ts`;
 * `render/src/hole.ts` (`<Hole>`, on the render barrel); `cli/src/{runtime-s3-path-style,
 * runtime-statement-bound,app-load-unresolved,output-findings}.ts`.
 * raised 1047 → 1068, measured 1068 (2026-11-03, plan 101 wave 3): `MIGRATE_CEILING`'s 20, and
 * `core/src/render-node.ts` (the node brands, split out so `render` reads them from a leaf).
 * raised 1068 → 1080, measured 1080 (2026-11-03, plan 101 wave 4a): `MIGRATE_CEILING`'s 12.
 * raised 1080 → 1082, measured 1082 (2026-11-03, plan 101 wave 4b): `MIGRATE_CEILING`'s 2.
 * raised 1082 → 1083, measured 1083 (2026-11-03, plan 101 wave 4c): `MIGRATE_CEILING`'s 1.
 * raised 1083 → 1089, measured 1089 (2026-11-05, plan 101 wave 5a): the four in `MIGRATE_CEILING`'s
 * row, plus a read's twins `query/src/declared-errors.ts` and `query/src/http-pin.ts`.
 * raised 1089 → 1092, measured 1092 (2026-11-05, plan 101 wave 5b): `MIGRATE_CEILING`'s 2, plus
 * `render/src/client-pins-tag.ts`, the document's `ultimate-pins` meta.
 * raised 1092 → 1093, measured 1093 (2026-11-05, plan 101 wave 6a): `MIGRATE_CEILING`'s 1.
 */
export const SERVING_ROLE_CEILING = 1093;

/**
 * measured: 888 — the 796 above plus the 92 `serve-web.ts` adds (41 CLI, 36 MCP, 15 PWA).
 * raised 975 → 980, measured 980 (2026-10-05, plan 101 sweep 1c): the same five modules named on
 * `SERVING_ROLE_CEILING`, which every role carries.
 * raised 980 → 982, measured 982 (2026-10-05, plan 101 sweep 2): the same two modules named on
 * `SERVING_ROLE_CEILING` for sweep 2.
 * raised 982 → 984, measured 984 (2026-10-05, plan 101 sweep 7): `core/src/metrics.ts` hit the
 * 500-line ceiling and split by responsibility into `metric-errors.ts`, `metric-registry.ts` and
 * `metric-series.ts` (+3), and `storage/src/driver-s3-absent.ts` left `driver-s3.ts` (+1); the
 * action and query `deprecation.ts` copies collapsed into one `core/src/deprecation.ts` (−1 net).
 * raised 984 → 987, measured 987 (2026-10-05, plan 101 sweep 8b, native Windows): the two modules
 * named on `SERVING_ROLE_CEILING` for sweep 8b, and `cli/src/island-package-dedupe.ts` — the island
 * build resolves every `@ultimat3/*` import to the app's one copy, which a Windows `file:` install
 * without symlinks had bundled twice (+15 KB on `/posts`).
 * raised 987 → 992, measured 992 (2026-10-05, plan 101 sweep 8c): the five modules named on
 * `SERVING_ROLE_CEILING` for sweep 8c.
 * raised 992 → 994, measured 994 (2026-10-05, plan 101 sweep 9): `render/src/island-hold.ts` (named on
 * `SERVING_ROLE_CEILING`, #506) and `cli/src/island-runtime.ts` (#505: the page runtime built once
 * per page instead of inlined into every realtime island; split out so `island-bundle.ts` stays
 * under the ceiling).
 * raised 994 → 998, measured 998 (2026-10-05, plan 101 sweep 9b): `cli/src/theme-brand.ts` (the one
 * reader of an app's `apps/web/shared/theme.ts` brand, inlined with its CSP hash), and the island
 * build's duplicate-module guard — `island-duplicates.ts` (detection), `island-duplicate-refusal.ts`
 * (refuse a framework duplicate, warn on a third-party one) and `island-entry-missing.ts` (the
 * refusals moved out so `island-bundle.ts` stays under the 500-line ceiling).
 * raised 998 → 1004, measured 1004 (2026-10-06, plan 101 sweep 10a): the six modules named on
 * `SERVING_ROLE_CEILING` for sweep 10a.
 * raised 1004 → 1011, measured 1011 (2026-10-06, plan 101 sweep 10b): the seven modules named on
 * `SERVING_ROLE_CEILING` for sweep 10b.
 * raised 1011 → 1024, measured 1024 (2026-10-06, plan 101 sweep 10c): the five named on
 * `SERVING_ROLE_CEILING` for 10c, MCP human confirmation and its audit hook on the web role —
 * `mcp/src/confirmations.ts`, `confirmation-gate.ts`, `confirmation-store.ts`,
 * `confirmation-postgres.ts`, `confirmation-errors.ts`, `audit-hook.ts`, `confirmation-decide.ts` (an approval
 * must carry back the exact arguments `view` showed, compared by keyed digest) — and
 * `mcp/src/errors-transport.ts`, the transport error classes split out so `errors.ts` stays under
 * the 500-line ceiling once the eight confirmation codes are registered.
 * raised 1024 → 1026, measured 1026 (2026-10-06, plan 101 sweep 10d): the two modules named on
 * `SERVING_ROLE_CEILING` for 10d (`admin/src/mcp-scopes.ts` is behind the admin mount's lazy import).
 * raised 1026 → 1029, measured 1029 (2026-10-06, plan 101 sweep 11): the three modules named on
 * `SERVING_ROLE_CEILING` for 11.
 * raised 1029 → 1030, measured 1030 (2026-10-06, plan 101 sweep 11b): `realtime/src/nats-subscriptions.ts`,
 * named on `SERVING_ROLE_CEILING` for 11b.
 * raised 1030 → 1032, measured 1032 (2026-10-07, plan 101 sweep 12c): the two modules named on
 * `SERVING_ROLE_CEILING` for 12c.
 * raised 1032 → 1035, measured 1035 (2026-10-07, sweep 13a): the three modules named on
 * `MIGRATE_CEILING` for 13a — the web role reaches every module the serving roles do.
 * raised 1035 → 1036, measured 1036 (2026-10-07, sweep 13b): `jobs/src/errors-tenant.ts` — the terminal
 * `X_JOB_TENANT_MISMATCH` a webhook delivery or a queued agent refuses a wrong org with.
 * raised 1036 → 1037, measured 1037 (2026-10-07, sweep 14): `entity/src/transition-pins.ts` — the
 * columns a transition's policy read, pinned into its compare-and-set (#702).
 * raised 1037 → 1038, measured 1038 (2026-10-07, 26.0.0 app feedback): `core/src/log-tee.ts` — `addLogSink`,
 * the supported log tee, reached through `logger.ts` by every module that logs.
 * raised 1038 → 1039, measured 1039 (2026-10-08, 26.1.0): the module named on
 * `SERVING_ROLE_CEILING` for route-presented modals.
 * raised 1039 → 1053, measured 1053 (2026-10-08, Web Push): the two modules named on
 * `SERVING_ROLE_CEILING`, and the twelve the `@ultimat3/pwa` barrel the web role already loads now
 * carries — RFC 8291 encryption and its receiving half, the RFC 8292 signer and its key pair, the
 * sender, the runtime, the two stores, the subscribe actions and the client's meta name
 * (`installedVapid()` feeds `sw.js`'s push handler and `<meta name="x-push-key">`).
 * raised 1053 → 1054, measured 1054 (2026-10-08, 26.1.0 browser entry): `pwa/src/skew.ts` —
 * `detectSkew` and `AppUpdateAvailable`, split from `version-skew.ts` so `@ultimat3/pwa/client`
 * carries them without the error table; the web role reaches it through the pwa barrel.
 * raised 1054 → 1055, measured 1055 (2026-10-08, 26.1.0): `pwa/src/push-hosts.ts` — the push
 * services the sender may dial, checked at subscribe and at send (an endpoint from a request body
 * resolves wherever its owner points it), reached through `push-send.ts`.
 * raised 1055 → 1056, measured 1056 (2026-10-09, 27.2.0): `storage/src/errors-promote.ts`, the
 * module named on `SERVING_ROLE_CEILING` for 27.2.0.
 * raised 1056 → 1058, measured 1058 (2026-10-09, #738): the two core modules named on `MIGRATE_CEILING`.
 * raised 1058 → 1060, measured 1060 (2026-10-09, #710): the two modules named on
 * `MIGRATE_CEILING` for #710.
 * raised 1060 → 1061, measured 1061 (2026-10-09, #710 row 9): `auth/src/login-identity.ts`, the
 * module named on `MIGRATE_CEILING`.
 * raised 1061 → 1062, measured 1062 (2026-10-10, channel events from app code): the module named
 * on `SERVING_ROLE_CEILING`, which every role carries.
 * raised 1062 → 1063, measured 1063 (2026-10-10, events-only islands are never held):
 * `cli/src/island-realtime-state.ts` — which realtime islands read the record store or the outbox
 * (held, #506) and which only follow a channel, read off the names each imports from the barrel.
 * raised 1063 → 1065, measured 1065 (2026-10-10, #752): the two entity modules named on
 * `MIGRATE_CEILING` for #752.
 * raised 1065 → 1066, measured 1066 (2026-10-10, the bus is not a boot dependency of a publisher):
 * `cli/src/runtime-bus.ts`, the module named on `SERVING_ROLE_CEILING`, which every role carries.
 * raised 1066 → 1067, measured 1067 (2026-10-10, PR #755 review): `realtime/src/nats-dial-wait.ts`,
 * the module named on `SERVING_ROLE_CEILING`.
 * raised 1067 → 1072, measured 1072 (2026-10-10, isr purge + keyed query): the five render
 * modules named on `SERVING_ROLE_CEILING`, which every role carries.
 * raised 1072 → 1073, measured 1073 (2026-10-11, PR #757 review): `cli/src/isr-query-guard.ts` —
 * the `query` a page is handed; outside production it says once when an `isr` page reads a
 * parameter its `revalidate.query` does not list (one stored document for every value of it).
 * raised 1073 → 1078, measured 1078 (2026-10-11, a channel recovers after a bus outage): the five
 * modules named on `SERVING_ROLE_CEILING` — the web role reaches every module the serving roles do.
 * raised 1078 → 1080, measured 1080 (2026-10-11, an isr page is one entry however its URL is
 * spelled): the module named on `MIGRATE_CEILING`, and `cli/src/runtime-address.ts` — the URL a
 * `static` or `isr` document is rendered at and kept under, the address the router matched.
 * raised 1080 → 1085, measured 1085 (2026-10-11, sitemap sections): the five modules named on
 * `SERVING_ROLE_CEILING` — the web role reaches every module the serving roles do.
 * raised 1085 → 1086, measured 1086 (2026-10-14, #773): the module named on `MIGRATE_CEILING`.
 * raised 1086 → 1087, measured 1087 (2026-10-17, a DB blip degrades the limiter): the module named
 * on `MIGRATE_CEILING`.
 * raised 1087 → 1091, measured 1091 (2026-10-17, #790): the four modules named on
 * `SERVING_ROLE_CEILING` for #790.
 * raised 1091 → 1094, measured 1094 (2026-10-18, F13 `surface: 'meta-split'`): `mcp/src/meta-split.ts`
 * (the three dispatchers and the effect boot check), `meta-split-call.ts` (their dispatch: wrong tool,
 * preview, `confirmed_by_user`) and `meta-host.ts` (the server half both meta doors call, moved out of
 * `meta-call.ts` so neither imports the other).
 * raised 1094 → 1095, measured 1095 (2026-10-20, an unknown predicate operator is refused): the one
 * module named on `MIGRATE_CEILING` for that change, `entity/src/operator.ts`.
 * raised 1095 → 1097, measured 1097 (2026-10-22, Bun idle timeout + `seo.robots.groups`): the
 * two modules named on `MIGRATE_CEILING` for that change.
 * raised 1097 → 1098, measured 1098 (2026-10-26, a filtered update judged as ONE batch): the one
 * module named on `MIGRATE_CEILING` for that change — the web role reaches every module the
 * serving roles do.
 * raised 1098 → 1100, measured 1100 (2026-10-28, `jobWorker({ maxInFlight })`): the two modules
 * named on `MIGRATE_CEILING` for that change.
 * raised 1100 → 1101, measured 1101 (2026-10-29, `navigation: { modal: true, prefetch: 'intent' }`):
 * the one module named on `SERVING_ROLE_CEILING` for that change.
 * raised 1101 → 1121 (2026-10-31): `indexes: [{ concurrently: true }]` (+6) and `query({ download })`
 * with ranged reads (+14) — the modules named on `SERVING_ROLE_CEILING` for each.
 * raised 1121 → 1149, measured 1149 (2026-11-02, plan 101 wave 1): the modules named on
 * `SERVING_ROLE_CEILING` for it and `cli/src/runtime-render-document.ts`, the document split out of
 * `runtime-render.ts` for the web role, less what earlier raises left as slack.
 * raised 1149 → 1179, measured 1179 (2026-11-03, plan 101 wave 2): the 29 named on
 * `SERVING_ROLE_CEILING` for it and `cli/src/stream-hole-scope.ts`, a `<Hole>`'s request scope.
 * raised 1179 → 1200, measured 1200 (2026-11-03, plan 101 wave 3): the 21 named on
 * `SERVING_ROLE_CEILING` for it; the web role adds no new module of its own.
 * raised 1200 → 1213, measured 1213 (2026-11-03, plan 101 wave 4a): `SERVING_ROLE_CEILING`'s 12,
 * and `cli/src/plain-routes.ts` — `runtime.routes` plus every declared `webhookReceiver()`'s, the
 * one list both boots mount and `x routes` prints.
 * raised 1213 → 1222, measured 1222 (2026-11-03, plan 101 wave 4b): `SERVING_ROLE_CEILING`'s 2;
 * browser error reporting, `cli/src/client-errors-{routes,script}.ts` (mounted when
 * `clientErrors.enabled`); and `assets.retain`, `cli/src/retained-assets{,-boot,-layout,-read,
 * -sweep}.ts` — the publish before `/readyz` and the reader every asset route's 404 asks. Measured
 * against a copy of HEAD with its own workspace links: no existing module newly reached.
 * raised 1222 → 1226, measured 1226 (2026-11-03, plan 101 wave 4c): `SERVING_ROLE_CEILING`'s 1,
 * and MCP's dual era — `mcp/src/protocol-era.ts` (the era per request, `server/discover`, the
 * mirrored-header check), plus `server-resources.ts` and `transport-http-answers.ts`, split out
 * of `server.ts` and `transport-http.ts` at their line ceilings. No existing module newly reached.
 * raised 1226 → 1232, measured 1232 (2026-11-05, plan 101 wave 5a): the same six as
 * `SERVING_ROLE_CEILING`'s row; the web role adds nothing of its own.
 * raised 1232 → 1236, measured 1236 (2026-11-05, plan 101 wave 5b): `SERVING_ROLE_CEILING`'s 3,
 * plus `cli/src/page-pins.ts`, which collects the pins a rendered document stamps.
 * raised 1236 → 1237, measured 1237 (2026-11-05, plan 101 wave 6a): `MIGRATE_CEILING`'s 1.
 */
export const WEB_ROLE_CEILING = 1237;
