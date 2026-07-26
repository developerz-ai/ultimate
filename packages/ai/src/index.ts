// Public API of @ultimat3/ai. Explicit — a wildcard barrel would leak internals an app
// could depend on, and the gateway's guarantees only hold if every call goes through it.

export type { BudgetLedgerInput, BudgetLimits, BudgetReport, BudgetStore } from './budget.ts';
export { BudgetLedger, currentBudget, MemoryBudgetStore, withBudget } from './budget.ts';
export type { Embedder, HashEmbedderInput } from './embeddings.ts';
export {
  cosine,
  embedBatched,
  embedOne,
  fnv1a,
  HashEmbedder,
  normalize,
  RemoteEmbedder,
  tokenize,
} from './embeddings.ts';
export type { AiErrorCode } from './errors.ts';
export {
  AI_ERROR_CODES,
  AiBudgetExceededError,
  AiNotImplementedError,
  AiPromptRenderError,
  AiPromptVersionError,
  AiProviderUnavailableError,
  EvalThresholdError,
  VectorDimMismatchError,
} from './errors.ts';
export type {
  CaseResult,
  DefineEvalInput,
  Eval,
  EvalCase,
  EvalResult,
  Scorer,
} from './evals.ts';
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
} from './evals.ts';
export type { CreateGatewayInput, Gateway, GatewayCache, RetryPolicy } from './gateway.ts';
export { backoffMs, cacheKeyFor, createGateway, DEFAULT_RETRY, isRetryable } from './gateway.ts';
export type { DefinePromptInput, Prompt, PromptVars } from './prompt.ts';
export {
  contentHash,
  definePrompt,
  describePrompts,
  getPrompt,
  promptVersions,
  resetPrompts,
} from './prompt.ts';
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
} from './provider.ts';
export {
  AnthropicProvider,
  costOf,
  DEFAULT_MODEL,
  EchoProvider,
  estimateTextTokens,
  estimateTokens,
  MODEL_IDS,
  MODELS,
  parseMessage,
  totalTokens,
  ZERO_USAGE,
} from './provider.ts';
export type {
  AssembledContext,
  Chunk,
  ChunkInput,
  Reranker,
  RetrieveInput,
} from './rag.ts';
export { assembleContext, chunk, indexDocument, passthroughReranker, retrieve } from './rag.ts';
export type {
  JsonSchema,
  LlmTool,
  LlmToolCall,
  LlmToolResult,
  ProjectableAction,
} from './tools.ts';
export { runLlmToolCall, toLlmTool, toLlmTools } from './tools.ts';
export type {
  HybridSearchInput,
  MemoryVectorStoreInput,
  MetadataFilter,
  SearchHit,
  VectorRecord,
  VectorStore,
} from './vector.ts';
export { fuse, MemoryVectorStore, PgVectorStore } from './vector.ts';
