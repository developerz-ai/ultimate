// The X_* codes owned by @ultimat3/ai, and nothing else: the list, its titles and the one
// registration call. `bun run new-error-code --package ai` writes here. The classes that throw
// these codes live in `./errors` and its siblings; `./errors` imports this file for its
// registration, so a module that can construct one of them has the code registered.
import { registerErrorCodes } from '@ultimat3/core';

export const AI_ERROR_CODES = [
  'X_AI_PROVIDER_UNAVAILABLE',
  'X_AI_KEY_MISSING',
  'X_AI_REQUEST_INVALID',
  'X_AI_BUDGET_EXCEEDED',
  'X_AI_GATEWAY_MISSING',
  'X_AI_PROMPT_VERSION',
  'X_AI_MODEL_UNKNOWN',
  'X_AI_PROMPT_SECRET',
  'X_LLM_OUTPUT_INVALID',
  'X_LLM_REFUSED',
  'X_LLM_TRUNCATED',
  'X_LLM_STREAM_INVALID',
  'X_AGENT_MAX_TURNS',
  'X_AGENT_TOOL_UNEXPOSED',
  'X_HIVE_EMPTY',
  'X_EVAL_THRESHOLD',
  'X_EVAL_BASELINE_MISSING',
  'X_EVAL_BASELINE_INVALID',
  'X_EVAL_MISSING',
  'X_EVAL_RECORDING',
  'X_VECTOR_DIM_MISMATCH',
  'X_VECTOR_SCOPE_WIDENED',
  'X_AI_EMBEDDER_INVALID',
  'X_VECTOR_UNSCOPED',
  'X_AI_CONTENT_UNSUPPORTED',
  'X_AI_MODEL_UNRESOLVED',
  'X_AGENT_TOOL_LOOP',
  'X_AGENT_DEADLINE',
  'X_LLM_TOOL_ARGUMENTS_INVALID',
  'X_AGENT_TRANSCRIPT_INVALID',
  'X_AI_PROVIDER_UNEXPECTED',
  'X_AGENT_TOOL_UNDECLARED',
  'X_AGENT_CONTEXT_EXHAUSTED',
  'X_AI_SCRIPT_EXHAUSTED',
  'X_EVAL_TOOL_UNDOUBLED',
  'X_AI_CONTEXT_OVERFLOW',
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export const AI_ERROR_TITLES: Readonly<Record<AiErrorCode, string>> = {
  X_AI_PROVIDER_UNAVAILABLE: 'the model provider is unreachable',
  X_AI_KEY_MISSING: 'the provider API key is not set',
  X_AI_REQUEST_INVALID: 'the provider would reject this request',
  X_AI_BUDGET_EXCEEDED: 'a model call would exceed its budget',
  X_AI_GATEWAY_MISSING: 'an llm() action ran with no gateway installed',
  X_AI_PROMPT_VERSION: 'prompt version or slots are wrong',
  X_AI_MODEL_UNKNOWN: 'a model id nothing registered in the catalogue',
  X_AI_PROMPT_SECRET: 'a Secret was about to be rendered into a prompt',
  X_LLM_OUTPUT_INVALID: 'structured output failed its schema on the answer and the repair turn',
  X_LLM_REFUSED: 'the model declined the request',
  X_LLM_TRUNCATED: 'the answer hit its maxTokens ceiling before it was complete',
  X_LLM_STREAM_INVALID: 'a streamed answer failed its output schema, and a stream cannot repair',
  X_AGENT_MAX_TURNS: 'an agent hit its turn ceiling without answering',
  X_AGENT_TOOL_UNEXPOSED:
    'an agent lists a tool that is neither in-process nor an MCP-exposed action',
  X_HIVE_EMPTY: 'a hive split produced no members, so the run did nothing',
  X_EVAL_THRESHOLD: 'an eval scored below its tolerance',
  X_EVAL_BASELINE_MISSING: 'an eval has no recorded baseline to gate against',
  X_EVAL_BASELINE_INVALID: 'a recorded baseline cannot be read',
  X_EVAL_MISSING: 'a prompt has no eval',
  X_EVAL_RECORDING: 'the gate ran with baseline recording switched on',
  X_VECTOR_DIM_MISMATCH: 'embedding dimensions differ from the store',
  X_VECTOR_SCOPE_WIDENED: 'a derived vector scope tried to leave its tenant',
  X_AI_EMBEDDER_INVALID: 'an Embedder returned fewer vectors than texts it was given',
  X_VECTOR_UNSCOPED: 'a vector store was read with no tenant bound inside an org request',
  X_AI_CONTENT_UNSUPPORTED: 'an image or document block the role, model or wire format cannot take',
  X_AI_MODEL_UNRESOLVED: 'a model call named no model',
  X_AGENT_TOOL_LOOP: 'an agent repeated one tool call with one result and was stopped',
  X_AGENT_DEADLINE: 'an agent ran past its declared deadline and was stopped',
  X_LLM_TOOL_ARGUMENTS_INVALID: 'a finished turn called a tool with arguments that are not JSON',
  X_AGENT_TRANSCRIPT_INVALID: 'an agent was asked to continue from a transcript it cannot read',
  X_AI_PROVIDER_UNEXPECTED:
    'a provider ended a turn with an unknown reason and an incomplete answer',
  X_AGENT_TOOL_UNDECLARED: 'an agent run offered a tool its declaration does not list',
  X_AGENT_CONTEXT_EXHAUSTED: "an agent's next request would not fit its model's context window",
  X_AI_SCRIPT_EXHAUSTED: 'a scriptedProvider was called more times than it has turns',
  X_EVAL_TOOL_UNDOUBLED: 'an agent eval called a tool with no double',
  X_AI_CONTEXT_OVERFLOW: 'a provider refused a request as longer than the model context window',
};

// Titles must be registered for `format()` to render the contract's first line. Unconditional and
// in one call: every code above is owned here, so a second package claiming one is a real conflict
// that has to surface as X_ERROR_CODE_DUPLICATE rather than resolve to whoever imported first.
// `X_FORBIDDEN` (policy's) and `X_CURRENCY_MISMATCH` (money's) are thrown here but never titled.
registerErrorCodes(
  Object.fromEntries(Object.entries(AI_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);
