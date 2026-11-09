// Single responsibility: the OpenTelemetry semantic-convention names the framework's spans and
// metrics carry — STABLE names (http, db, messaging, gen_ai), one declaration each, so an emitter
// writes `SEMCONV.httpRequestMethod` and a typo is a type error, never a dashboard that is empty.

/** Span attribute keys. The legacy `http.method` / `db.statement` / `llm.*` spellings are gone. */
export const SEMCONV = Object.freeze({
  // HTTP server — https://opentelemetry.io/docs/specs/semconv/http/http-spans/
  httpRequestMethod: 'http.request.method',
  httpResponseStatusCode: 'http.response.status_code',
  httpRoute: 'http.route',
  urlPath: 'url.path',
  urlScheme: 'url.scheme',
  serverAddress: 'server.address',
  serverPort: 'server.port',
  errorType: 'error.type',
  // Database client — https://opentelemetry.io/docs/specs/semconv/database/database-spans/
  dbSystemName: 'db.system.name',
  dbNamespace: 'db.namespace',
  dbQueryText: 'db.query.text',
  dbOperationName: 'db.operation.name',
  dbCollectionName: 'db.collection.name',
  dbResponseReturnedRows: 'db.response.returned_rows',
  // Messaging (jobs) — https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/
  messagingSystem: 'messaging.system',
  messagingOperationType: 'messaging.operation.type',
  messagingOperationName: 'messaging.operation.name',
  messagingDestinationName: 'messaging.destination.name',
  messagingMessageId: 'messaging.message.id',
  // Generative AI — https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
  genAiProviderName: 'gen_ai.provider.name',
  genAiOperationName: 'gen_ai.operation.name',
  genAiRequestModel: 'gen_ai.request.model',
  genAiResponseModel: 'gen_ai.response.model',
  genAiUsageInputTokens: 'gen_ai.usage.input_tokens',
  genAiUsageOutputTokens: 'gen_ai.usage.output_tokens',
  genAiTokenType: 'gen_ai.token.type',
} as const);

/** The values semconv fixes for the framework's own systems. */
export const SEMCONV_VALUES = Object.freeze({
  dbSystemPostgres: 'postgresql',
  messagingSystemUltimate: 'ultimate',
  messagingOperationCreate: 'create',
  /** One message handed to the queue — a producer; `create` is for one built for a later batch. */
  messagingOperationSend: 'send',
  messagingOperationProcess: 'process',
  /** `llm()` is a chat call: every `ai.llm` event is this operation. */
  genAiOperationChat: 'chat',
  genAiTokenInput: 'input',
  genAiTokenOutput: 'output',
} as const);

/**
 * Metric names: semconv's, in the Prometheus form an OTel → Prometheus bridge produces (dots to
 * underscores, the unit as a suffix) — the registry is snake_case (`metric-names.ts`), and one
 * spelling on both `/metrics` and OTLP is what keeps a dashboard joinable.
 */
export const SEMCONV_METRICS = Object.freeze({
  /** semconv `db.client.operation.duration`, seconds. */
  dbClientOperationDuration: 'db_client_operation_duration_seconds',
  /** semconv `gen_ai.client.token.usage`, `{token}`, by `gen_ai.token.type`. */
  genAiClientTokenUsage: 'gen_ai_client_token_usage',
  /** `job.duration`, seconds, by queue and outcome — semconv `messaging.process.duration`'s role. */
  jobDuration: 'job_duration_seconds',
} as const);
