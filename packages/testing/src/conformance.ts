// `@ultimat3/testing/conformance` — every port's contract as shared examples, one suite per
// interface an app may implement: `behavesLike(<port>Conformance, () => yours)`. Its own entry point,
// off the `.` barrel: these suites statically import the packages whose ports they hold to.
// Grouped by the package that owns the interface; names match `ADAPTER_PORTS[].conformance`.

// @ultimat3/ai — Gateway (aiGateway), Embedder (embedder), SemanticCacheFactory (semanticCache),
// BudgetStore; Provider, VectorStore (no rows)
export type { GatewayCheck, GatewaySubject } from './ai-gateway-conformance';
export { GATEWAY_CHECKS, gatewayConformance } from './ai-gateway-conformance';
export type { ProviderCheck, ProviderSubject } from './ai-provider-conformance';
export { PROVIDER_CHECKS, providerConformance } from './ai-provider-conformance';
export type {
  ProviderTransportCheck,
  ProviderTransportSubject,
} from './ai-provider-transport-conformance';
export {
  PROVIDER_TRANSPORT_CHECKS,
  providerTransportConformance,
} from './ai-provider-transport-conformance';
// @ultimat3/core — AuditSink, FailureStore, SleepClock (clock), SecretSource
export type { AuditKept, AuditSinkCheck, AuditSinkSubject } from './audit-sink-conformance';
export { AUDIT_SINK_CHECKS, auditSinkConformance } from './audit-sink-conformance';
// @ultimat3/auth — AuthLimiterFactory, AuthServerStore, TotpReplayGuard; AuthAdapter (no row)
export type { AuthAdapterCheck, AuthAdapterSubject } from './auth-adapter-conformance';
export { AUTH_ADAPTER_CHECKS, authAdapterConformance } from './auth-adapter-conformance';
export type { AuthLimiterCheck, AuthLimiterSubject } from './auth-limiter-factory-conformance';
export {
  AUTH_LIMITER_CHECKS,
  authLimiterFactoryConformance,
} from './auth-limiter-factory-conformance';
export type { AuthServerStoreCheck } from './auth-server-store-conformance';
export {
  AUTH_SERVER_STORE_CHECKS,
  authServerStoreConformance,
} from './auth-server-store-conformance';
export type { BudgetStoreCheck, BudgetStoreLike } from './budget-store-conformance';
export { BUDGET_STORE_CHECKS, budgetStoreConformance } from './budget-store-conformance';
// @ultimat3/cache — CacheTier (cacheTiers), PurgeDriver (purge)
export type { CacheTierCheck } from './cache-tier-conformance';
export { CACHE_TIER_CHECKS, cacheTierConformance } from './cache-tier-conformance';
export type { SleepClockCheck } from './clock-conformance';
export { SLEEP_CLOCK_CHECKS, sleepClockConformance } from './clock-conformance';
export type { EmbedderCheck } from './embedder-conformance';
export { EMBEDDER_CHECKS, embedderConformance } from './embedder-conformance';
// @ultimat3/entity — the Driver behind `database()` (no row: chosen per `database()` call)
export { ENTITY_DRIVER_CHECKS } from './entity-conformance-checks';
export type {
  EntityDriverCheck,
  EntityDriverRun,
  EntityDriverSubject,
} from './entity-driver-conformance';
export { entityDriverConformance } from './entity-driver-conformance';
// @ultimat3/admin — ErrorGroupsStore (no ADAPTER_PORTS row)
export type {
  ErrorGroupLike,
  ErrorGroupOccurrenceLike,
  ErrorGroupStatusLike,
  ErrorGroupsStoreCheck,
  ErrorGroupsStoreLike,
} from './error-groups-store-conformance';
export {
  ERROR_GROUPS_STORE_CHECKS,
  errorGroupsStoreConformance,
} from './error-groups-store-conformance';
// @ultimat3/core — ErrorReporter (errorReporter)
export type { ErrorReporterCheck, ErrorReporterSubject } from './error-reporter-conformance';
export {
  conformanceReport,
  ERROR_REPORTER_CHECKS,
  errorReporterConformance,
} from './error-reporter-conformance';
// @ultimat3/jobs — JobDriver (jobs), EventBus, OutboxStore; StepStore, LeaseStore (JobDriver's)
export type { EventBusCheck, EventBusSubject } from './event-bus-conformance';
export { EVENT_BUS_CHECKS, eventBusConformance } from './event-bus-conformance';
export type { FailureStoreCheck, FailureStoreSubject } from './failure-store-conformance';
export {
  FAILURE_STORE_CHECKS,
  failureBundle,
  failureStoreConformance,
} from './failure-store-conformance';
// @ultimat3/action — IdempotencyStore, MeterStore
export type {
  IdempotencyStoreCheck,
  IdempotencyStoreSubject,
} from './idempotency-store-conformance';
export {
  IDEMPOTENCY_STORE_CHECKS,
  idempotencyKeyOf,
  idempotencyStoreConformance,
} from './idempotency-store-conformance';
// @ultimat3/auth — IdentityProvider (no row: an app holds several at once, by id)
export type {
  IdentityProviderCheck,
  IdentityProviderHarness,
} from './identity-provider-conformance';
export {
  IDENTITY_PROVIDER_CHECKS,
  identityProviderConformance,
} from './identity-provider-conformance';
// @ultimat3/seo — ImageTransformDriver (images)
export type { ImageTransformCheck, ImageTransformSubject } from './image-transform-conformance';
export {
  IMAGE_CONFORMANCE_SOURCE,
  IMAGE_TRANSFORM_CHECKS,
  imageTransformDriverConformance,
} from './image-transform-conformance';
// @ultimat3/render — IsrStore
export type { IsrStoreCheck } from './isr-store-conformance';
export { ISR_STORE_CHECKS, isrStoreConformance } from './isr-store-conformance';
export type { JobDriverCheck } from './job-driver-checks';
export { JOB_DRIVER_CHECKS } from './job-driver-checks';
export { jobDriverConformance } from './job-driver-conformance';
export type { LeaseStoreCheck, LeaseStoreSubject } from './lease-store-conformance';
export { LEASE_STORE_CHECKS, leaseStoreConformance } from './lease-store-conformance';
// @ultimat3/mail — MailDriver
export type { MailDriverCheck } from './mail-driver-conformance';
export {
  conformanceMail,
  MAIL_DRIVER_CHECKS,
  mailDriverConformance,
} from './mail-driver-conformance';
// @ultimat3/mcp — McpConfirmationStore
export type { McpConfirmationStoreCheck } from './mcp-confirmation-store-conformance';
export {
  MCP_CONFIRMATION_STORE_CHECKS,
  mcpConfirmationStoreConformance,
} from './mcp-confirmation-store-conformance';
export type { MeterStoreCheck } from './meter-store-conformance';
export { METER_STORE_CHECKS, meterStoreConformance } from './meter-store-conformance';
// @ultimat3/notify — NotifyStores (notifyStores) and each store alone
export type { DigestStoreCheck } from './notify-digest-conformance';
export { DIGEST_STORE_CHECKS } from './notify-digest-conformance';
export type { InboxStoreCheck } from './notify-inbox-conformance';
export { INBOX_STORE_CHECKS } from './notify-inbox-conformance';
export type { DeliveryLedgerCheck } from './notify-ledger-conformance';
export { DELIVERY_LEDGER_CHECKS } from './notify-ledger-conformance';
export type { PreferenceStoreCheck } from './notify-preference-conformance';
export { PREFERENCE_STORE_CHECKS } from './notify-preference-conformance';
export type { NotifyStoresSubject } from './notify-stores-conformance';
export {
  deliveryLedgerConformance,
  digestStoreConformance,
  inboxStoreConformance,
  notifyStoresConformance,
  preferenceStoreConformance,
} from './notify-stores-conformance';
export type { OutboxStoreCheck, OutboxStoreSubject } from './outbox-store-conformance';
export { OUTBOX_STORE_CHECKS, outboxStoreConformance } from './outbox-store-conformance';
export type { PurgeCheck, PurgeSubject } from './purge-conformance';
export { PURGE_CHECKS, purgeDriverConformance } from './purge-conformance';
export type { PushDeviceStoreCheck } from './push-device-conformance';
export { PUSH_DEVICE_STORE_CHECKS, pushDeviceStoreConformance } from './push-device-conformance';
// @ultimat3/pwa — PushSubscriptionStore
export type { PushSubscriptionStoreCheck } from './push-subscription-conformance';
export {
  PUSH_SUBSCRIPTION_STORE_CHECKS,
  pushSubscriptionStoreConformance,
} from './push-subscription-conformance';
// @ultimat3/http — RateLimitStore
export type { RateLimitStoreCheck } from './rate-limit-store-conformance';
export {
  RATE_LIMIT_STORE_CHECKS,
  rateLimitStoreConformance,
} from './rate-limit-store-conformance';
// @ultimat3/scraping — ScrapeDriver
export { SCRAPE_DRIVER_CHECKS, scrapeDriverConformance } from './scrape-driver-conformance';
export type { ScrapeDriverCheck } from './scrape-driver-conformance-page-checks';
export {
  SCRAPE_CONFORMANCE_HOST,
  SCRAPE_CONFORMANCE_HTTP,
  SCRAPE_CONFORMANCE_PAGES,
  SCRAPE_CONFORMANCE_URLS,
} from './scrape-driver-conformance-site';
// @ultimat3/entity — SearchIndex (searchIndex)
export {
  SEARCH_INDEX_ALL_CHECKS,
  SEARCH_INDEX_CHECKS,
  searchIndexConformance,
} from './search-index-conformance';
export {
  listAll as listSearchDocuments,
  SEARCH_INDEX_LIST_CHECKS,
} from './search-index-conformance-list';
export type {
  SearchDocOptions,
  SearchIndexCheck,
  SearchIndexSubject,
} from './search-index-conformance-support';
export {
  SEARCH_TENANT_A,
  SEARCH_TENANT_B,
  searchDoc,
  searchDocId,
} from './search-index-conformance-support';
export { SEARCH_INDEX_VERSION_CHECKS } from './search-index-conformance-versions';
export type { SecretSourceCheck, SecretSourceSubject } from './secret-source-conformance';
export { SECRET_SOURCE_CHECKS, secretSourceConformance } from './secret-source-conformance';
export type { SemanticCacheFactoryCheck } from './semantic-cache-factory-conformance';
export {
  SEMANTIC_CACHE_FACTORY_CHECKS,
  semanticCacheFactoryConformance,
} from './semantic-cache-factory-conformance';
// @ultimat3/notify — SmsTransport (smsTransport)
export type { SmsTransportCheck } from './sms-transport-conformance';
export {
  conformanceSms,
  SMS_TRANSPORT_CHECKS,
  smsTransportConformance,
} from './sms-transport-conformance';
export type { StepStoreCheck, StepStoreSubject } from './step-store-conformance';
export { STEP_STORE_CHECKS, stepStoreConformance } from './step-store-conformance';
// @ultimat3/storage — StorageDriver
export type { StorageCheck, StorageDriverLike } from './storage-conformance';
export { STORAGE_DRIVER_CHECKS, storageDriverConformance } from './storage-conformance';
export type { TotpReplayGuardCheck } from './totp-replay-guard-conformance';
export {
  TOTP_REPLAY_GUARD_CHECKS,
  totpReplayGuardConformance,
} from './totp-replay-guard-conformance';
// @ultimat3/realtime — Transport
export type { TransportCheck } from './transport-conformance';
export { TRANSPORT_CHECKS, transportConformance } from './transport-conformance';
// @ultimat3/storage — UploadScanner (uploadScanner), structural
export type {
  ScanVerdictLike,
  UploadScannerCheck,
  UploadScannerLike,
} from './upload-scanner-conformance';
export {
  UPLOAD_SCANNER_CHECKS,
  UPLOAD_SCANNER_EICAR,
  uploadScannerConformance,
} from './upload-scanner-conformance';
export { vectorStoreConformance } from './vector-store-conformance';
export type { VectorStoreCheck } from './vector-store-conformance-checks';
export {
  VECTOR_CONFORMANCE_DIMENSION,
  VECTOR_STORE_CHECKS,
} from './vector-store-conformance-checks';
