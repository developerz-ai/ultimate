// Single responsibility: the public API of @ultimat3/core. Explicit named exports only —
// every other package imports from here, so this list is the tier-0 contract.

export type {
  Actor,
  ActorFactKey,
  ActorFactMap,
  ActorFacts,
  ActorInit,
  ActorKind,
} from './actor';
export {
  ACTOR_KINDS,
  actorFact,
  actorLabel,
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
export type { InvariantOptions } from './assert';
export { assert, assertNever, invariant } from './assert';
export type { Clock, FrozenClock } from './clock';
export { frozenClock, systemClock } from './clock';
export type {
  AiConfig,
  AiConfigInput,
  AppConfig,
  AppConfigInput,
  AppConfigOverlay,
  AuthConfig,
  CacheConfig,
  CacheTier,
  DatabaseConfig,
  JobsConfig,
  JobsDriver,
  McpConfig,
  OfflineStrategy,
  PwaConfig,
  RealtimeConfig,
  RealtimeTier,
  RealtimeTransport,
  ThemeConfig,
  ThemeMode,
} from './config';
export { defineConfig } from './config';
export type { Ctx, CtxInit, CtxPatch, CtxServices, ServiceBag } from './context';
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
  usesDevCursorSecret,
} from './cursor';
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
} from './environment';
export type {
  CoreErrorCode,
  ErrorCodeDeclaration,
  ErrorCodeDescriptor,
  ErrorCodeEntry,
} from './error-codes';
export {
  CORE_ERROR_CODES,
  describeErrorCode,
  ERROR_DOCS_BASE,
  errorCodeSnapshot,
  errorDocsUrl,
  hasErrorCode,
  listErrorCodes,
  registerErrorCodes,
  resetErrorCodes,
} from './error-codes';
export type {
  ErrorReport,
  ErrorReporter,
  ErrorReportingOptions,
  ErrorScope,
  ErrorSeverity,
  ErrorSource,
  MemoryErrorReporter,
  ReportErrorOptions,
} from './error-reporter';
export {
  configureErrorReporting,
  ERROR_SOURCES,
  errorReport,
  memoryErrorReporter,
  noopErrorReporter,
  reportError,
  resetErrorReporting,
} from './error-reporter';
export type {
  SentryDsn,
  SentryEnvelopeOptions,
  SentryReporterOptions,
} from './error-reporter-sentry';
export {
  ErrorReporterDsnInvalidError,
  parseSentryDsn,
  sentryEnvelope,
  sentryErrorReporter,
} from './error-reporter-sentry';
export type {
  CodedErrorInit,
  FormatErrorOptions,
  UltimateErrorInit,
  UltimateErrorJSON,
} from './errors';
export {
  ConfigInvalidError,
  EnvMissingError,
  formatError,
  InternalError,
  isUltimateError,
  NotImplementedError,
  notImplemented,
  toUltimateError,
  ULTIMATE_ERROR_BRAND,
  UltimateError,
} from './errors';
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
  uuid,
  uuidTimestamp,
} from './ids';
export { parseColor } from './image/color';
export {
  ImageDecodeFailedError,
  ImageTooLargeError,
  ImageUnsupportedError,
  imageDecodeFailed,
  imageTooLarge,
  imageUnsupported,
} from './image/errors';
export { decodeJpeg } from './image/jpeg-decode';
export { encodeJpeg } from './image/jpeg-encode';
export { DEFAULT_JPEG_QUALITY } from './image/jpeg-tables';
export type {
  DecodableFormat,
  EncodableFormat,
  ImageTransformSpec,
} from './image/pipeline';
export {
  BLUR_PLACEHOLDER_WIDTH,
  blurDataUrl,
  canDecode,
  canEncode,
  DECODABLE_FORMATS,
  dataUrl,
  decodeImage,
  defaultFormatFor,
  ENCODABLE_FORMATS,
  encodeImage,
  transformImageBytes,
} from './image/pipeline';
export { decodePng, encodePng } from './image/png';
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
export type { ImageFit, ResizeSpec } from './image/resize';
export { fitBox, resizeRaster, scaledToFit } from './image/resize';
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
  SignalHandlerOptions,
} from './lifecycle';
export {
  beginWork,
  configureLifecycle,
  drain,
  healthReport,
  healthzPayload,
  idleWaiterCount,
  inflightCount,
  installSignalHandlers,
  isDraining,
  lifecycleState,
  markReady,
  onShutdown,
  readyzPayload,
  resetLifecycle,
  SHUTDOWN_PHASES,
  shutdownHookCount,
} from './lifecycle';
export {
  isSelfOrigin,
  listeningOrigins,
  markListening,
  resetListeners,
} from './listeners';
export type { LogFields, Logger, LoggerOptions, LogLevel } from './logger';
export {
  createLogger,
  isRedactedKey,
  LOG_LEVELS,
  logger,
  REDACTED,
  redactKeys,
  setLoggerContextFields,
} from './logger';
export type { McpExposureDeclaration } from './mcp-exposure';
export { isMcpExposed } from './mcp-exposure';
export type {
  Counter,
  Gauge,
  GaugeOptions,
  Histogram,
  HistogramOptions,
  HistogramPoint,
  InstrumentOptions,
  MemoryMetricExporter,
  MetricAttributes,
  MetricAttributeValue,
  MetricCollection,
  MetricDescriptor,
  MetricExporter,
  MetricKind,
  MetricPoint,
  MetricsOptions,
  ReadableMetric,
} from './metrics';
export {
  collectMetrics,
  configureMetrics,
  counter,
  DEFAULT_HISTOGRAM_BOUNDS,
  exportMetrics,
  gauge,
  histogram,
  MetricNameInvalidError,
  MetricValueInvalidError,
  memoryMetricExporter,
  noopMetricExporter,
  resetMetrics,
  startMetricExport,
} from './metrics';
export { METRICS_CONTENT_TYPE, METRICS_PATH, metricsText } from './metrics-text';
export type { ModuleRegistrar, PrimitiveKind, RegisteredPrimitive } from './registrar';
export {
  hasPrimitiveRegistrar,
  PRIMITIVE_KINDS,
  primitiveRegistrar,
  registerPrimitiveRegistrar,
  resetPrimitiveRegistrars,
} from './registrar';
export type { Err, Ok, Result } from './result';
export { err, isErr, isOk, map, mapErr, ok, tryCatch, unwrap, unwrapOr } from './result';
export type { ResolveRoleOptions, Role, RoleInfo, ScalingSignal } from './roles';
export { DEFAULT_ROLE, isRole, ROLE_INFO, ROLES, resolveRole } from './roles';
export type { RequestSample } from './runtime-metrics';
export {
  connections,
  jobs,
  leasesLost,
  queueDepth,
  recordConnection,
  recordJob,
  recordLeaseLost,
  recordQueueDepth,
  recordRequest,
  requestDuration,
  requests,
  SCALING_METRICS,
} from './runtime-metrics';
export { SCHEMA_ERROR_CODE_TITLES } from './schema-error-codes';
export type { Secret } from './secret';
export {
  isSecret,
  revealOptionalSecret,
  revealSecret,
  SECRET_BRAND,
  secret,
} from './secret';
export type {
  SecretSummary,
  SecretsEnvelope,
  SecretsLocation,
  SecretValues,
} from './secrets';
export {
  assertSecretValues,
  describeSecrets,
  generateMasterKey,
  masterKeyId,
  openSecrets,
  parseMasterKey,
  parseSecretsEnvelope,
  SECRET_NAME,
  SECRETS_ALG,
  SECRETS_IV_BYTES,
  SECRETS_KEY_BYTES,
  SECRETS_KEY_HEX_LENGTH,
  SECRETS_KEY_ID_LENGTH,
  SECRETS_TAG_BYTES,
  SECRETS_VERSION,
  sealSecrets,
  serializeSecretValues,
} from './secrets';
export type { SecretsErrorCode } from './secrets-errors';
export {
  SECRETS_ERROR_CODES,
  SecretsFileInvalidError,
  SecretsFileMissingError,
  SecretsKeyInvalidError,
  SecretsKeyMismatchError,
  SecretsKeyMissingError,
  SecretsPlaintextInvalidError,
  SecretsTamperedError,
} from './secrets-errors';
export type {
  MasterKeyRef,
  MasterKeySource,
  SecretsInstallOptions,
  SecretsInstallReport,
} from './secrets-store';
export {
  findMasterKey,
  installSecrets,
  masterKeyIdOf,
  masterKeyPath,
  readSecretsFile,
  requireMasterKey,
  SECRETS_FILE,
  SECRETS_KEY_ENV,
  SECRETS_KEY_FILE,
  SECRETS_KEY_MODE,
  secretsFileExists,
  secretsPath,
  writeMasterKeyFile,
  writeSecretsFile,
} from './secrets-store';
export type { ServiceFactory } from './service';
export { defineService, resetServices } from './service';
export type {
  AttributeValue,
  MemoryExporter,
  ReadableSpan,
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
} from './telemetry';
export {
  configureTelemetry,
  currentSpan,
  currentSpanContext,
  memoryExporter,
  noopExporter,
  parseTraceparent,
  resetTelemetry,
  serviceResource,
  startSpan,
  traceparent,
  withSpan,
  withSpanContext,
} from './telemetry';
export { timingSafeEqual } from './timing-safe-equal';
export {
  frameworkVersion,
  readPackageVersion,
  resolveVersion,
  VERSION_DEFINE,
  VERSION_MANIFEST,
} from './version';
