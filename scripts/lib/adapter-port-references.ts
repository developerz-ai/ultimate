// What the generated `wiki/Adapters.md` cites per port: the in-repo implementation an adapter
// author copies, and the subject each conformance suite takes. Keyed by `AdapterPortName`, so a
// row core adds is a build error here. Reference data, never a ratchet: `adapter-port-pins.ts`
// holds the tables that only shrink.

import type { AdapterPortName } from '../../packages/core/src/registrar';

/** The in-repo implementation an adapter author copies: `file` declares `symbol`. */
export interface PortReference {
  readonly file: string;
  readonly symbol: string;
  readonly note?: string;
}

/** One per row — keyed by `AdapterPortName`, so a row core adds is a build error here. */
export const PORT_REFERENCES: Readonly<Record<AdapterPortName, PortReference>> = Object.freeze({
  aiGateway: {
    file: 'packages/ai/src/gateway.ts',
    symbol: 'providerGateway',
    note: 'over `echoProvider()` (`packages/ai/src/echo-provider.ts`): a gateway that never leaves the process',
  },
  auditSink: { file: 'packages/action/src/audit-memory.ts', symbol: 'memoryAuditSink' },
  authLimiter: {
    file: 'packages/auth/src/rate-limit.ts',
    symbol: 'memoryAuthLimiter',
    note: 'the port is the factory: `(policy) => memoryAuthLimiter(clock, policy)`',
  },
  authServerStore: {
    file: 'packages/auth/src/authorization-server-store.ts',
    symbol: 'memoryAuthServerStore',
  },
  cacheTiers: { file: 'packages/cache/src/lru.ts', symbol: 'lruTier' },
  clock: {
    file: 'packages/core/src/sleep-clock.ts',
    symbol: 'systemClock',
    note: '`noWaitClock` beside it is the one a test hands a run that must not wait',
  },
  errorReporter: { file: 'packages/core/src/error-reporter.ts', symbol: 'memoryErrorReporter' },
  eventBus: { file: 'packages/jobs/src/events.ts', symbol: 'memoryEventBus' },
  failureStore: {
    file: 'packages/db/src/failure-store-pg.ts',
    symbol: 'postgresFailureStore',
    note: 'no memory store ships: the Postgres one is the reference',
  },
  idempotencyStore: {
    file: 'packages/action/src/idempotency-memory.ts',
    symbol: 'memoryIdempotencyStore',
  },
  images: { file: 'packages/seo/src/image-driver.ts', symbol: 'builtinImageDriver' },
  isrStore: { file: 'packages/render/src/render-isr-store.ts', symbol: 'memoryIsrStore' },
  jobs: { file: 'packages/jobs/src/driver-memory.ts', symbol: 'memoryJobDriver' },
  mail: { file: 'packages/mail/src/driver.ts', symbol: 'memoryMailDriver' },
  mcpConfirmationStore: {
    file: 'packages/mcp/src/confirmation-store.ts',
    symbol: 'memoryConfirmationStore',
  },
  meterStore: { file: 'packages/action/src/meter-memory.ts', symbol: 'memoryMeterStore' },
  notifyStores: {
    file: 'packages/notify/src/ledger.ts',
    symbol: 'memoryDeliveryLedger',
    note: 'one member of four: `memoryPreferenceStore`, `memoryInboxStore` and `memoryDigestStore` are the others, one file each',
  },
  outboxStore: { file: 'packages/jobs/src/outbox.ts', symbol: 'memoryOutboxStore' },
  purge: { file: 'packages/cache/src/cdn.ts', symbol: 'noopPurgeDriver' },
  pushSubscriptionStore: {
    file: 'packages/pwa/src/push-store.ts',
    symbol: 'memoryPushSubscriptionStore',
  },
  rateLimitStore: { file: 'packages/http/src/rate-limit.ts', symbol: 'memoryRateLimitStore' },
  scrapeDriver: { file: 'packages/scraping/src/driver-fake.ts', symbol: 'fakeBrowser' },
  secretSource: { file: 'packages/core/src/secret-source.ts', symbol: 'envSecretSource' },
  storage: { file: 'packages/storage/src/driver-memory.ts', symbol: 'memoryStorageDriver' },
  totpReplay: { file: 'packages/auth/src/mfa.ts', symbol: 'memoryTotpReplayGuard' },
  transport: { file: 'packages/realtime/src/fanout.ts', symbol: 'InProcessTransport' },
});

/**
 * What each suite's subject thunk answers — the adapter itself, or the suite's `<X>Subject` object
 * (`packages/testing/src/<port>-conformance*.ts`, read 2026-11-09). Rendered into the page's
 * one-liner; hand-kept, so a suite that changes its subject changes this row in the same diff.
 */
export const CONFORMANCE_SUBJECTS: Readonly<Record<AdapterPortName, string>> = Object.freeze({
  aiGateway: '({ gateway, model })',
  auditSink: '({ sink, kept, persists })',
  authLimiter: '({ factory, clock })',
  authServerStore: 'store',
  cacheTiers: 'tier',
  clock: 'clock',
  errorReporter: 'reporter',
  eventBus: '({ bus, elapse })',
  failureStore: '({ store, find, client })',
  idempotencyStore: '({ store, client, reclaimAfterMs, age, reset })',
  images: 'driver',
  isrStore: 'store',
  jobs: 'driver',
  mail: 'driver',
  mcpConfirmationStore: 'store',
  meterStore: 'store',
  notifyStores: '({ ledger, inbox, preferences, digest })',
  outboxStore: '({ relay, claimLeaseMs, transaction, elapse })',
  purge: '({ driver, refused })',
  pushSubscriptionStore: 'store',
  rateLimitStore: 'store',
  scrapeDriver: 'driver',
  secretSource: '({ source, holding, empty })',
  storage: 'driver',
  totpReplay: 'guard',
  transport: 'transport',
});
