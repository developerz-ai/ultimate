# Adapters

<!-- generated: bun run scripts/adapter-ports.ts --write — from ADAPTER_PORTS in packages/core/src/registrar.ts; the boundaries step refuses an edit by hand (X_ADAPTER_PORT_INCOMPLETE) -->

Every backend an app may swap is an **adapter port**: one row of `ADAPTER_PORTS` (`packages/core/src/registrar.ts`), one field of `apps/web/runtime.ts`. That file is the ONE place a backend is swapped — no setter on a package barrel, no env switch beside the default, no plugin API. Leave a field out and the boot builds the default the row names from the environment.

Writing your own adapter is four steps, the same for every port:

1. **Implement** the interface, imported from the owning package's `/adapter` subpath.
2. **Copy** the in-repo reference below — the memory one, where one ships.
3. **Prove** it: `behavesLike(<suite>, () => subject)` in a test, the suite from `@ultimat3/testing/conformance`, `behavesLike` from `@ultimat3/testing`. The subject is your adapter, or — where a check needs more than the port to observe it — the suite's own `<X>Subject` object around it; each section below names its fields.
4. **Wire** it: one field of `apps/web/runtime.ts`, which `x dev` and the container both read before a port is bound.

```ts
import type { RuntimeOverrides } from '@ultimat3/cli/serve';
import { memoryJobDriver } from '@ultimat3/jobs';

export const runtime = {
  jobs: memoryJobDriver(),
} satisfies RuntimeOverrides;
```

`runtime.ts` runs BEFORE its own ports are installed: import no app module that seals a secret or builds auth at module scope. In a test, `await swapAdapter(port, impl)` from `@ultimat3/testing` installs one for that test alone, through the same installer the boot calls; a port it cannot swap is listed in its `UNSWAPPED` with what a test does instead.

`bun run scripts/adapter-ports.ts --json` lists every port with its five parts; a part missing is `X_ADAPTER_PORT_INCOMPLETE` on the `boundaries` step. A part marked *pending* below is on that guard's ratchet (`scripts/lib/adapter-port-pins.ts`) and is being built.

| Port | Interface | Package |
|---|---|---|
| [`aiGateway`](#aigateway) | `Gateway` | `@ultimat3/ai` |
| [`auditSink`](#auditsink) | `AuditSink` | `@ultimat3/core` |
| [`authLimiter`](#authlimiter) | `AuthLimiterFactory` | `@ultimat3/auth` |
| [`authServerStore`](#authserverstore) | `AuthServerStore` | `@ultimat3/auth` |
| [`cacheTiers`](#cachetiers) | `CacheTier` | `@ultimat3/cache` |
| [`clock`](#clock) | `SleepClock` | `@ultimat3/core` |
| [`errorReporter`](#errorreporter) | `ErrorReporter` | `@ultimat3/core` |
| [`eventBus`](#eventbus) | `EventBus` | `@ultimat3/jobs` |
| [`failureStore`](#failurestore) | `FailureStore` | `@ultimat3/core` |
| [`idempotencyStore`](#idempotencystore) | `IdempotencyStore` | `@ultimat3/action` |
| [`images`](#images) | `ImageTransformDriver` | `@ultimat3/seo` |
| [`isrStore`](#isrstore) | `IsrStore` | `@ultimat3/render` |
| [`jobs`](#jobs) | `JobDriver` | `@ultimat3/jobs` |
| [`mail`](#mail) | `MailDriver` | `@ultimat3/mail` |
| [`mcpConfirmationStore`](#mcpconfirmationstore) | `McpConfirmationStore` | `@ultimat3/mcp` |
| [`meterStore`](#meterstore) | `MeterStore` | `@ultimat3/action` |
| [`notifyStores`](#notifystores) | `NotifyStores` | `@ultimat3/notify` |
| [`outboxStore`](#outboxstore) | `OutboxStore` | `@ultimat3/jobs` |
| [`purge`](#purge) | `PurgeDriver` | `@ultimat3/cache` |
| [`pushSubscriptionStore`](#pushsubscriptionstore) | `PushSubscriptionStore` | `@ultimat3/pwa` |
| [`rateLimitStore`](#ratelimitstore) | `RateLimitStore` | `@ultimat3/http` |
| [`scrapeDriver`](#scrapedriver) | `ScrapeDriver` | `@ultimat3/scraping` |
| [`secretSource`](#secretsource) | `SecretSource` | `@ultimat3/core` |
| [`storage`](#storage) | `StorageDriver` | `@ultimat3/storage` |
| [`totpReplay`](#totpreplay) | `TotpReplayGuard` | `@ultimat3/auth` |
| [`transport`](#transport) | `Transport` | `@ultimat3/realtime` |

## aiGateway

| Part | Value |
|---|---|
| Interface | `Gateway` from `@ultimat3/ai/adapter` |
| Default | none: the first model call is refused (X_AI_GATEWAY_MISSING) |
| Copy | [`providerGateway`](https://github.com/developerz-ai/ultimate/blob/main/packages/ai/src/gateway.ts) in `packages/ai/src/gateway.ts` — over `echoProvider()` (`packages/ai/src/echo-provider.ts`): a gateway that never leaves the process |
| Prove | `behavesLike(gatewayConformance, () => ({ gateway, model }))` |
| Wire | `aiGateway: …` in `apps/web/runtime.ts`, typed `Gateway` |
| Boot | installed by `installAiGateway` (services phase) |

## auditSink

| Part | Value |
|---|---|
| Interface | `AuditSink` from `@ultimat3/core/adapter` |
| Default | none: an audit: true primitive is refused (X_AUDIT_SINK_MISSING) |
| Copy | [`memoryAuditSink`](https://github.com/developerz-ai/ultimate/blob/main/packages/action/src/audit-memory.ts) in `packages/action/src/audit-memory.ts` |
| Prove | `behavesLike(auditSinkConformance, () => ({ sink, kept, persists }))` |
| Wire | `auditSink: …` in `apps/web/runtime.ts`, typed `AuditSink` |
| Boot | installed by `installAuditSink` (services phase) |

## authLimiter

| Part | Value |
|---|---|
| Interface | `AuthLimiterFactory` from `@ultimat3/auth/adapter` |
| Default | postgresAuthLimiter over DATABASE_URL |
| Copy | [`memoryAuthLimiter`](https://github.com/developerz-ai/ultimate/blob/main/packages/auth/src/rate-limit.ts) in `packages/auth/src/rate-limit.ts` — the port is the factory: `(policy) => memoryAuthLimiter(clock, policy)` |
| Prove | `behavesLike(authLimiterFactoryConformance, () => ({ factory, clock }))` |
| Wire | `authLimiter: …` in `apps/web/runtime.ts`, typed `AuthLimiterFactory` |
| Boot | installed by `installAuthLimiters` (services phase) |

## authServerStore

| Part | Value |
|---|---|
| Interface | `AuthServerStore` from `@ultimat3/auth/adapter` |
| Default | postgresAuthServerStore over DATABASE_URL |
| Copy | [`memoryAuthServerStore`](https://github.com/developerz-ai/ultimate/blob/main/packages/auth/src/authorization-server-store.ts) in `packages/auth/src/authorization-server-store.ts` |
| Prove | `behavesLike(authServerStoreConformance, () => store)` |
| Wire | `authServerStore: …` in `apps/web/runtime.ts`, typed `AuthServerStore` |
| Boot | installed by `installAuthServerStore` (services phase) |

## cacheTiers

| Part | Value |
|---|---|
| Interface | `CacheTier` from `@ultimat3/cache/adapter` |
| Default | the rungs cache.tiers names; 'redis' reads REDIS_URL |
| Copy | [`lruTier`](https://github.com/developerz-ai/ultimate/blob/main/packages/cache/src/lru.ts) in `packages/cache/src/lru.ts` |
| Prove | `behavesLike(cacheTierConformance, () => tier)` |
| Wire | `cacheTiers: …` in `apps/web/runtime.ts`, typed `readonly CacheTier[]` |
| Boot | read as a value by `runtime-cache.ts, each replacing the rung of its own name` |

## clock

| Part | Value |
|---|---|
| Interface | `SleepClock` from `@ultimat3/core/adapter` |
| Default | systemClock |
| Copy | [`systemClock`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/sleep-clock.ts) in `packages/core/src/sleep-clock.ts` — `noWaitClock` beside it is the one a test hands a run that must not wait |
| Prove | `behavesLike(sleepClockConformance, () => clock)` |
| Wire | `clock: …` in `apps/web/runtime.ts`, typed `SleepClock` |
| Boot | installed by `installClock` (boot phase) |

## errorReporter

| Part | Value |
|---|---|
| Interface | `ErrorReporter` from `@ultimat3/core/adapter` |
| Default | SENTRY_DSN set: sentryErrorReporter; unset: the log line only |
| Copy | [`memoryErrorReporter`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/error-reporter.ts) in `packages/core/src/error-reporter.ts` |
| Prove | `behavesLike(errorReporterConformance, () => reporter)` |
| Wire | `errorReporter: …` in `apps/web/runtime.ts`, typed `ErrorReporter` |
| Boot | installed by `installErrorReporter` (services phase) |

## eventBus

| Part | Value |
|---|---|
| Interface | `EventBus` from `@ultimat3/jobs/adapter` |
| Default | postgresEventBus over DATABASE_URL |
| Copy | [`memoryEventBus`](https://github.com/developerz-ai/ultimate/blob/main/packages/jobs/src/events.ts) in `packages/jobs/src/events.ts` |
| Prove | `behavesLike(eventBusConformance, () => ({ bus, elapse }))` |
| Wire | `eventBus: …` in `apps/web/runtime.ts`, typed `EventBus` |
| Boot | installed by `installEventBus` (queue phase) |

## failureStore

| Part | Value |
|---|---|
| Interface | `FailureStore` from `@ultimat3/core/adapter` |
| Default | postgresFailureStore over DATABASE_URL, while failureCapture is on |
| Copy | [`postgresFailureStore`](https://github.com/developerz-ai/ultimate/blob/main/packages/db/src/failure-store-pg.ts) in `packages/db/src/failure-store-pg.ts` — no memory store ships: the Postgres one is the reference |
| Prove | `behavesLike(failureStoreConformance, () => ({ store, find, client }))` |
| Wire | `failureStore: …` in `apps/web/runtime.ts`, typed `FailureStore` |
| Boot | read as a value by `failure-capture-boot.ts, while failureCapture is on` |

## idempotencyStore

| Part | Value |
|---|---|
| Interface | `IdempotencyStore` from `@ultimat3/action/adapter` |
| Default | postgresIdempotencyStore over DATABASE_URL |
| Copy | [`memoryIdempotencyStore`](https://github.com/developerz-ai/ultimate/blob/main/packages/action/src/idempotency-memory.ts) in `packages/action/src/idempotency-memory.ts` |
| Prove | `behavesLike(idempotencyStoreConformance, () => ({ store, client, reclaimAfterMs, age, reset }))` |
| Wire | `idempotencyStore: …` in `apps/web/runtime.ts`, typed `IdempotencyStore` |
| Boot | installed by `installIdempotencyStore` (queue phase) |

## images

| Part | Value |
|---|---|
| Interface | `ImageTransformDriver` from `@ultimat3/seo/adapter` |
| Default | builtinImageDriver |
| Copy | [`builtinImageDriver`](https://github.com/developerz-ai/ultimate/blob/main/packages/seo/src/image-driver.ts) in `packages/seo/src/image-driver.ts` |
| Prove | `behavesLike(imageTransformDriverConformance, () => driver)` |
| Wire | `images: …` in `apps/web/runtime.ts`, typed `ImageTransformDriver` |
| Boot | read as a value by `serve-web.ts, the /media/* transform` |

## isrStore

| Part | Value |
|---|---|
| Interface | `IsrStore` from `@ultimat3/render/adapter` |
| Default | a memory store per process |
| Copy | [`memoryIsrStore`](https://github.com/developerz-ai/ultimate/blob/main/packages/render/src/render-isr-store.ts) in `packages/render/src/render-isr-store.ts` |
| Prove | `behavesLike(isrStoreConformance, () => store)` |
| Wire | `isrStore: …` in `apps/web/runtime.ts`, typed `IsrStore` |
| Boot | read as a value by `serve-web.ts, the ISR controller` |

## jobs

| Part | Value |
|---|---|
| Interface | `JobDriver` from `@ultimat3/jobs/adapter` |
| Default | postgresJobDriver over DATABASE_URL |
| Copy | [`memoryJobDriver`](https://github.com/developerz-ai/ultimate/blob/main/packages/jobs/src/driver-memory.ts) in `packages/jobs/src/driver-memory.ts` |
| Prove | `behavesLike(jobDriverConformance, () => driver)` |
| Wire | `jobs: …` in `apps/web/runtime.ts`, typed `JobDriver` |
| Boot | installed by `installJobDriver` (queue phase) |

## mail

| Part | Value |
|---|---|
| Interface | `MailDriver` from `@ultimat3/mail/adapter` |
| Default | SMTP_URL: smtp; RESEND_API_KEY: resend; SES_REGION: ses; none: memory in development/test, refused at the first send elsewhere |
| Copy | [`memoryMailDriver`](https://github.com/developerz-ai/ultimate/blob/main/packages/mail/src/driver.ts) in `packages/mail/src/driver.ts` |
| Prove | `behavesLike(mailDriverConformance, () => driver)` |
| Wire | `mail: …` in `apps/web/runtime.ts`, typed `MailDriver` |
| Boot | installed by `installMailDriver` (services phase) |

## mcpConfirmationStore

| Part | Value |
|---|---|
| Interface | `McpConfirmationStore` from `@ultimat3/mcp/adapter` |
| Default | postgresConfirmationStore over DATABASE_URL |
| Copy | [`memoryConfirmationStore`](https://github.com/developerz-ai/ultimate/blob/main/packages/mcp/src/confirmation-store.ts) in `packages/mcp/src/confirmation-store.ts` |
| Prove | `behavesLike(mcpConfirmationStoreConformance, () => store)` |
| Wire | `mcpConfirmationStore: …` in `apps/web/runtime.ts`, typed `McpConfirmationStore` |
| Boot | installed by `installConfirmationStore` (services phase) |

## meterStore

| Part | Value |
|---|---|
| Interface | `MeterStore` from `@ultimat3/action/adapter` |
| Default | postgresMeterStore over DATABASE_URL |
| Copy | [`memoryMeterStore`](https://github.com/developerz-ai/ultimate/blob/main/packages/action/src/meter-memory.ts) in `packages/action/src/meter-memory.ts` |
| Prove | `behavesLike(meterStoreConformance, () => store)` |
| Wire | `meterStore: …` in `apps/web/runtime.ts`, typed `MeterStore` |
| Boot | installed by `installMeterStore` (queue phase) |

## notifyStores

| Part | Value |
|---|---|
| Interface | `NotifyStores` from `@ultimat3/notify/adapter` |
| Default | Postgres delivery ledger when the app has a database; memory in development/test; refused elsewhere (X_NOTIFY_STORE_MISSING); allow-all preferences, no inbox, no digest |
| Copy | [`memoryDeliveryLedger`](https://github.com/developerz-ai/ultimate/blob/main/packages/notify/src/ledger.ts) in `packages/notify/src/ledger.ts` — one member of four: `memoryPreferenceStore`, `memoryInboxStore` and `memoryDigestStore` are the others, one file each |
| Prove | `behavesLike(notifyStoresConformance, () => ({ ledger, inbox, preferences, digest }))` |
| Wire | `notifyStores: …` in `apps/web/runtime.ts`, typed `NotifyStores` |
| Boot | installed by `installNotifyStores` (services phase) |

## outboxStore

| Part | Value |
|---|---|
| Interface | `OutboxStore` from `@ultimat3/jobs/adapter` |
| Default | postgresOutboxStore over DATABASE_URL |
| Copy | [`memoryOutboxStore`](https://github.com/developerz-ai/ultimate/blob/main/packages/jobs/src/outbox.ts) in `packages/jobs/src/outbox.ts` |
| Prove | `behavesLike(outboxStoreConformance, () => ({ relay, claimLeaseMs, transaction, elapse }))` |
| Wire | `outboxStore: …` in `apps/web/runtime.ts`, typed `OutboxStore` |
| Boot | read as a value by `runtime-queue.ts, behind the jobs facade with the jobs port` |

## purge

| Part | Value |
|---|---|
| Interface | `PurgeDriver` from `@ultimat3/cache/adapter` |
| Default | CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID: cloudflare; FASTLY_API_TOKEN + FASTLY_SERVICE_ID: fastly; neither: none |
| Copy | [`noopPurgeDriver`](https://github.com/developerz-ai/ultimate/blob/main/packages/cache/src/cdn.ts) in `packages/cache/src/cdn.ts` |
| Prove | `behavesLike(purgeDriverConformance, () => ({ driver, refused }))` |
| Wire | `purge: …` in `apps/web/runtime.ts`, typed `PurgeDriver` |
| Boot | read as a value by `runtime-cache.ts, the cdn tier` |

## pushSubscriptionStore

| Part | Value |
|---|---|
| Interface | `PushSubscriptionStore` from `@ultimat3/pwa/adapter` |
| Default | postgresPushSubscriptionStore over DATABASE_URL, while VAPID keys are set |
| Copy | [`memoryPushSubscriptionStore`](https://github.com/developerz-ai/ultimate/blob/main/packages/pwa/src/push-store.ts) in `packages/pwa/src/push-store.ts` |
| Prove | `behavesLike(pushSubscriptionStoreConformance, () => store)` |
| Wire | `pushSubscriptionStore: …` in `apps/web/runtime.ts`, typed `PushSubscriptionStore` |
| Boot | read as a value by `runtime-push.ts, while pwa.vapid is set` |

## rateLimitStore

| Part | Value |
|---|---|
| Interface | `RateLimitStore` from `@ultimat3/http/adapter` |
| Default | postgresRateLimitStore over DATABASE_URL |
| Copy | [`memoryRateLimitStore`](https://github.com/developerz-ai/ultimate/blob/main/packages/http/src/rate-limit.ts) in `packages/http/src/rate-limit.ts` |
| Prove | `behavesLike(rateLimitStoreConformance, () => store)` |
| Wire | `rateLimitStore: …` in `apps/web/runtime.ts`, typed `RateLimitStore` |
| Boot | installed by `installRateLimitStore` (services phase) |

## scrapeDriver

| Part | Value |
|---|---|
| Interface | `ScrapeDriver` from `@ultimat3/scraping/adapter` |
| Default | none: a scrape() declaring no driver is refused at its first run |
| Copy | [`fakeBrowser`](https://github.com/developerz-ai/ultimate/blob/main/packages/scraping/src/driver-fake.ts) in `packages/scraping/src/driver-fake.ts` |
| Prove | `behavesLike(scrapeDriverConformance, () => driver)` |
| Wire | `scrapeDriver: …` in `apps/web/runtime.ts`, typed `ScrapeDriver` |
| Boot | installed by `installScrapeDriver` (services phase) |

## secretSource

| Part | Value |
|---|---|
| Interface | `SecretSource` from `@ultimat3/core/adapter` |
| Default | ULTIMATE_SECRETS_KEY, then the .secrets.key file |
| Copy | [`envSecretSource`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/secret-source.ts) in `packages/core/src/secret-source.ts` |
| Prove | `behavesLike(secretSourceConformance, () => ({ source, holding, empty }))` |
| Wire | `secretSource: …` in `apps/web/runtime.ts`, typed `SecretSource` |
| Boot | installed by `installSecretSource` (boot phase) |

## storage

| Part | Value |
|---|---|
| Interface | `StorageDriver` from `@ultimat3/storage/adapter` |
| Default | S3_ENDPOINT set: s3; unset: the embedded disk |
| Copy | [`memoryStorageDriver`](https://github.com/developerz-ai/ultimate/blob/main/packages/storage/src/driver-memory.ts) in `packages/storage/src/driver-memory.ts` |
| Prove | `behavesLike(storageDriverConformance, () => driver)` |
| Wire | `storage: …` in `apps/web/runtime.ts`, typed `StorageDriver` |
| Boot | read as a value by `runtime-storage-boot.ts, the default disk` |

## totpReplay

| Part | Value |
|---|---|
| Interface | `TotpReplayGuard` from `@ultimat3/auth/adapter` |
| Default | postgresTotpReplayGuard over DATABASE_URL |
| Copy | [`memoryTotpReplayGuard`](https://github.com/developerz-ai/ultimate/blob/main/packages/auth/src/mfa.ts) in `packages/auth/src/mfa.ts` |
| Prove | `behavesLike(totpReplayGuardConformance, () => guard)` |
| Wire | `totpReplay: …` in `apps/web/runtime.ts`, typed `TotpReplayGuard` |
| Boot | installed by `installTotpReplay` (services phase) |

## transport

| Part | Value |
|---|---|
| Interface | `Transport` from `@ultimat3/realtime/adapter` |
| Default | NATS_URL set: nats; unset: memory (one node) |
| Copy | [`InProcessTransport`](https://github.com/developerz-ai/ultimate/blob/main/packages/realtime/src/fanout.ts) in `packages/realtime/src/fanout.ts` |
| Prove | `behavesLike(transportConformance, () => transport)` |
| Wire | `transport: …` in `apps/web/runtime.ts`, typed `Transport` |
| Boot | read as a value by `runtime-bus.ts, which installs the channel transport it dials` |
