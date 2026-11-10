// The observability slice of `@ultimat3/core`'s public surface, in one place: logging, metrics,
// tracing, sampling, the OTLP transports and error reporting. One group because they are one
// subject — a process's own account of what it did — and `index.ts` re-exports every name below
// explicitly, so this file changes what a reader looks at and never what the package exports.

export { errorFingerprint } from '../error-fingerprint';
export type {
  ErrorReport,
  ErrorReporter,
  ErrorReportingOptions,
  ErrorScope,
  ErrorSeverity,
  ErrorSource,
  MemoryErrorReporter,
  ReportErrorOptions,
} from '../error-reporter';
export {
  configureErrorReporting,
  ERROR_SOURCES,
  errorReport,
  installedErrorReporter,
  memoryErrorReporter,
  noopErrorReporter,
  reportError,
  resetErrorReporting,
} from '../error-reporter';
export { chainErrorReporters, errorReportersOf } from '../error-reporter-chain';
export type {
  SentryDsn,
  SentryEnvelopeOptions,
  SentryReporterOptions,
} from '../error-reporter-sentry';
export {
  ErrorReporterDsnInvalidError,
  isLocalErrorSink,
  isSentryErrorReporter,
  localErrorSink,
  parseSentryDsn,
  sentryEnvelope,
  sentryErrorReporter,
  sentryEvent,
  sentryTransport,
} from '../error-reporter-sentry';
export type { SentryEvent, SentryReporterHooks } from '../error-reporter-sentry-hooks';
export type {
  FailureActor,
  FailureBundle,
  FailureCaptureLimits,
  FailureFact,
  FailurePrimitive,
  FailureRead,
  FailureStore,
  HeldFailure,
} from '../failure-capture';
export {
  failureCaptureActive,
  failureCaptureLimits,
  installedFailureStore,
  recordFailureFact,
  recordFailureInput,
  withFailureCapture,
} from '../failure-capture';
export { resetFailureCaptureWindows, settleFailureCaptures } from '../failure-capture-flush';
export type { CapturedValue } from '../failure-capture-mask';
export { captureValue } from '../failure-capture-mask';
export type {
  InstrumentEvent,
  InstrumentHandler,
  InstrumentName,
  InstrumentPattern,
  MatchedName,
} from '../instrument';
export {
  instrument,
  resetInstrumentation,
  subscribe,
  subscribed,
  subscriberCount,
  subscriberFailures,
} from '../instrument';
export type {
  ActionInvokeEvent,
  AiLlmEvent,
  CacheInvalidateEvent,
  CacheLookupEvent,
  CacheTierFailureEvent,
  DbStatementEvent,
  EntityBulkEvent,
  EntityCrossTenantEvent,
  EntityRowEvent,
  EntityRowOp,
  FrameworkEventMap,
  FrameworkEventName,
  HttpRequestEvent,
  InstrumentEventMap,
  InstrumentEventSpec,
  InstrumentSpan,
  JobEnqueueEvent,
  JobPerformEvent,
  LogRecordEvent,
  MailDeliverEvent,
  OutboundRequestEvent,
  PolicyDecisionEvent,
  QueryReadEvent,
  RenderHoleEvent,
  RenderIsrRegenerateEvent,
  RenderPageEvent,
  StatementAttribution,
  StorageEvent,
  TimedEvent,
} from '../instrument-events';
export { INSTRUMENT_EVENTS } from '../instrument-events';
export { SEMCONV, SEMCONV_METRICS, SEMCONV_VALUES } from '../instrument-semconv';
export {
  callerStack,
  captureStatementStacks,
  resetStatementStacks,
  statementStacksCaptured,
} from '../instrument-stacks';
export type { LogFields, Logger, LoggerOptions, LogLevel } from '../logger';
export {
  isRedactedKey,
  LOG_LEVELS,
  logger,
  REDACTED,
  redactKeys,
  setLoggerContextFields,
  setLogStream,
  structuredLogger,
} from '../logger';
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
} from '../metrics';
export {
  collectMetrics,
  configureMetrics,
  counter,
  DEFAULT_HISTOGRAM_BOUNDS,
  DEFAULT_MAX_SERIES,
  exportMetrics,
  gauge,
  histogram,
  MetricCardinalityError,
  MetricNameInvalidError,
  MetricValueInvalidError,
  memoryMetricExporter,
  OVERFLOW_ATTRIBUTE,
  resetMetrics,
  startMetricExport,
} from '../metrics';
export { subscribeSemconvMetrics } from '../metrics-semconv';
export { METRICS_CONTENT_TYPE, METRICS_PATH, metricsText } from '../metrics-text';
export type { OtlpAnyValue, OtlpKeyValue, OtlpSignal } from '../otlp';
export {
  OTLP_ENDPOINT_KEY,
  OTLP_HEADERS_KEY,
  OTLP_PROTOCOL_KEY,
  OTLP_RETRY_STATUSES,
  OTLP_SCOPE,
  OtlpEndpointInvalidError,
  OtlpHeadersInvalidError,
  OtlpProtocolUnsupportedError,
  otlpAttributes,
  otlpEndpoint,
  otlpEndpointLabel,
  otlpHeaders,
  otlpResource,
  tryOtlpEndpoint,
  unixNano,
} from '../otlp';
export type {
  ExportedLogRecord,
  OtlpLogExporter,
  OtlpLogExporterOptions,
} from '../otlp-log-exporter';
export { otlpLogExporter, otlpLogsRequest } from '../otlp-log-exporter';
export type { OtlpMetricExporter, OtlpMetricExporterOptions } from '../otlp-metric-exporter';
export { otlpMetricExporter, otlpMetricsRequest } from '../otlp-metric-exporter';
export type { OtlpSpanExporter, OtlpSpanExporterOptions } from '../otlp-span-exporter';
export { otlpSpanExporter, otlpTraceRequest } from '../otlp-span-exporter';
export type { RequestSample } from '../runtime-metrics';
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
} from '../runtime-metrics';
export type { Sampler } from '../sampler';
export {
  alwaysOffSampler,
  alwaysOnSampler,
  DEFAULT_SAMPLE_RATIO,
  defaultSampler,
  OTEL_SAMPLER_ARG_KEY,
  OTEL_SAMPLER_KEY,
  parentBasedRatioSampler,
  ratioSampler,
  resetDefaultSampler,
  samplerFromEnv,
} from '../sampler';
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
} from '../telemetry';
export {
  configureTelemetry,
  currentSampler,
  currentSpan,
  currentSpanContext,
  MAX_SPAN_EVENTS,
  memoryExporter,
  parseTraceparent,
  resetTelemetry,
  serviceResource,
  startSpan,
  traceparent,
  withSpan,
  withSpanContext,
} from '../telemetry';
