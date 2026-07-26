// Single responsibility: the public API of @ultimat3/core. Explicit named exports only —
// every other package imports from here, so this list is the tier-0 contract.

export type { Actor, ActorInit, ActorKind } from './actor';
export {
  ACTOR_KINDS,
  actorLabel,
  agentActor,
  anonymousActor,
  hasRole,
  hasScope,
  isActorKind,
  isAnonymous,
  serviceActor,
  userActor,
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
export { checkEnv, defineEnv, describeEnv } from './env';
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
  errorDocsUrl,
  hasErrorCode,
  listErrorCodes,
  registerErrorCodes,
  resetErrorCodes,
} from './error-codes';
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
  inflightCount,
  installSignalHandlers,
  isDraining,
  lifecycleState,
  markReady,
  onShutdown,
  readyzPayload,
  resetLifecycle,
  SHUTDOWN_PHASES,
} from './lifecycle';
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
export type { Err, Ok, Result } from './result';
export { err, isErr, isOk, map, mapErr, ok, tryCatch, unwrap, unwrapOr } from './result';
export type { ResolveRoleOptions, Role, RoleInfo, ScalingSignal } from './roles';
export { DEFAULT_ROLE, isRole, ROLE_INFO, ROLES, resolveRole } from './roles';
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
  startSpan,
  traceparent,
  withSpan,
  withSpanContext,
} from './telemetry';
