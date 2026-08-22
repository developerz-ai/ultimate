// The observability slice of `@ultimat3/core`'s public surface, in one place: logging, metrics,
// tracing, sampling, the OTLP transports and error reporting. One group because they are one
// subject — a process's own account of what it did — and `index.ts` re-exports every name below
// explicitly, so this file changes what a reader looks at and never what the package exports.

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
  memoryErrorReporter,
  noopErrorReporter,
  reportError,
  resetErrorReporting,
} from '../error-reporter';
export type {
  SentryDsn,
  SentryEnvelopeOptions,
  SentryReporterOptions,
} from '../error-reporter-sentry';
export {
  ErrorReporterDsnInvalidError,
  parseSentryDsn,
  sentryEnvelope,
  sentryErrorReporter,
} from '../error-reporter-sentry';
export type { LogFields, Logger, LoggerOptions, LogLevel } from '../logger';
export {
  createLogger,
  isRedactedKey,
  LOG_LEVELS,
  logger,
  REDACTED,
  redactKeys,
  setLoggerContextFields,
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
  noopMetricExporter,
  OVERFLOW_ATTRIBUTE,
  resetMetrics,
  startMetricExport,
} from '../metrics';
export { METRICS_CONTENT_TYPE, METRICS_PATH, metricsText } from '../metrics-text';
export type { OtlpAnyValue, OtlpKeyValue, OtlpSignal } from '../otlp';
export {
  OTLP_ENDPOINT_KEY,
  OTLP_HEADERS_KEY,
  OTLP_PROTOCOL_KEY,
  OTLP_SCOPE,
  OtlpEndpointInvalidError,
  OtlpHeadersInvalidError,
  OtlpProtocolUnsupportedError,
  otlpAttributes,
  otlpEndpoint,
  otlpHeaders,
  otlpResource,
  tryOtlpEndpoint,
  unixNano,
} from '../otlp';
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
  memoryExporter,
  noopExporter,
  parseTraceparent,
  resetTelemetry,
  serviceResource,
  startSpan,
  traceparent,
  withSpan,
  withSpanContext,
} from '../telemetry';
