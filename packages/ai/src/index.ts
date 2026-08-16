// Public API of @ultimat3/ai. Explicit — a wildcard barrel would leak internals an app
// could depend on, and the gateway's guarantees only hold if every call goes through it.

/** Re-exported so an `llm` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type { AgentBudget, AgentDef, AgentVarsArgs } from './agent';
export { agent } from './agent';
export type {
  BudgetLedgerInput,
  BudgetLimits,
  BudgetReport,
  BudgetStore,
  SpendEstimate,
} from './budget';
export {
  BudgetLedger,
  currentBudget,
  estimateSpend,
  MemoryBudgetStore,
  withBudget,
} from './budget';
export type { Embedder, HashEmbedderInput } from './embeddings';
export {
  cosine,
  embedBatched,
  embedOne,
  fnv1a,
  HashEmbedder,
  normalize,
  tokenize,
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
export type { EvalBaseline, Regression } from './eval-baseline';
export {
  baselinePath,
  describeRegression,
  OVERALL,
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
export type { CreateGatewayInput, Gateway, GatewayCache, RetryPolicy } from './gateway';
export { backoffMs, cacheKeyFor, createGateway, DEFAULT_RETRY, isRetryable } from './gateway';
export type {
  LlmAction,
  LlmBudget,
  LlmCache,
  LlmDef,
  LlmSemanticCache,
  LlmVarsArgs,
} from './llm';
export { llm } from './llm';
export type { LlmStreamChunk } from './llm-stream';
export type { Effort, ModelId, ModelReasoning, ModelSpec, ThinkingMode } from './models';
export {
  ANTHROPIC_MODEL_IDS,
  assertModel,
  DEFAULT_MODEL,
  EFFORTS,
  isModelRegistered,
  modelIds,
  modelSpec,
  moreCapableThan,
  reasoningBody,
  registeredModels,
  registerModel,
  resetModels,
} from './models';
export { OPENAI_MODEL_IDS, registerOpenAiModels } from './openai-models';
export type { OpenAiProviderInput } from './openai-provider';
export { openAiProvider } from './openai-provider';
export type { PgVectorStoreInput } from './pg-vector';
export { PgVectorStore } from './pg-vector';
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
  hybridSql,
  searchSql,
  textSql,
  upsertSql,
  vectorLiteral,
} from './pg-vector-sql';
export type { DefinePromptInput, Prompt, PromptVars } from './prompt';
export {
  contentHash,
  definePrompt,
  describePrompts,
  getPrompt,
  promptVersions,
  resetPrompts,
} from './prompt';
export type {
  AiContentBlock,
  AiMessage,
  AnthropicProviderInput,
  EchoProviderInput,
  GenerateRequest,
  GenerateResult,
  Provider,
  StopDetails,
  StopReason,
  StreamChunk,
  TokenUsage,
} from './provider';
export {
  AnthropicProvider,
  costOf,
  EchoProvider,
  estimateCost,
  estimateInputTokens,
  estimateTextTokens,
  estimateTokens,
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
export { assembleContext, chunk, indexDocument, passthroughReranker, retrieve } from './rag';
export { assertNoSecrets } from './redaction';
export type { RemoteEmbedderInput } from './remote-embedder';
export { RemoteEmbedder } from './remote-embedder';
export type { AiRuntimeInput, Redactor } from './runtime';
export {
  aiEmbedder,
  aiGateway,
  aiRedactor,
  configureAi,
  resetAiRuntime,
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
  JsonSchema,
  LlmTool,
  LlmToolCall,
  LlmToolResult,
  ProjectableAction,
} from './tools';
export { runLlmToolCall, toLlmTool, toLlmTools } from './tools';
export type {
  HybridSearchInput,
  MemoryVectorStoreInput,
  MetadataFilter,
  SearchHit,
  StoredRecord,
  VectorRecord,
  VectorStore,
} from './vector';
export { fuse, MemoryVectorStore } from './vector';
export type { VectorScope } from './vector-scope';
export { NO_TENANT, narrowScope, scopeAdmits, tenantOf, UNSCOPED } from './vector-scope';
export type { StreamState } from './wire';
export { parseStopDetails, ZERO_USAGE } from './wire';
