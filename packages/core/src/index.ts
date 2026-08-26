// Single responsibility: the public API of @ultimat3/core. Explicit named exports only —
// every other package imports from here, so this list is the tier-0 contract.
//
// Three slices arrive through a barrel in `exports/` — observability, the error contract and
// secrets — because each is one subject spread over a dozen modules. Every name they carry is
// still written out below: `export *` would make the contract something a reader has to resolve.

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
  actorOrigin,
  agentActor,
  anonymousActor,
  hasRole,
  hasScope,
  isActorKind,
  isAnonymous,
  serviceActor,
  userActor,
  withFacts,
} from './actor';
export { APP_VERSION_KEY, appVersion, DEFAULT_APP_VERSION } from './app-version';
export { assert, assertNever, type InvariantOptions, invariant } from './assert';
export { type AsyncContext, asyncContext } from './async-context';
export type { BackoffCurve, BackoffOptions, JitterMode, Random } from './backoff';
export { backoffDelay } from './backoff';
export { CACHE_TIERS, type CacheTierName } from './cache-vocabulary';
export { canonicalJson, fingerprint } from './canonical-json';
/**
 * Flight control for a typed client, and OPT-IN by construction: `@ultimat3/action`'s and
 * `@ultimat3/query`'s `client.ts` each name `ClientFlight` as a TYPE only, so a caller that never
 * mentions `createClientFlight` pays nothing for the fence, the dedup map or the retry loop.
 * Both packages re-export these names unchanged; this is the one copy.
 */
export type {
  ClientFlight,
  ClientFlightOptions,
  ClientRetry,
  FlightKeyOptions,
  FlightPlan,
} from './client-flight';
export { createClientFlight, DEFAULT_CLIENT_RETRY, isTransientFailure } from './client-flight';
/** What a typed client puts on the wire. `retryForStatus` is what fills a failure's `retry`. */
export type { WireAnswer } from './client-wire';
export { FRAMEWORK_CODE, problemOf, retryForStatus, traceHeaders } from './client-wire';
export { type Clock, type FrozenClock, frozenClock, systemClock } from './clock';
export type {
  AiConfig,
  AiConfigInput,
  AppConfig,
  AppConfigInput,
  AppConfigOverlay,
  AuthConfig,
  CacheConfig,
  DatabaseConfig,
  JobsConfig,
  McpConfig,
  PwaConfig,
  RealtimeConfig,
  RealtimeTransport,
  ThemeConfig,
  ThemeMode,
} from './config';
export { defineConfig } from './config';
export type { Ctx, CtxFacts, CtxInit, CtxPatch, CtxServices, ServiceBag } from './context';
export {
  createContext,
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
export type { CursorPayload } from './cursor';
export {
  CursorInvalidError,
  configureCursorSigning,
  decodeCursor,
  encodeCursor,
  resetCursorSigning,
  usesDevCursorSecret,
} from './cursor';
export { compareDecimalText } from './decimal-order';
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
  assertEnvExample,
  checkEnvExample,
  ENV_EXAMPLE_PATH,
  EnvExampleDriftError,
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
  describeErrorCode,
  describeValue,
  EnvMissingError,
  ERROR_DOCS_URL,
  ERROR_RETRY_KINDS,
  errorCodeSnapshot,
  errorRetry,
  formatError,
  hasErrorCode,
  InternalError,
  isErrorRetry,
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
  renderThrowable,
  resetErrorCodes,
  resetErrorRetry,
  retryFor,
  SCHEMA_ERROR_CODE_TITLES,
  singleLine,
  statedDelayMs,
  stringField,
  toUltimateError,
  ULTIMATE_ERROR_BRAND,
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
  createLogger,
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
  OTEL_SAMPLER_ARG_KEY,
  OTEL_SAMPLER_KEY,
  OTLP_ENDPOINT_KEY,
  OTLP_HEADERS_KEY,
  OTLP_PROTOCOL_KEY,
  OTLP_SCOPE,
  OtlpEndpointInvalidError,
  OtlpHeadersInvalidError,
  OtlpProtocolUnsupportedError,
  OVERFLOW_ATTRIBUTE,
  otlpAttributes,
  otlpEndpoint,
  otlpHeaders,
  otlpMetricExporter,
  otlpMetricsRequest,
  otlpResource,
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
  resetDefaultSampler,
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
  traceparent,
  tryOtlpEndpoint,
  unixNano,
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
  parseSecretsEnvelope,
  readSecretsFile,
  requireMasterKey,
  revealOptionalSecret,
  revealSecret,
  SECRET_BRAND,
  SECRET_NAME,
  SECRETS_ALG,
  SECRETS_ERROR_CODES,
  SECRETS_FILE,
  SECRETS_IV_BYTES,
  SECRETS_KEY_BYTES,
  SECRETS_KEY_ENV,
  SECRETS_KEY_FILE,
  SECRETS_KEY_HEX_LENGTH,
  SECRETS_KEY_ID_LENGTH,
  SECRETS_KEY_MODE,
  SECRETS_TAG_BYTES,
  SECRETS_VERSION,
  SecretsFileInvalidError,
  SecretsFileMissingError,
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
export { createFlightGate, gateOverloaded } from './flight-gate';
export { formatBytes } from './format-bytes';
export type { GenerationFence } from './generation-fence';
export { createFence, isSuperseded } from './generation-fence';
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
  uuid,
  uuidTimestamp,
} from './ids';
export { fitBox, type ImageFit, type ResizeSpec, scaledToFit } from './image/canvas';
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
  assertPixelBudget,
  createRaster,
  hasAlpha,
  MAX_IMAGE_PIXELS,
  rasterFrom,
} from './image/raster';
export { impersonate, impersonationReason, isImpersonating } from './impersonate';
export {
  assertLocale,
  cachedFormatter,
  canonicalLocale,
  localeInvalid,
  MAX_CACHED_FORMATTERS,
} from './intl-cache';
export { isJsonObject } from './json-object';
export type {
  HealthPayload,
  HealthReport,
  HealthState,
  LifecycleOptions,
  OnShutdownOptions,
  ProcessSignal,
  ReadinessCheck,
  ReadinessStatus,
  ShutdownHook,
  ShutdownPhase,
  ShutdownReason,
  SignalHandlerOptions,
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
  installSignalHandlers,
  isDraining,
  lifecycleState,
  markReady,
  onShutdown,
  readinessCheckCount,
  readinessChecks,
  readyzPayload,
  registerReadinessCheck,
  resetLifecycle,
  SHUTDOWN_PHASES,
  shutdownHookCount,
} from './lifecycle';
export { isSelfOrigin, listeningOrigins, markListening, resetListeners } from './listeners';
export { isMcpExposed, type McpExposureDeclaration } from './mcp-exposure';
export { nearestName } from './nearest-name';
export { type CappedBody, readWithinLimit } from './read-capped';
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
export type { Err, Ok, Result } from './result';
export { err, isErr, isOk, map, mapErr, ok, tryCatch, unwrap, unwrapOr } from './result';
export type { RetryDecision, RetryDeps, RetryPolicy, RetryStopReason } from './retry';
export { retry, retryDecision } from './retry';
export { isRetryableStatus, RETRYABLE_STATUSES } from './retryable-status';
export type { ResolveRoleOptions, Role, RoleInfo, ScalingSignal } from './roles';
export { DEFAULT_ROLE, isRole, ROLE_INFO, ROLES, resolveRole } from './roles';
export type { HydrateStrategy, OfflineStrategy, RenderMode } from './route-vocabulary';
export { HYDRATE_STRATEGIES, OFFLINE_STRATEGIES, RENDER_MODES } from './route-vocabulary';
export { safeUrl, URL_ATTRIBUTES } from './safe-url';
export { defineService, resetServices, type ServiceFactory } from './service';
export type { FlightJoin, Scheduler, SingleFlight, SingleFlightOptions } from './single-flight';
export { createSingleFlight } from './single-flight';
export { timingSafeEqual } from './timing-safe-equal';
export {
  frameworkVersion,
  readPackageVersion,
  resolveVersion,
  VERSION_DEFINE,
  VERSION_MANIFEST,
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
