// The serving roles' serve-graph module count — every role `serve-boot.ts` boots — each raise
// stated with its number and reason. Split from `serve-graph-ceilings-fixture.ts` at the file
// ceiling; `serve-graph.test.ts` holds a build to it. A raise names its modules, often by pointing
// at the migrate ledger's entry.

/**
 * measured: 796 — the 558 `MIGRATE_CEILING` measured (`serve-graph-ceilings-fixture.ts`) plus what
 * `serve-boot.ts` adds: the services and the roles.
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
 * the supported log tee, reached through `logger.ts` by every module that logs (retired in 31.0.0:
 * the tee is `subscribe('log.record', …)` on core's instrumentation bus).
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
 * (`installChannelTransport`), so a job or an action publishes on a declared channel with no hub.
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
 * raised 1093 → 1151, measured 1151 (2026-11-06, plan 101 wave 7): `MIGRATE_CEILING`'s 56, plus
 * `cli/src/row-security-boot.ts` (the boot's role check) and `query/src/http-etag.ts` (a read's 304).
 * raised 1151 → 1174, measured 1174 (2026-11-06, plan 101 wave 8): `MIGRATE_CEILING`'s 18, plus
 * `query/src/live-trace.ts` (a live read's spans) and the CLI catalog split at its line ceiling,
 * `cli/src/messages-{db,gate,shot,upgrade}.ts`, which `messages.ts` composes.
 * raised 1174 → 1221, measured 1221 (2026-11-06, plan 101 wave 9): `MIGRATE_CEILING`'s 30, plus
 * resumable uploads and expiry (`storage/src/{accept-part,grant-multipart,multipart-staged,
 * errors-multipart,expire,subject-target,upload-client-multipart,driver-local-multipart,
 * driver-memory-multipart,driver-s3-multipart-session}.ts`), mail previews
 * (`mail/src/preview{,-check}.ts`), `seo/src/llms.ts`, `render/src/zone-script.ts`,
 * `cli/src/failure-capture-boot.ts` and the catalog split `cli/src/messages-{client,repro}.ts`.
 * No existing module newly reached.
 * raised 1221 → 1223, measured 1223 (2026-11-06, plan 101 wave 9): `storage/src/driver-local.ts`
 * split at its line ceiling into `driver-local-{list,remove}.ts`, which every role reaches through
 * the storage barrel.
 * raised 1223 → 1225, measured 1225 (2026-11-07, plan 101 wave 10): `seo/src/static-export.ts` (the
 * static build's image and card hook) and `storage/src/image-warm.ts` (`warmVariants`), each through
 * its package's barrel. No existing module newly reached.
 * raised 1225 → 1226, measured 1226 (2026-11-07, plan 101 wave 10): `MIGRATE_CEILING`'s `core/src/hmac.ts`.
 * raised 1226 → 1253, measured 1253 (2026-11-07, #990–#999): `MIGRATE_CEILING`'s 25, plus
 * `realtime/src/device-socket.ts` and `cli/src/role-start-devices.ts` (every role's device sockets).
 * raised 1253 → 1254, measured 1254 (2026-11-07, sweep 2): `db/src/drift-missing.ts`, split off drift-findings.
 * raised 1254 → 1255, measured 1255 (2026-11-07, fix/exercise-tenancy): `entity/src/read-only.ts`.
 * raised 1255 → 1259, measured 1259 (2026-11-07, sweep 3): `MIGRATE_CEILING`'s three and
 * `cli/src/runtime-jobs-unserved.ts` (a split worker reads the registry before it warns).
 * raised 1259 → 1260, measured 1260 (2026-11-07, fix/exercise-fidelity): `MIGRATE_CEILING`'s 1.
 * raised 1260 → 1261, measured 1261 (2026-11-08, fix/followups): `MIGRATE_CEILING`'s 1.
 * raised 1261 → 1276, measured 1276 (2026-11-09, plan 101 v31 wave A): `MIGRATE_CEILING`'s 9, plus
 * the storage request ceiling and streaming split (`storage/src/{accept-stream,request-ceiling,
 * driver-s3-copy-parts,driver-s3-stream,driver-local-open}.ts`) and `cli/src/runtime-storage-boot.ts`
 * (every role's storage boot, out of `runtime-services.ts`, `servedRequestCeiling` with it). No
 * existing module newly reached: `cli/src/runtime-storage-upload.ts` stays the web role's.
 * raised 1276 → 1293, measured 1293 (2026-11-09, plan 101 v31 wave B): `MIGRATE_CEILING`'s seven
 * new modules (`core/src/page.ts` was already reached here, through `query/src/search-string.ts`),
 * plus `query/src/validate.ts`, realtime's fan-out and replication splits
 * (`realtime/src/{live-entries,live-patch-encode,pg-replication-dial,pg-replication-liveness,
 * pg-replication-position,replication-resync,replicator-resync,replicator-subject}.ts`) and
 * `render/src/render-walk.ts` (the synchronous SSR walker, out of `render-html.ts`). No existing
 * module newly reached.
 * raised 1293 → 1302, measured 1302 (2026-11-09, plan 101 v31 wave C, slice 20): `MIGRATE_CEILING`'s
 * net 6, plus the emitters' `mail/src/deliver.ts`, `render/src/render-instrument.ts` and
 * `storage/src/storage-instrument.ts`. No existing module newly reached.
 * raised 1302 → 1303, measured 1303 (2026-11-09, plan 101 v31 wave C gate fix): `MIGRATE_CEILING`'s
 * `core/src/instrument-stacks.ts`. No existing module newly reached.
 * raised 1303 → 1318, measured 1318 (2026-11-09, plan 101 v31 slice 21 W2): the migrate raise's 4,
 * then `cli/src/runtime-port-bindings.ts` and the `./adapter` entries every installer now comes from
 * (`core`, `http`, `mail`, `notify`, `auth`, `realtime`) with the modules they re-export. The AI and
 * scraping adapters stay behind `await import()`, loaded only when `runtime.ts` supplies one.
 * raised 1318 → 1319, measured 1319 (2026-11-09, same slice): `cli/src/runtime-boot-ports.ts`, the
 * one boot-port helper every `runtime.ts` reader shares (`core/src/adapter.ts` was already in).
 * raised 1319 → 1320, measured 1320 (2026-11-09, same slice): `MIGRATE_CEILING`'s
 * `core/src/sleep-clock.ts`.
 * raised 1320 → 1324, measured 1324 (2026-11-09, same wave): `MIGRATE_CEILING`'s 3 (`runtime-keys.ts`,
 * `adapter-slot.ts`, `port-clock.ts`) plus one serving-only module the wave's peers added.
 * raised 1324 → 1385, measured 1385 (2026-11-09, plan 101 v31 wave F, metafile diff against HEAD
 * de915544e): `MIGRATE_CEILING`'s 40, plus 21 serving-only. cli 5 — the boot imports the app from
 * the image's prebuilt registry, in batches (`app-load-{prebuilt,batch,register}.ts`,
 * `build-registry.ts`; B1), and picks the cache-invalidation bus (`runtime-cache-bus.ts`); entity 8
 * — the `entityDriver` port's kit (`adapter.ts`, `define-driver.ts`, `driver-{delete,kit-types,
 * repo-reads,repo-writes,scope,write-scope}.ts`); storage 7 — the `UploadScanner` port and image
 * variants (`adapter.ts`, `errors-{scan,variant}.ts`, `image-variant.ts`, `upload-scan.ts`,
 * `upload-scanner{,-memory}.ts`); realtime 1 — `replicator-reconnect.ts`, the prompt reconnect
 * after a database restart. No existing module newly reached.
 * raised 1385 → 1391, measured 1391 (2026-11-10, wave F review fixes): `MIGRATE_CEILING`'s five
 * new modules, plus `cli/src/app-load-async.ts` — which app modules can suspend at their top
 * level, so the batched scan imports each alone. No existing module newly reached.
 * raised 1391 → 1392, measured 1392 (2026-11-10, plan 101 v31 wave G, metafile diff against HEAD
 * c00cb32b0): `MIGRATE_CEILING`'s four new modules (its driver kit was already here), plus four
 * serving-only — `cli/src/build-registry-background.ts` (the worker/scheduler subset of the
 * prebuilt registry, read at boot), `action/src/loader.ts` and `query/src/loader.ts` (the
 * `register*` entries the scan imports, moved off the barrels), `realtime/src/error-titles-server.ts`
 * (the server-only error titles split out of the browser bundle) — less seven removed:
 * `mail/src/templates/{index,invite,mfa-enrolled,reset-password,security-alert,verify-email,
 * welcome}.ts`, the framework mails deleted in v31. No existing module newly reached.
 * raised 1392 → 1393, measured 1393 (2026-11-10, wave G): `entity/src/memory-upsert.ts`, named on
 * `MIGRATE_CEILING` (the driver kit stays here: the serving roles reach it themselves).
 * raised 1393 → 1394, measured 1394 (2026-11-10, wave G, D5): `jobs/src/retry-jitter.ts`, named
 * on `MIGRATE_CEILING`.
 * raised 1394 → 1395, measured 1395 (2026-11-10, wave G, g-search): `entity/src/search-mirror-batch.ts`,
 * named on `MIGRATE_CEILING`.
 * raised 1395 → 1397, measured 1397 (2026-11-10, fix/adopter-round-2): the two auth modules named on
 * `MIGRATE_CEILING`. Nothing serving-only.
 * raised 1397 → 1401, measured 1401 (2026-11-10, 31.3.0 gate fix): `MIGRATE_CEILING`'s four new
 * modules. Nothing serving-only.
 * unchanged at 1401, measured 1401 (2026-11-10, #1051): the migrate pin's −104 does not reach here,
 * because the serving roles import the auth barrel themselves (`runtime-services.ts`,
 * `runtime-mfa-warning.ts`, `runtime-purge.ts`). `auth/src/tables.ts` is still the leaf, so no
 * new module arrived either.
 * raised 1401 → 1402, measured 1402 (2026-11-11, plan 101 sweep 0, H4/H5): `realtime/src/live-repair.ts`,
 * the registry's two repair paths split out of `live-query.ts` to stay under the 500-line ceiling.
 * No new behaviour.
 * raised 1402 → 1403, measured 1403 (2026-11-11, plan 101 sweep 0, H3/H4): `query/src/parsed-input.ts`
 * — realtime's live window id now hashes the input through query's one capped parse path
 * (`parsedQueryInput`) instead of a raw schema call, so a junk key cannot mint a second window.
 * raised 1403 → 1417, measured 1417 (2026-11-11, sweep 1 schema+core): `MIGRATE_CEILING`'s 14,
 * nothing serving-only (metafile diff against origin/main b74acc672).
 * raised 1417 → 1432, measured 1432 (2026-11-11, sweep 2 db+http): `MIGRATE_CEILING`'s 15,
 * nothing serving-only (metafile diff against 3635eb9b5).
 * raised 1432 → 1433, measured 1433 (2026-11-11, sweep 2 CodeQL fix): `MIGRATE_CEILING`'s 1,
 * `db/src/pin-statement.ts` (linear pin statement reader, CodeQL ReDoS fix). Nothing serving-only.
 */
export const SERVING_ROLE_CEILING = 1433;
