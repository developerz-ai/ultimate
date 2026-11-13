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
  actorFact,
  actorLabel,
  actorOf,
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
export {
  addressNetwork,
  classifyAddress,
  isPublicAddress,
  peerAddressClass,
} from './address-class';
/** Test support: the one name a live suite gives the database it creates (`probe-databases`). */
export { APP_CONFIG_FILE, APP_STATE_DIR, appDirOf, appStatePath } from './app-dir';
export { appVersion, DEFAULT_APP_VERSION } from './app-version';
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
// The installer and its reset are `@ultimat3/core/adapter`'s: the boot is the one caller.
export { AUDIT_RECORD_FIELDS, getAuditSink } from './audit';
export type {
  AwsCredentials,
  AwsPayload,
  PresignAwsUrlInput,
  PresignedAwsUrl,
  SignAwsRequestInput,
  SignedAwsRequest,
} from './aws-sigv4';
export {
  MAX_AWS_PRESIGN_SECONDS,
  presignAwsUrl,
  signAwsRequest,
  UNSIGNED_PAYLOAD,
} from './aws-sigv4';
export type { BackoffCurve, BackoffOptions, JitterMode, Random } from './backoff';
export { backoffDelay, jitterStatedDelay } from './backoff';
export type {
  Breaker,
  BreakerOptions,
  BreakerState,
  BreakerTicket,
  BreakerVerdict,
} from './breaker';
export { breaker, settleWith } from './breaker';
export type { RetryBudget } from './breaker-retry-budget';
export { retryBudgetOf } from './breaker-retry-budget';
export { isCompiledBundle } from './bunfs';
export type { CacheEvictionOptions } from './cache-eviction';
export { evictCacheFiles } from './cache-eviction';
export { CACHE_TIERS, type CacheTierName } from './cache-vocabulary';
export { canonicalJson, fingerprint } from './canonical-json';
export type { FetchLike, TransportRequest } from './client-dispatch';
export { BUILD_ID_HEADER, IDEMPOTENCY_HEADER, REPLAYED_HEADER } from './client-dispatch';
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
export type { ActionPin, ClientPins, PinnedActionMethod } from './client-paths-pins';
export {
  encodeClientPins,
  renderedActionPin,
  renderedQueryPin,
} from './client-paths-pins';
export type { TransportFailure } from './client-problem';
export {
  MAX_REMOTE_TITLE_LENGTH,
  remoteTitleOf,
  withRequestId,
  withStatedDelay,
} from './client-problem';
/** What a decoder reads off a refusal: the stated `Retry-After`, and the body's display title. */
export { MAX_RETRY_AFTER_SECONDS, retryAfterSecondsOf } from './client-retry-after';
/**
 * The browser seam (plan 101): ONE HTTP function, the records envelope it decodes, the per-tab
 * page handle records land in, and the principal fence every client layer subscribes to.
 */
export type { ClientScope } from './client-scope';
export { onRescope, rescope } from './client-scope';
export type { StreamRequest } from './client-stream';
export { clientStream } from './client-stream';
export { clientTransport } from './client-transport';
/** What a typed client puts on the wire. `retryForStatus` is what fills a failure's `retry`. */
export type { WireAnswer } from './client-wire';
export { FRAMEWORK_CODE, problemOf, retryForStatus, traceHeaders } from './client-wire';
export { notifyClientWrite, onClientWrite } from './client-writes';
export {
  type Clock,
  type FrozenClock,
  frozenClock,
  liveClock,
  type SleepClock,
  systemClock,
} from './clock';
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
  ThemeConfig,
  ThemeMode,
} from './config';
export { defineConfig } from './config';
export type { AiConfig, AiConfigInput, McpConfig } from './config-ai';
export type { AssetsConfig, AssetsRetainConfig, AssetsSectionInput } from './config-assets';
export type {
  ClientErrorsConfig,
  ClientErrorsSectionInput,
  ClientVitalsConfig,
  ClientVitalsSurface,
} from './config-client-errors';
export { CLIENT_ERRORS_DEFAULTS, CLIENT_VITALS_DEFAULTS } from './config-client-errors';
export type { FailureCaptureConfig, FailureCaptureSectionInput } from './config-failure-capture';
export { FAILURE_CAPTURE_DEFAULTS } from './config-failure-capture';
export type { DrainConfig, HealthConfig, ReadinessMode } from './config-health';
export { READINESS_MODES } from './config-health';
export type { IslandsConfig, IslandsSectionInput } from './config-islands';
export {
  JOBS_CONCURRENCY_DEFAULT,
  JOBS_DEAD_RETENTION_MS_DEFAULT,
  JOBS_DONE_RETENTION_MS_DEFAULT,
  JOBS_OUTBOX_RETENTION_MS_DEFAULT,
  type JobsConcurrency,
} from './config-jobs';
export type { MailConfig, MailRetainMimeConfig, MailSectionInput } from './config-mail';
export type {
  NavigationConfig,
  NavigationSectionInput,
  NavigationSurface,
  SpeculationConfig,
  SpeculationEagerness,
} from './config-navigation';
export { DEFAULT_SPECULATION, NAVIGATION_SURFACES } from './config-navigation';
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
export { isSameOriginPath, PWA_PUSH_FIX, pushWired } from './config-pwa';
export type {
  SeoConfig,
  SeoConfigInput,
  SeoRobotsConfig,
  SeoRobotsGroup,
  SeoSitemapConfig,
  SiteConfig,
  SiteFavicon,
  SitemapLastmod,
  SiteSectionsInput,
} from './config-site';
export { SITEMAP_LASTMOD_SOURCES } from './config-site';
export type { SitemapSectionConfig } from './config-sitemap';
export {
  SITEMAP_DEFAULT_SECTION,
  SITEMAP_PAGE_SIZE_MAX,
  sectionPatterns,
  sitemapSectionIssues,
} from './config-sitemap';
export type { AppTimeConfig, TimeSectionInput } from './config-time';
export { TIME_DEFAULTS } from './config-time';
export type { ConflictPolicy, ResolveConflictOptions, Row } from './conflict-policy';
export { resolveConflict } from './conflict-policy';
export type {
  CompletionBound,
  Ctx,
  CtxFacts,
  CtxInit,
  CtxPatch,
  CtxServices,
  ServiceBag,
} from './context';
export {
  abandonment,
  ctxOf,
  hasContext,
  runToCompletion,
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
  currentSigningSecret,
  decodeCursor,
  encodeCursor,
  resetCursorSigning,
  usesDevCursorSecret,
} from './cursor';
/** The ONE page shape — `nextCursor` is `null` exactly when `hasMore` is false (25.0.0). */
export type { Page } from './cursor-page';
export { pageOf } from './cursor-page';
export { compareDecimalText } from './decimal-order';
// `errors:` on an action and a query: the rule both share, since the two packages are one tier.
export type { DeclaredErrorsOwner, DeclaredErrorVerdict, ErrorStatusOf } from './declared-errors';
export {
  ActionErrorsInvalidError,
  checkDeclaredErrors,
  describeDeclaredErrors,
  ErrorUndeclaredError,
  enforceDeclared,
  judgeThrown,
  LIFETIME_ERROR_CODES,
  withDeclaredErrors,
} from './declared-errors';
export type { DeclaredResponsesWire } from './declared-errors-openapi';
export { withDeclaredResponses } from './declared-errors-openapi';
export type { SourceReader } from './declared-errors-scan';
export { definedErrorClassCodes, scanHandlerSource } from './declared-errors-scan';
export { DEFAULT_LOCALE, DEFAULT_TIME_ZONE } from './default-locale';
export type { Deprecation, DeprecationField, DeprecationRender } from './deprecation';
export {
  recordDeprecatedCall,
  renderDeprecation,
  successorLink,
  successorPathOf,
} from './deprecation';
export { x509Spki } from './der';
export type { DevSecretsOptions } from './dev-secrets';
export {
  assertNoDevSecretsOutsideLocal,
  CursorSecretDevError,
  devSecretsRefused,
} from './dev-secrets';
export {
  DRAIN_DEADLINE_DEFAULT_MS,
  WORKER_DRAIN_DEADLINE_MAX_MS,
  WORKER_RETIRE_DEFAULT_MS,
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
} from './env';
export { checkEnv, defineEnv, maskedEnvValues } from './env';
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
export type { DrawnBinding } from './exercise-hint';
// The `input:` every exercise fix pastes, owed fields named: one renderer for action, query and testing.
export { renderDrawnInput, renderExerciseKey, sampleGapBinding } from './exercise-hint';
// A contract exercise's one loop: `@ultimat3/action`'s and `@ultimat3/query`'s, one tier apart from neither.
export type {
  DrawnInput,
  ExerciseAttempt,
  ExerciseReport,
  ExerciseSubject,
  ExerciseVerdict,
} from './exercise-run';
export {
  assertExerciseScoped,
  bindDrawn,
  EXERCISE_RUNS,
  EXERCISE_RUNS_MAX,
  exerciseDefect,
  exerciseReplay,
  runExercise,
  sealedHost,
} from './exercise-run';
export type {
  CodedErrorInit,
  CoreErrorCode,
  DefinedError,
  DefinedErrorExtra,
  DefineErrorSpec,
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
  boundedCause,
  CORE_ERROR_CODES,
  ConfigInvalidError,
  classifyThrown,
  DEFAULT_ERROR_RETRY,
  declaredErrorRetry,
  defineError,
  deniedCallerFix,
  describeErrorCode,
  describeValue,
  EnvMissingError,
  ERROR_DOCS_URL,
  ERROR_RETRY_KINDS,
  errorCodeSnapshot,
  errorRetry,
  failureStack,
  fixFor,
  hasErrorCode,
  InternalError,
  isFixShellSafe,
  isThrownError,
  isUltimateError,
  listErrorCodes,
  MAX_CAUSE_LENGTH,
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
  ActionInvokeEvent,
  AiLlmEvent,
  AttributeValue,
  CacheInvalidateEvent,
  CacheLookupEvent,
  CacheTierFailureEvent,
  CapturedValue,
  Counter,
  DbStatementEvent,
  EntityBulkEvent,
  EntityCrossTenantEvent,
  EntityRowEvent,
  EntityRowOp,
  ErrorReport,
  ErrorReporter,
  ErrorReportingOptions,
  ErrorScope,
  ErrorSeverity,
  ErrorSource,
  FailureBundle,
  FailureFact,
  FailurePrimitive,
  FailureRead,
  FailureStore,
  Gauge,
  GaugeOptions,
  Histogram,
  HistogramOptions,
  HistogramPoint,
  HttpRequestEvent,
  InstrumentEvent,
  InstrumentEventMap,
  InstrumentEventSpec,
  InstrumentHandler,
  InstrumentName,
  InstrumentOptions,
  InstrumentPattern,
  InstrumentSpan,
  JobEnqueueEvent,
  JobPerformEvent,
  LogFields,
  Logger,
  LoggerOptions,
  LogLevel,
  MailDeliverEvent,
  MatchedName,
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
  OtlpLogExporter,
  OtlpLogExporterOptions,
  OtlpMetricExporter,
  OtlpMetricExporterOptions,
  OtlpSignal,
  OtlpSpanExporter,
  OtlpSpanExporterOptions,
  PolicyDecisionEvent,
  QueryReadEvent,
  ReadableMetric,
  ReadableSpan,
  RenderHoleEvent,
  RenderPageEvent,
  ReportErrorOptions,
  RequestSample,
  Sampler,
  SentryDsn,
  SentryEnvelopeOptions,
  SentryEvent,
  SentryReporterHooks,
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
  StatementAttribution,
  StorageEvent,
  TelemetryOptions,
  TimedEvent,
} from './exports/observability';
export {
  alwaysOffSampler,
  alwaysOnSampler,
  callerStack,
  captureStatementStacks,
  captureValue,
  chainErrorReporters,
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
  ERROR_SOURCES,
  ErrorReporterDsnInvalidError,
  errorFingerprint,
  errorReport,
  errorReportersOf,
  exportMetrics,
  failureCaptureActive,
  gauge,
  histogram,
  INSTRUMENT_EVENTS,
  installedErrorReporter,
  installedFailureStore,
  instrument,
  isLocalErrorSink,
  isRedactedKey,
  isSentryErrorReporter,
  jobs,
  LOG_LEVELS,
  leasesLost,
  localErrorSink,
  logger,
  MAX_SPAN_EVENTS,
  METRICS_CONTENT_TYPE,
  METRICS_PATH,
  MetricCardinalityError,
  MetricNameInvalidError,
  MetricValueInvalidError,
  memoryErrorReporter,
  memoryExporter,
  memoryMetricExporter,
  metricsText,
  monitorFingerprint,
  noopErrorReporter,
  OTLP_RETRY_STATUSES,
  OtlpEndpointInvalidError,
  OtlpHeadersInvalidError,
  OtlpProtocolUnsupportedError,
  otlpEndpointLabel,
  otlpHeaders,
  otlpLogExporter,
  otlpMetricExporter,
  otlpMetricsRequest,
  otlpSpanExporter,
  otlpTraceRequest,
  parentBasedRatioSampler,
  parseSentryDsn,
  parseTraceparent,
  queueDepth,
  REDACTED,
  recordConnection,
  recordFailureFact,
  recordFailureInput,
  recordJob,
  recordLeaseLost,
  recordQueueDepth,
  recordRequest,
  redactKeys,
  reportError,
  requestDuration,
  requests,
  resetErrorReporting,
  resetInstrumentation,
  resetMetrics,
  resetStatementStacks,
  resetTelemetry,
  SCALING_METRICS,
  SEMCONV,
  SEMCONV_METRICS,
  SEMCONV_VALUES,
  sentryEnvelope,
  sentryErrorReporter,
  sentryEvent,
  sentryTransport,
  setLoggerContextFields,
  setLogStream,
  settleFailureCaptures,
  startMetricExport,
  startSpan,
  structuredLogger,
  subscribe,
  subscribed,
  subscriberCount,
  subscriberFailures,
  subscribeSemconvMetrics,
  traceparent,
  tryOtlpEndpoint,
  withFailureCapture,
  withSpan,
} from './exports/observability';
export type {
  MasterKeyRef,
  Secret,
  SecretSummary,
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
  SECRETS_FILE,
  SECRETS_KEY_ENV,
  SECRETS_KEY_FILE,
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
  serializeSecretValues,
  stagedMasterKeyPath,
  stageMasterKeyFile,
  writeMasterKeyFile,
  writeSecretsFile,
} from './exports/secrets';
export type { FilledWire } from './fill-wire';
export { fillWire } from './fill-wire';
export { finiteCount, finiteOption, MAX_TIMER_MS } from './finite-option';
export type {
  FlightGate,
  FlightGateLimits,
  FlightGateOptions,
  FlightGateState,
} from './flight-gate';
export { flightGate, gateOverloaded } from './flight-gate';
export { fnv1a } from './fnv1a';
export { formatBytes } from './format-bytes';
// Every environment name the framework reads, and its owner: what `x doctor` judges an app's against.
export type { FrameworkEnvName, FrameworkEnvUse } from './framework-env';
export { FRAMEWORK_ENV, frameworkEnvEntry } from './framework-env';
export type { GateRateLimit, RateLimitSubject } from './gate-shapes';
export {
  AUDIT_SINK_FAILED_EVENT,
  auditFailureOf,
  auditOutcomeOf,
  fixedRateLimitOf,
  rateLimitScopeOf,
  rateLimitSpendsOn,
  rateLimitSubjectOf,
  resolvedRateLimitOf,
} from './gate-shapes';
export type { GenerationFence } from './generation-fence';
export { generationFence, isSuperseded } from './generation-fence';
export type { PublicHealthBody } from './health-disclosure';
export { DEFAULT_HEALTH_DETAIL_PEERS, healthBody, healthPeerListed } from './health-disclosure';
export type { HmacAlgorithm, HmacEncoding, HmacInput } from './hmac';
// The ONE keyed hash: every HMAC in the framework (`bun run keyed-hasher`).
export { hmac } from './hmac';
export type { HostDecision, HostRule } from './host-rules';
export { ANY_HOST, hostDecision, hostMatches } from './host-rules';
export { escapeHtml } from './html-escape';
export type { Brand, Id } from './ids';
export {
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
export {
  ImageDecodeFailedError,
  ImageRasterBudgetError,
  ImageTooLargeError,
  ImageUnsupportedError,
  imageDecodeFailed,
  imageUnsupported,
} from './image/errors';
export type { DecodableFormat, EncodableFormat, ImageTransformSpec } from './image/pipeline';
export {
  assertFiniteImageQuality,
  blurDataUrl,
  canDecode,
  canEncode,
  DECODABLE_FORMATS,
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
export { RASTER_SYNC_PIXELS } from './image/raster-pool';
export type { RasterWorkerBundle } from './image/raster-worker-bundle';
export { RASTER_WORKER_DEFINE, rasterWorkerBundle } from './image/raster-worker-bundle';
export { impersonate, isImpersonating } from './impersonate';
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
export { jsonbRefusal } from './json-storable';
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
  DRAIN_TIMEOUT_EXIT_CODE,
  drain,
  drainDeadlineMs,
  drainExitCode,
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
  shutdownHookCount,
} from './lifecycle';
export { defaultReadinessGraceMs, READINESS_GRACE_DEFAULT_MS } from './lifecycle-grace';
export type {
  ReadinessCheck,
  ReadinessCheckOptions,
  ReadinessStatus,
} from './lifecycle-readiness';
export type { SignalHandlerOptions } from './lifecycle-signals';
export { drainSignals, installSignalHandlers } from './lifecycle-signals';
export { isSelfOrigin, markListening, resetListeners } from './listeners';
export type { Direction } from './locale-direction';
export { directionOf, isRtl } from './locale-direction';
export type { LocalePathSplit } from './locale-path';
export { localeSegment, localizePath, splitLocalePath } from './locale-path';
// The process logger's test seam, beside nothing it groups with: where a default-writer line goes.
export type { LogSink } from './logger';
export { installLogSink, teeLogLines } from './logger';
export type { MapBoundedOptions } from './map-bounded';
export { mapBounded } from './map-bounded';
export {
  isAgentOffered,
  isMcpExposed,
  type McpAnnotationHints,
  type McpEffect,
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
// An outage said on failures 1, 2, 4, 8, … and once when it ends.
export type { OutageLog, OutageLogOptions } from './outage-log';
export { isOutageMilestone, outageLog } from './outage-log';
/** The message pwa's `sw.js` posts and realtime's outbox listens for. */
export { OUTBOX_DRAIN_MESSAGE } from './outbox-drain';
/** The `<meta name>`s render writes and the page client, realtime and pwa read. */
export {
  APP_UPDATE_MESSAGE,
  CLIENT_BUILD_META,
  CLIENT_NAVIGATION_HEADER,
  CLIENT_NAVIGATION_LOCATION_HEADER,
  CLIENT_NAVIGATION_SCOPE_HEADER,
  CLIENT_NAVIGATION_SURFACE_HEADER,
  CLIENT_OUTBOX_MAX_META,
  CLIENT_PATH_STYLE_META,
  CLIENT_PERSIST_META,
  CLIENT_PINS_META,
  CLIENT_SCOPE_HEADER,
  CLIENT_SCOPE_META,
  CLIENT_SYNC_META,
  CLIENT_SYNC_WORKER_META,
} from './page-meta';
/** The structural Postgres seam http, auth, action and jobs share without a `@ultimat3/db` edge. */
export type { PgExecutor } from './pg-executor';
export type { ProbeDatabaseEntropy } from './probe-database';
export { probeDatabaseName } from './probe-database';
export type { ProbeDatabaseSweepOptions } from './probe-database-sweep';
export { sweepProbeDatabases, sweepStaleProbeDatabases } from './probe-database-sweep';
export type { ProcessMetricsOptions, ProcessReading } from './process-metrics';
export { startProcessMetrics } from './process-metrics';
export { hasPublicCause, registerPublicCause, resetPublicCauses } from './public-cause';
export type { CappedBody } from './read-capped';
export { readWithinLimit } from './read-capped';
export type { RecordEnvelope, RecordRows } from './record-envelope';
export { decodeRecordEnvelope, encodeRecordEnvelope, RECORDS_HEADER } from './record-envelope';
export { RECORDS_OPENAPI_HEADER, recordEnvelopeSchema } from './record-envelope-openapi';
export type { PageClient, RecordSink } from './record-sink';
export { pageClient } from './record-sink';
export type {
  AdapterPort,
  AdapterPortName,
  ModuleRegistrar,
  PrimitiveFactory,
  PrimitiveKind,
  RegisteredPrimitive,
} from './registrar';
export {
  ADAPTER_PORT_NAMES,
  ADAPTER_PORTS,
  hasPrimitiveRegistrar,
  PRIMITIVE_FACTORIES,
  PRIMITIVE_KINDS,
  primitiveRegistrar,
  registerPrimitiveRegistrar,
  resetPrimitiveRegistrars,
} from './registrar';
export { REQUEST_TIMEOUT_HEADER, remainingBudgetMs } from './request-budget';
export type { RetryDeps } from './retry';
export { retry } from './retry';
export type { RetryDecision, RetryPolicy, RetryStopReason } from './retry-loop';
export { retryDecision } from './retry-loop';
export { isRetryableStatus, RETRYABLE_STATUSES } from './retryable-status';
export type { ResolveRoleOptions, Role, RoleInfo, ScalingSignal } from './roles';
export { isRole, ROLE_INFO, ROLES, resolveRole } from './roles';
export { HttpPathInputConflictError, mergePathParams } from './route-path-merge';
export type { FilledTemplate, TemplateKeyNode } from './route-path-template';
export {
  fillTemplate,
  pathTemplateProblem,
  templateKeyProblem,
  templateParams,
  toOpenApiPath,
} from './route-path-template';
export { routeRank } from './route-rank';
export type { HydrateStrategy, OfflineStrategy, RenderMode, Surface } from './route-vocabulary';
export { HYDRATE_STRATEGIES, OFFLINE_STRATEGIES, RENDER_MODES, SURFACES } from './route-vocabulary';
export { safeUrl, URL_ATTRIBUTES } from './safe-url';
export type { OriginEvidence } from './same-origin';
export { type OriginVerdict, proveSameOrigin } from './same-origin';
export type { SealOptions, SealPurposeOptions } from './seal';
export { isSealed, open, openText, seal, sealAll, sealedKeyId } from './seal';
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
export { onSessionLost, sessionIsLost } from './session-lost';
export type { FlightJoin, Scheduler, SingleFlight, SingleFlightOptions } from './single-flight';
export { singleFlight } from './single-flight';
export { ambientClock, noWaitClock } from './sleep-clock';
export { endOfLiteral, maskLiterals, QUOTES, stripComments } from './source-mask';
export type { StoreMode } from './store-mode';
export { storeMode } from './store-mode';
export { THEME_STORAGE_KEY } from './theme-storage';
export { timingSafeEqual } from './timing-safe-equal';
export type { ToolDescriptionSource } from './tool-description';
// A projected tool's description: `@ultimat3/mcp`'s and `@ultimat3/ai`'s, one tier apart from neither.
export { toolDescription } from './tool-description';
export {
  frameworkVersion,
  readPackageVersion,
  resolveVersion,
  VERSION_DEFINE,
} from './version';
export type { VisibleIntervalOptions } from './visible-interval';
export { visibleInterval } from './visible-interval';
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
export { DATES_HEADER, reviveWireDates, wireDatePaths } from './wire-dates';
/**
 * A write's public name — the digest of its idempotency key — and the server scope that carries it
 * from `@ultimat3/action`'s HTTP projection to the layers that stamp it on a `records` frame.
 */
export { isWriteDigest, WRITE_DIGEST_LENGTH, writeDigest } from './write-digest';
export { currentWriteOrigin, WRITE_ORIGIN_WAL_PREFIX, withWriteOrigin } from './write-origin';
