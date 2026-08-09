// Public API of @ultimat3/ai. Explicit — a wildcard barrel would leak internals an app
// could depend on, and the gateway's guarantees only hold if every call goes through it.

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
  RemoteEmbedder,
  tokenize,
} from './embeddings';
export type { AiErrorCode } from './errors';
export {
  AI_ERROR_CODES,
  AiBudgetExceededError,
  AiGatewayMissingError,
  AiNotImplementedError,
  AiPromptRenderError,
  AiPromptVersionError,
  AiProviderUnavailableError,
  EvalThresholdError,
  LlmOutputInvalidError,
  VectorDimMismatchError,
  VectorScopeWidenedError,
} from './errors';
export type {
  CaseResult,
  DefineEvalInput,
  Eval,
  EvalCase,
  EvalResult,
  Scorer,
} from './evals';
export {
  contains,
  defineEval,
  describeEvals,
  exact,
  jsonSchemaValid,
  jsonValid,
  llmJudge,
  numericTolerance,
  resetEvals,
} from './evals';
export type { CreateGatewayInput, Gateway, GatewayCache, RetryPolicy } from './gateway';
export { backoffMs, cacheKeyFor, createGateway, DEFAULT_RETRY, isRetryable } from './gateway';
export type {
  LlmBudget,
  LlmCache,
  LlmDef,
  LlmSemanticCache,
  LlmVarsArgs,
} from './llm';
export { llm } from './llm';
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
  AiMessage,
  AnthropicProviderInput,
  EchoProviderInput,
  Effort,
  GenerateRequest,
  GenerateResult,
  ModelId,
  ModelSpec,
  Provider,
  StopReason,
  StreamChunk,
  ThinkingMode,
  TokenUsage,
} from './provider';
export {
  AnthropicProvider,
  costOf,
  DEFAULT_MODEL,
  EchoProvider,
  estimateCost,
  estimateInputTokens,
  estimateTextTokens,
  estimateTokens,
  MODEL_IDS,
  MODELS,
  parseMessage,
  totalTokens,
  ZERO_USAGE,
} from './provider';
export type {
  AssembledContext,
  Chunk,
  ChunkInput,
  Reranker,
  RetrieveInput,
} from './rag';
export { assembleContext, chunk, indexDocument, passthroughReranker, retrieve } from './rag';
export type { AiRuntimeInput } from './runtime';
export { aiEmbedder, aiGateway, configureAi, resetAiRuntime, semanticCacheFor } from './runtime';
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
