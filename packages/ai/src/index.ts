// Public API of @ultimat3/ai. Explicit — a wildcard barrel would leak internals an app
// could depend on, and the gateway's guarantees only hold if every call goes through it.

/** Re-exported so an `llm` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type { AgentBudget, AgentDef, AgentTurn, AgentVarsArgs } from './agent';
export { agent } from './agent';
export type { AgentBudgetFact, AgentFact } from './agent-facts';
export { describeAgents, resetAgents } from './agent-facts';
export type { AgentJobOptions } from './agent-job';
export { agentJob } from './agent-job';
export type {
  BudgetKeys,
  BudgetLedger,
  BudgetLedgerInput,
  BudgetLimits,
  BudgetReport,
  BudgetStore,
  BudgetTake,
  MemoryBudgetStore,
  SpendEstimate,
} from './budget';
export {
  budgetKeysFor,
  currentBudget,
  estimateSpend,
  memoryBudgetStore,
  withBudget,
} from './budget';
export type {
  AiDocumentBlock,
  AiDocumentSource,
  AiImageBlock,
  AiImageSource,
  AiMediaBlock,
  ImageMediaType,
} from './content-blocks';
export {
  IMAGE_MEDIA_TYPES,
  IMAGE_TOKEN_ESTIMATE,
  isMediaBlock,
  MAX_DOCUMENT_BASE64_CHARS,
  MAX_IMAGE_BASE64_CHARS,
} from './content-blocks';
export type { ContentRefusal } from './content-errors';
export { AiContentUnsupportedError } from './content-errors';
export type { EchoProvider, EchoProviderInput } from './echo-provider';
export { echoProvider } from './echo-provider';
export type { Embedder, HashEmbedder, HashEmbedderInput } from './embeddings';
export {
  cosine,
  embedBatched,
  embedOne,
  hashEmbedder,
  normalizeVector,
  wordTokens,
} from './embeddings';
export type { AiErrorCode } from './errors';
export {
  AgentMaxTurnsError,
  AgentToolUnexposedError,
  AI_ERROR_CODES,
  AI_ERROR_TITLES,
  AiBudgetExceededError,
  AiGatewayMissingError,
  AiKeyMissingError,
  AiModelUnknownError,
  AiPromptRenderError,
  AiPromptSecretError,
  AiPromptVersionError,
  AiProviderUnavailableError,
  AiRequestInvalidError,
  AiTransportError,
  EmbedderDimMismatchError,
  LlmOutputInvalidError,
  LlmRefusedError,
  LlmStreamInvalidError,
  LlmTruncatedError,
  VectorDimMismatchError,
  VectorScopeWidenedError,
} from './errors';
export { AI_ERROR_RETRY } from './errors-retry';
export type { EvalBaseline, Regression } from './eval-baseline';
export {
  baselinePath,
  describeRegression,
  RECORD_ENV,
  readBaseline,
  recordingBaselines,
  regressionsAgainst,
  writeBaseline,
} from './eval-baseline';
export {
  EvalBaselineInvalidError,
  EvalBaselineMissingError,
  EvalMissingError,
  EvalRecordingError,
  EvalThresholdError,
} from './eval-errors';
export type {
  CaseResult,
  DefineEvalInput,
  Eval,
  EvalCase,
  EvalFact,
  EvalResult,
} from './evals';
export {
  baselineFrom,
  defineEval,
  describeEvals,
  promptsWithoutEvals,
  resetEvals,
} from './evals';
export type { AiFetch } from './fetch-seam';
export type { Gateway, GatewayCache, ProviderGatewayInput, RetryPolicy } from './gateway';
export {
  backoffMs,
  DEFAULT_GATEWAY_RETRY,
  isRetryable,
  promptCacheKey,
  providerGateway,
} from './gateway';
export type { HiveDef, HiveSplitArgs } from './hive';
export { hive } from './hive';
export { HiveEmptyError } from './hive-errors';
export type { HiveMember, HiveMemberError, HiveOutput, HiveResult } from './hive-result';
export type { LlmAction, LlmBudget, LlmDef, LlmVarsArgs } from './llm';
export { llm } from './llm';
export type { LlmCache, LlmScopeArgs, LlmSemanticCache } from './llm-cache';
export type { LlmStreamChunk } from './llm-stream';
export type { ModelSource } from './model-resolve';
export { AiModelUnresolvedError } from './model-resolve';
export type {
  ContentKind,
  DeclaredReasoning,
  Effort,
  ModelId,
  ModelReasoning,
  ModelSpec,
  ThinkingMode,
} from './models';
export {
  assertModel,
  EFFORTS,
  isModelRegistered,
  modelIds,
  modelSpec,
  moreCapableThan,
  registeredModels,
  registerModel,
  resetModels,
} from './models';
export type { OpenAiProviderInput } from './openai-provider';
export { openAiProvider } from './openai-provider';
export type { PostgresVectorStore, PostgresVectorStoreInput } from './pg-vector';
export { postgresVectorStore } from './pg-vector';
export type {
  PgHybridArgs,
  PgSearchArgs,
  PgVectorRowInput,
  PgVectorTable,
} from './pg-vector-sql';
export {
  conditionsSql,
  ddlSql,
  deleteSql,
  searchSql,
} from './pg-vector-sql';
export type { DefinePromptInput, Prompt, PromptVars } from './prompt';
export {
  definePrompt,
  describePrompts,
  getPrompt,
  promptHash,
  promptVersions,
  resetPrompts,
} from './prompt';
export { promptFences } from './prompt-fence';
export type {
  AiContentBlock,
  AiMessage,
  AnthropicProvider,
  AnthropicProviderInput,
  GenerateRequest,
  GenerateResult,
  Provider,
  StopDetails,
  StopReason,
  StreamChunk,
  TokenUsage,
} from './provider';
export {
  anthropicProvider,
  costOf,
  estimateCost,
  estimateInputTokens,
  estimateTextTokens,
  estimateTokens,
  isTruncated,
  messageText,
  parseMessage,
  requiresStreaming,
  STREAM_ONLY_MAX_TOKENS,
  totalTokens,
} from './provider';
export type {
  AssembledContext,
  Chunk,
  ChunkInput,
  Reranker,
  RetrieveInput,
} from './rag';
export {
  assembleContext,
  chunkDocument,
  indexDocument,
  passthroughReranker,
  retrieve,
} from './rag';
export { assertNoSecrets } from './redaction';
export type { RemoteEmbedder, RemoteEmbedderInput } from './remote-embedder';
export { remoteEmbedder } from './remote-embedder';
export type { AiRuntimeInput, Redactor } from './runtime';
export {
  aiEmbedder,
  aiGateway,
  aiRedactor,
  configureAi,
  semanticCacheFor,
} from './runtime';
export type { Scorer } from './scorers';
export {
  contains,
  exact,
  jsonSchemaValid,
  jsonValid,
  llmJudge,
  numericTolerance,
} from './scorers';
export type {
  AgentTool,
  JsonSchema,
  LlmTool,
  LlmToolCall,
  LlmToolResult,
  ProjectableAction,
} from './tools';
export { asProjectableAction, runLlmToolCall, toLlmTool, toLlmTools } from './tools';
export type {
  HybridSearchInput,
  MemoryVectorStore,
  MemoryVectorStoreInput,
  MetadataFilter,
  SearchHit,
  StoredRecord,
  VectorRecord,
  VectorStore,
} from './vector';
export { fuse, memoryVectorStore } from './vector';
export type { VectorScope } from './vector-scope';
export { NO_VECTOR_TENANT, tenantOf, UNSCOPED, VectorUnscopedError } from './vector-scope';
export type { StreamState } from './wire';
