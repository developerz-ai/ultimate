// Single responsibility: the public API of @ultimat3/core. Explicit named exports only —
// every other package imports from here, so this list is the tier-0 contract.
//
// Three slices arrive through a barrel in `exports/` — observability, the error contract and
// secrets — because each is one subject spread over a dozen modules. Every name they carry is
// still written out below: `export *` would make the contract something a reader has to resolve.

// Anchored on purpose, and not by the `sideEffects` array alone: Bun before 1.4.1 read any array as
// `false` and dropped the module regardless (oven-sh/bun#40650), and a bare import holds on every
// bundler — the array still lists both, because one that honours it drops a bare import of a module
// it does not list. This module registers @ultimat3/schema's error TITLES, because schema is tier 0
// and cannot register its own — and what reads them is `UltimateError`'s constructor, which never
// imports this file. Shaken out, every X_VALIDATION_FAILED renders untitled in the browser with
// nothing to say why. `SIDE_EFFECTS_ANCHORS` carries the argument and `bun run side-effects`
// enforces it. `context.ts`, `lifecycle-errors.ts` and `secrets-errors.ts` also run something at
// import and are neither anchored NOR listed: only their own bindings need the effect, so they ride
// along exactly where they are used. Listed, Bun 1.4.2 kept all three in every chunk reaching this
// barrel, ~5.4 kB an island (`SIDE_EFFECTS_BY_USE` in `scripts/side-effects.ts`).
import './core-error-codes';
import './schema-error-codes';

export type {
  Actor,
  ActorFactKey,
  ActorFactMap,
  ActorFacts,
  ActorInit,
  ActorKind,
  ActorOrigin,
} from './actor';
export {
  ACTOR_KINDS,
  actorFact,
  actorLabel,
  actorOf,
  actorOrigin,
  agentActor,
  anonymousActor,
  grantCovers,
  hasRole,
  hasScope,
  isActorKind,
  isAnonymous,
  serviceActor,
  userActor,
  withFacts,
} from './actor';
export type { AddressClass } from './address-class';
export { addressNetwork, classifyAddress, isPublicAddress } from './address-class';
export { APP_VERSION_KEY, appVersion, DEFAULT_APP_VERSION } from './app-version';
export { type AssertCodedOptions, assert, assertCoded, assertNever } from './assert';
export { type AsyncContext, asyncContext } from './async-context';
/** The four shapes an async region can be in — produced by `realtime`, rendered by `ui`. */
export type { AsyncState } from './async-state';
/** The audit seam `action` and `query` share: one record shape, one installed sink. */
export type {
  AuditFailure,
  AuditOutcome,
  AuditPrimitive,
  AuditRecord,
  AuditSink,
  AuditSurface,
} from './audit';
export {
  AUDIT_RECORD_FIELDS,
  getAuditSink,
  resetAuditSink,
  setAuditSink,
} from './audit';
export type {
  AwsCredentials,
  AwsPayload,
  SignAwsRequestInput,
  SignedAwsRequest,
} from './aws-sigv4';
export { signAwsRequest, UNSIGNED_PAYLOAD } from './aws-sigv4';
export type { BackoffCurve, BackoffOptions, JitterMode, Random } from './backoff';
export { backoffDelay, jitterStatedDelay } from './backoff';
export { isCompiledBundle } from './bunfs';
export { CACHE_TIERS, type CacheTierName } from './cache-vocabulary';
export { canonicalJson, fingerprint } from './canonical-json';
export type { FetchLike, TransportRequest } from './client-dispatch';
export { BUILD_ID_HEADER, IDEMPOTENCY_HEADER } from './client-dispatch';
/**
 * Flight control for a typed client, and OPT-IN by construction: `@ultimat3/action`'s and
 * `@ultimat3/query`'s `client.ts` each name `ClientFlight` as a TYPE only, so a caller that never
 * mentions `clientFlight` pays nothing for the fence, the dedup map or the retry loop.
 * Both packages re-export these names unchanged; this is the one copy.
 */
export type {
  ClientFlight,
  ClientFlightOptions,
  ClientRetry,
  FlightKeyOptions,
  FlightPlan,
} from './client-flight';
export { clientFlight, DEFAULT_CLIENT_RETRY, isTransientFailure } from './client-flight';
export type { ActionPathStyle, ActionRoute } from './client-paths';
export {
  ACTION_PATH_PREFIX,
  ACTION_PATH_STYLES,
  actionPath,
  actionRoute,
  pluralize,
  QUERY_PATH_PREFIX,
  queryPath,
  splitWords,
} from './client-paths';
export type { TransportFailure } from './client-problem';
export { MAX_REMOTE_TITLE_LENGTH, remoteTitleOf, withStatedDelay } from './client-problem';
/** What a decoder reads off a refusal: the stated `Retry-After`, and the body's display title. */
export { MAX_RETRY_AFTER_SECONDS, retryAfterSecondsOf } from './client-retry-after';
/**
 * The browser seam (plan 101): ONE HTTP function, the records envelope it decodes, the per-tab
 * page handle records land in, and the principal fence every client layer subscribes to.
 */
export type { ClientScope } from './client-scope';
export { onRescope, rescope } from './client-scope';
export { clientTransport } from './client-transport';
/** What a typed client puts on the wire. `retryForStatus` is what fills a failure's `retry`. */
export type { WireAnswer } from './client-wire';
export { FRAMEWORK_CODE, problemOf, retryForStatus, traceHeaders } from './client-wire';
export { notifyClientWrite, onClientWrite } from './client-writes';
export { type Clock, type FrozenClock, frozenClock, systemClock } from './clock';
export type {
  AppConfig,
  AppConfigInput,
  AppConfigOverlay,
  AuthConfig,
  CacheConfig,
  DatabaseConfig,
  JobsConfig,
  NotifyConfig,
  PwaConfigInput,
  RealtimeConfig,
  RealtimeTransport,
  ThemeConfig,
  ThemeMode,
} from './config';
export { defineConfig, INBOX_RETENTION_KEYS } from './config';
export type { AiConfig, AiConfigInput, McpConfig } from './config-ai';
export type { DrainConfig, HealthConfig, ReadinessMode } from './config-health';
export { READINESS_MODES } from './config-health';
export type { IslandsConfig, IslandsSection, IslandsSectionInput } from './config-islands';
export { JOBS_CONCURRENCY_DEFAULT, type JobsConcurrency } from './config-jobs';
export type {
  MailConfig,
  MailRetainMimeConfig,
  MailSection,
  MailSectionInput,
} from './config-mail';
export type {
  NavigationConfig,
  NavigationSection,
  NavigationSectionInput,
  NavigationSurface,
  SpeculationConfig,
  SpeculationEagerness,
} from './config-navigation';
export {
  DEFAULT_SPECULATION,
  NAVIGATION_SURFACES,
  SPECULATION_EAGERNESS,
} from './config-navigation';
export type {
  PwaColors,
  PwaConfig,
  PwaImage,
  PwaOfflineConfig,
  PwaSchemeColors,
  PwaScreenshot,
  PwaShortcut,
  PwaText,
  PwaVapidConfig,
} from './config-pwa';
export {
  isSameOriginPath,
  PWA_COLOR_KEYS,
  PWA_PUSH_FIX,
  PWA_SCHEMES,
  pushWired,
} from './config-pwa';
export type {
  SeoConfig,
  SeoConfigInput,
  SeoRobotsConfig,
  SeoSitemapConfig,
  SiteConfig,
  SitemapLastmod,
  SiteSections,
  SiteSectionsInput,
} from './config-site';
export { SITEMAP_LASTMOD_SOURCES } from './config-site';
export type { ConflictPolicy, ResolveConflictOptions, Row } from './conflict-policy';
export { resolveConflict } from './conflict-policy';
export type { Ctx, CtxFacts, CtxInit, CtxPatch, CtxServices, ServiceBag } from './context';
export {
  ctxOf,
  DEFAULT_LOCALE,
  DEFAULT_TIME_ZONE,
  hasContext,
  runWithContext,
  throwIfAborted,
  tryUseContext,
  useContext,
  useService,
  withChildContext,
} from './context';
/** The one cookie codec — auth, http and i18n each parsed `Cookie:` and spelled `Set-Cookie`. */
export type { CookiePriority, CookieSameSite, SetCookieOptions } from './cookie';
export { CookieInvalidError, readCookie, serializeSetCookie } from './cookie';
export type { CursorPayload } from './cursor';
export {
  CURSOR_SECRET_FIX,
  CURSOR_SECRET_KEY,
  CursorInvalidError,
  configureCursorSigning,
  decodeCursor,
  encodeCursor,
  resetCursorSigning,
  usesDevCursorSecret,
} from './cursor';
/** The ONE page shape — `nextCursor` is `null` exactly when `hasMore` is false (25.0.0). */
export type { Page } from './cursor-page';
export { pageOf } from './cursor-page';
export { compareDecimalText } from './decimal-order';
export type { Deprecation, DeprecationField, DeprecationRender } from './deprecation';
export { recordDeprecatedCall, renderDeprecation } from './deprecation';
export type { DevSecretsOptions } from './dev-secrets';
export {
  assertNoDevSecretsOutsideLocal,
  CursorSecretDevError,
  devSecretsRefused,
} from './dev-secrets';
export {
  DRAIN_DEADLINE_DEFAULT_MS,
  DRAIN_DEADLINE_MAX_MS,
  WORKER_DRAIN_DEADLINE_MAX_MS,
} from './drain-deadline';
export type {
  Env,
  EnvBooleanVar,
  EnvCheckReport,
  EnvEnumVar,
  EnvIssue,
  EnvNumberVar,
  EnvOptions,
  EnvSchema,
  EnvStringVar,
  EnvVarDecl,
  EnvVarSummary,
  EnvVarType,
} from './env';
export { checkEnv, defineEnv, describeEnv, maskedEnvValues } from './env';
export type { EnvExampleOptions, EnvExampleReport } from './env-example';
export {
  checkEnvExample,
  ENV_EXAMPLE_PATH,
  envFileCandidates,
  parseEnvKeys,
  renderEnvExample,
} from './env-example';
export type { Environment, ResolveEnvironmentOptions } from './environment';
export {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENT_KEY,
  ENVIRONMENTS,
  EnvironmentInvalidError,
  isEnvironment,
  isLocal,
  isProduction,
  resolveEnvironment,
  tryResolveEnvironment,
} from './environment';
export type {
  CodedErrorInit,
  CoreErrorCode,
  ErrorAudience,
  ErrorCodeDeclaration,
  ErrorCodeDescriptor,
  ErrorCodeEntry,
  ErrorRetry,
  FormatErrorOptions,
  UltimateErrorInit,
  UltimateErrorJSON,
} from './exports/error-contract';
export {
  CORE_ERROR_CODES,
  ConfigInvalidError,
  classifyThrown,
  DEFAULT_ERROR_RETRY,
  declaredErrorRetry,
  deniedCallerFix,
  describeErrorCode,
  describeValue,
  EnvMissingError,
  ERROR_DOCS_URL,
  ERROR_RETRY_KINDS,
  errorCodeSnapshot,
  errorRetry,
  fixFor,
  formatError,
  hasErrorCode,
  InternalError,
  isErrorRetry,
  isFixShellSafe,
  isThrownError,
  isUltimateError,
  listErrorCodes,
  MAX_RENDERED_LENGTH,
  NotImplementedError,
  notImplemented,
  registerErrorCodes,
  registerErrorRetry,
  registeredErrorRetry,
  renderCauseValue,
  renderFixLiteral,
  renderFixShellArg,
  renderThrowable,
  resetErrorCodes,
  resetErrorRetry,
  retryFor,
  SCHEMA_ERROR_CODE_TITLES,
  singleLine,
  statedDelayMs,
  stringField,
  toUltimateError,
  UltimateError,
} from './exports/error-contract';
export type {
  AttributeValue,
  Counter,
  ErrorReport,
  ErrorReporter,
  ErrorReportingOptions,
  ErrorScope,
  ErrorSeverity,
  ErrorSource,
  Gauge,
  GaugeOptions,
  Histogram,
  HistogramOptions,
  HistogramPoint,
  InstrumentOptions,
  LogFields,
  Logger,
  LoggerOptions,
  LogLevel,
  MemoryErrorReporter,
  MemoryExporter,
  MemoryMetricExporter,
  MetricAttributes,
  MetricAttributeValue,
  MetricCollection,
  MetricDescriptor,
  MetricExporter,
  MetricKind,
  MetricPoint,
  MetricsOptions,
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpMetricExporter,
  OtlpMetricExporterOptions,
  OtlpSignal,
  OtlpSpanExporter,
  OtlpSpanExporterOptions,
  ReadableMetric,
  ReadableSpan,
  ReportErrorOptions,
  RequestSample,
  Sampler,
  SentryDsn,
  SentryEnvelopeOptions,
  SentryReporterOptions,
  Span,
  SpanAttributes,
  SpanContext,
  SpanEvent,
  SpanExporter,
  SpanKind,
  SpanResource,
  SpanStatus,
  SpanStatusCode,
  StartSpanOptions,
  TelemetryOptions,
} from './exports/observability';
export {
  alwaysOffSampler,
  alwaysOnSampler,
  collectMetrics,
  configureErrorReporting,
  configureMetrics,
  configureTelemetry,
  connections,
  counter,
  currentSampler,
  currentSpan,
  currentSpanContext,
  DEFAULT_HISTOGRAM_BOUNDS,
  DEFAULT_MAX_SERIES,
  DEFAULT_SAMPLE_RATIO,
  defaultSampler,
  ERROR_SOURCES,
  ErrorReporterDsnInvalidError,
  errorReport,
  exportMetrics,
  gauge,
  histogram,
  isRedactedKey,
  jobs,
  LOG_LEVELS,
  leasesLost,
  logger,
  METRICS_CONTENT_TYPE,
  METRICS_PATH,
  MetricCardinalityError,
  MetricNameInvalidError,
  MetricValueInvalidError,
  memoryErrorReporter,
  memoryExporter,
  memoryMetricExporter,
  metricsText,
  noopErrorReporter,
  noopExporter,
  noopMetricExporter,
  OtlpEndpointInvalidError,
  OtlpHeadersInvalidError,
  OtlpProtocolUnsupportedError,
  otlpEndpoint,
  otlpHeaders,
  otlpMetricExporter,
  otlpMetricsRequest,
  otlpSpanExporter,
  otlpTraceRequest,
  parentBasedRatioSampler,
  parseSentryDsn,
  parseTraceparent,
  queueDepth,
  REDACTED,
  ratioSampler,
  recordConnection,
  recordJob,
  recordLeaseLost,
  recordQueueDepth,
  recordRequest,
  redactKeys,
  reportError,
  requestDuration,
  requests,
  resetErrorReporting,
  resetMetrics,
  resetTelemetry,
  SCALING_METRICS,
  samplerFromEnv,
  sentryEnvelope,
  sentryErrorReporter,
  serviceResource,
  setLoggerContextFields,
  setLogStream,
  startMetricExport,
  startSpan,
  structuredLogger,
  traceparent,
  tryOtlpEndpoint,
  withSpan,
  withSpanContext,
} from './exports/observability';
export type {
  MasterKeyRef,
  MasterKeySource,
  Secret,
  SecretSummary,
  SecretsEnvelope,
  SecretsErrorCode,
  SecretsInstallOptions,
  SecretsInstallReport,
  SecretsLocation,
  SecretValues,
} from './exports/secrets';
export {
  assertSecretValues,
  describeSecrets,
  findMasterKey,
  generateMasterKey,
  installSecrets,
  isSecret,
  masterKeyId,
  masterKeyIdOf,
  masterKeyPath,
  openSecrets,
  parseMasterKey,
  promoteStagedMasterKey,
  readSecretsFile,
  requireMasterKey,
  revealOptionalSecret,
  revealSecret,
  SECRETS_ERROR_CODES,
  SECRETS_FILE,
  SECRETS_KEY_ENV,
  SECRETS_KEY_FILE,
  SECRETS_KEY_MODE,
  SecretsFileInvalidError,
  SecretsFileMissingError,
  SecretsKeyAclError,
  SecretsKeyInvalidError,
  SecretsKeyMismatchError,
  SecretsKeyMissingError,
  SecretsPlaintextInvalidError,
  SecretsTamperedError,
  sealSecrets,
  secret,
  secretsFileExists,
  secretsPath,
  serializeSecretValues,
  stagedMasterKeyPath,
  stageMasterKeyFile,
  writeMasterKeyFile,
  writeSecretsFile,
} from './exports/secrets';
export { finiteCount, finiteOption } from './finite-option';
export type {
  FlightGate,
  FlightGateLimits,
  FlightGateOptions,
  FlightGateState,
} from './flight-gate';
export { flightGate, gateOverloaded } from './flight-gate';
export { fnv1a } from './fnv1a';
export { formatBytes } from './format-bytes';
export type { GenerationFence } from './generation-fence';
export { generationFence, isSuperseded } from './generation-fence';
export type { PublicHealthBody } from './health-disclosure';
export { DEFAULT_HEALTH_DETAIL_PEERS, healthBody, healthPeerListed } from './health-disclosure';
export type { HostDecision, HostRule } from './host-rules';
export { ANY_HOST, hostDecision, hostMatches } from './host-rules';
export { escapeHtml } from './html-escape';
export type { Brand, Id } from './ids';
export {
  isSpanId,
  isTraceId,
  isUuid,
  nanoid,
  parseId,
  randomHex,
  resetIdCounter,
  spanId,
  traceId,
  typedId,
  uuidTimestamp,
  uuidV7,
} from './ids';
export type { ImageFit, ResizeSpec } from './image/canvas';
export { parseColor } from './image/color';
export {
  ImageDecodeFailedError,
  ImageTooLargeError,
  ImageUnsupportedError,
  imageDecodeFailed,
  imageFromBunError,
  imageTooLarge,
  imageUnsupported,
} from './image/errors';
export type {
  DecodableFormat,
  EncodableFormat,
  ImageTransformSpec,
} from './image/pipeline';
export {
  assertFiniteImageQuality,
  blurDataUrl,
  canDecode,
  canEncode,
  DECODABLE_FORMATS,
  DEFAULT_IMAGE_QUALITY,
  dataUrl,
  ENCODABLE_FORMATS,
  transformImageBytes,
} from './image/pipeline';
export { decodeImage, encodeImage } from './image/png-pixels';
export type { ImageFormat, ImageInfo } from './image/probe';
export { IMAGE_FORMATS, IMAGE_MIME_TYPES, probeImage, sniffImageFormat } from './image/probe';
export type { ImageSize, Raster } from './image/raster';
export {
  blankRaster,
  hasAlpha,
  MAX_IMAGE_PIXELS,
} from './image/raster';
export { impersonate, impersonationReason, isImpersonating } from './impersonate';
export { withInProcessFetch } from './in-process-fetch';
export {
  assertLocale,
  cachedFormatter,
  canonicalLocale,
  localeInvalid,
  MAX_CACHED_FORMATTERS,
  MAX_LOCALE_EXCERPT,
} from './intl-cache';
export { isIsoDateTime } from './iso-date';
export { isJsonObject } from './json-object';
export type { FingerprintMatch } from './keyed-fingerprint';
export {
  compareFingerprint,
  KEYED_FINGERPRINT_VERSION,
  keyedFingerprint,
} from './keyed-fingerprint';
export type {
  HealthPayload,
  HealthReport,
  HealthState,
  LifecycleOptions,
  OnShutdownOptions,
  ProcessSignal,
  ShutdownHook,
  ShutdownPhase,
  ShutdownReason,
} from './lifecycle';
export {
  beginWork,
  configureLifecycle,
  drain,
  drainDeadlineMs,
  healthReport,
  healthzPayload,
  idleWaiterCount,
  inflightCount,
  isDraining,
  isRetiring,
  lifecycleState,
  markReady,
  markRetiring,
  onShutdown,
  readinessCheckCount,
  readinessChecks,
  readinessGraceMs,
  readyzPayload,
  registerReadinessCheck,
  resetLifecycle,
  SHUTDOWN_PHASES,
  shutdownHookCount,
} from './lifecycle';
export {
  defaultReadinessGraceMs,
  READINESS_GRACE_DEFAULT_MS,
  READINESS_GRACE_MAX_MS,
} from './lifecycle-grace';
export type { ReadinessCheck, ReadinessStatus } from './lifecycle-readiness';
export type { SignalHandlerOptions } from './lifecycle-signals';
export { drainSignals, installSignalHandlers } from './lifecycle-signals';
export { isSelfOrigin, listeningOrigins, markListening, resetListeners } from './listeners';
export type { Direction } from './locale-direction';
export { directionOf, isRtl } from './locale-direction';
export type { LocalePathSplit } from './locale-path';
export { localeSegment, localizePath, splitLocalePath } from './locale-path';
// The supported tee: every default-writer line, after redaction, beside the streams.
export { addLogSink } from './log-tee';
// The process logger's test seam, beside nothing it groups with: where a default-writer line goes.
export type { LogSink } from './logger';
export { setLogSink } from './logger';
export {
  isMcpExposed,
  type McpAnnotationHints,
  type McpExposureDeclaration,
  type McpListFilterOp,
  type McpListParams,
} from './mcp-exposure';
export type { MeasurementActorFactory } from './measurement-actor';
export {
  declaredMeasurementActor,
  defineMeasurementActor,
  MEASUREMENT_ACTOR_ID,
  measurementActor,
  resetMeasurementActor,
} from './measurement-actor';
export { nearestName } from './nearest-name';
/** The message pwa's `sw.js` posts and realtime's outbox listens for. */
export { OUTBOX_DRAIN_MESSAGE, type OutboxDrainMessage } from './outbox-drain';
/** The `<meta name>`s render writes and the page client, realtime and pwa read. */
export {
  APP_UPDATE_MESSAGE,
  CLIENT_BUILD_META,
  CLIENT_NAVIGATION_HEADER,
  CLIENT_NAVIGATION_LOCATION_HEADER,
  CLIENT_NAVIGATION_SCOPE_HEADER,
  CLIENT_NAVIGATION_SURFACE_HEADER,
  CLIENT_PATH_STYLE_META,
  CLIENT_PERSIST_META,
  CLIENT_SCOPE_HEADER,
  CLIENT_SCOPE_META,
  CLIENT_SYNC_META,
  CLIENT_SYNC_WORKER_META,
} from './page-meta';
/** The structural Postgres seam http, auth, action and jobs share without a `@ultimat3/db` edge. */
export type { PgExecutor } from './pg-executor';
/** Test support: the one name a live suite gives the database it creates (`probe-databases`). */
export type { ProbeDatabaseEntropy } from './probe-database';
export { PROBE_DATABASE_NAME_MAX, probeDatabaseName } from './probe-database';
export type { ProbeDatabaseSweepOptions } from './probe-database-sweep';
export {
  PROBE_DATABASE_MIN_AGE_MS,
  probeDatabaseAlive,
  sweepProbeDatabases,
} from './probe-database-sweep';
export type { ProcessMetricsOptions, ProcessReading } from './process-metrics';
export { readProcess, resetProcessMetrics, startProcessMetrics } from './process-metrics';
export { hasPublicCause, registerPublicCause, resetPublicCauses } from './public-cause';
export { type CappedBody, readWithinLimit } from './read-capped';
export type { RecordEnvelope, RecordRows } from './record-envelope';
export { decodeRecordEnvelope, encodeRecordEnvelope, RECORDS_HEADER } from './record-envelope';
export { RECORDS_OPENAPI_HEADER, recordEnvelopeSchema } from './record-envelope-openapi';
export type { PageClient, RecordSink } from './record-sink';
export { pageClient } from './record-sink';
export type {
  ModuleRegistrar,
  PrimitiveFactory,
  PrimitiveKind,
  RegisteredPrimitive,
} from './registrar';
export {
  hasPrimitiveRegistrar,
  PRIMITIVE_FACTORIES,
  PRIMITIVE_KINDS,
  primitiveRegistrar,
  registerPrimitiveRegistrar,
  resetPrimitiveRegistrars,
} from './registrar';
export {
  budgetHeaders,
  REQUEST_TIMEOUT_HEADER,
  remainingBudgetMs,
} from './request-budget';
export type { RetryDecision, RetryDeps, RetryPolicy, RetryStopReason } from './retry';
export { retry, retryDecision } from './retry';
export { isRetryableStatus, RETRYABLE_STATUSES } from './retryable-status';
export type { ResolveRoleOptions, Role, RoleInfo, ScalingSignal } from './roles';
export { DEFAULT_ROLE, isRole, ROLE_INFO, ROLES, resolveRole } from './roles';
export { routeRank } from './route-rank';
export type { HydrateStrategy, OfflineStrategy, RenderMode } from './route-vocabulary';
export { HYDRATE_STRATEGIES, OFFLINE_STRATEGIES, RENDER_MODES } from './route-vocabulary';
export { safeUrl, URL_ATTRIBUTES } from './safe-url';
export {
  type OriginEvidence,
  type OriginVerdict,
  proveSameOrigin,
} from './same-origin';
export type { SealOptions, SealPurposeOptions } from './seal';
export { isSealed, open, openText, SEAL_VERSION, seal, sealAll, sealedKeyId } from './seal';
export type { SealInvalidReason } from './seal-errors';
export { SealInvalidError, SealKeyMissingError, SealKeyUnknownError } from './seal-errors';
export type { SealKeyRing, SealKeySource } from './seal-keys';
export {
  resolveSealKeys,
  SECRETS_RETIRED_KEYS_ENV,
  sealKeyIds,
  splitRetiredKeys,
} from './seal-keys';
// Beside the ring it is raised for, not in the `exports/secrets` group: same code as
// `SecretsKeyInvalidError`, a different variable to repair.
export { SecretsRingKeyInvalidError } from './secrets-errors';
export {
  defineService,
  installedServices,
  registeredServiceNames,
  resetServices,
  type ServiceFactory,
} from './service';
export type { FlightJoin, Scheduler, SingleFlight, SingleFlightOptions } from './single-flight';
export { singleFlight } from './single-flight';
export { endOfLiteral, maskLiterals, QUOTES, stripComments } from './source-mask';
export type { StoreMode } from './store-mode';
export { STORE_MODES, storeMode } from './store-mode';
export { THEME_STORAGE_KEY } from './theme-storage';
export { timingSafeEqual } from './timing-safe-equal';
export {
  frameworkVersion,
  readPackageVersion,
  resolveVersion,
  VERSION_DEFINE,
} from './version';
// The webhook wire format, at the tier both halves can reach — `@ultimat3/jobs` signs a delivery
// and `@ultimat3/http` verifies one, and neither may import the other. Same argument
// `timing-safe-equal.ts` makes for itself, one line above.
export type {
  WebhookMacInput,
  WebhookSignatureFields,
  WebhookSigningInput,
} from './webhook-signature';
export {
  isCanonicalWebhookField,
  parseWebhookSignatureHeader,
  WEBHOOK_FIELD_MAX,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TOPIC_HEADER,
  webhookHeaders,
  webhookMac,
  webhookSignature,
  webhookSigningString,
} from './webhook-signature';
/**
 * A write's public name — the digest of its idempotency key — and the server scope that carries it
 * from `@ultimat3/action`'s HTTP projection to the layers that stamp it on a `records` frame.
 */
export { isWriteDigest, WRITE_DIGEST_LENGTH, writeDigest } from './write-digest';
export { currentWriteOrigin, WRITE_ORIGIN_WAL_PREFIX, withWriteOrigin } from './write-origin';
