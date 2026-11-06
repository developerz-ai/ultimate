// The provider-neutral shapes — `Provider`, the request, the result, the stream chunk — and the
// pre-flight estimates. `AnthropicProvider` is ./anthropic-provider's, the double ./echo-provider's,
// the money arithmetic ./cost's; `costOf` and the Anthropic names are re-exported here, where every
// caller has always imported them from. ./models owns the per-model rules, ./wire the response half.

import type { Money } from '@ultimat3/money';
import type { AiMediaBlock } from './content-blocks';
import { blockText, mediaTokenEstimate } from './content-blocks';
import { costOf } from './cost';
import { resolveModel } from './model-resolve';
import type { Effort, ModelId, ThinkingMode } from './models';
import { modelSpec } from './models';
import type { PromptCacheHint, SystemPrompt } from './prompt-cache';
import { systemText } from './prompt-cache';
import type { SamplingWire } from './sampling';
import type { LlmTool, LlmToolCall } from './tools';

/**
 * One block of a structured message. A plain string message is still the common case and still
 * legal; blocks exist because a tool loop cannot be expressed without them — a `tool_result` has
 * to name the `tool_use` it answers, and a string has nowhere to put the id — and because an image
 * or a PDF is not a string at all (`./content-blocks` owns those two and screens them).
 *
 * The field names are the Messages API's, not a translated set, so `body()` passes a block
 * through untouched. A second vocabulary here would be a mapping table to keep in step with a
 * wire format we do not own.
 */
export type AiContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: 'tool_result';
      readonly tool_use_id: string;
      readonly content: string;
      readonly is_error?: boolean;
    }
  | AiMediaBlock;

export interface AiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly AiContentBlock[];
}

/**
 * The readable text of a message, blocks flattened. For ESTIMATING and for the echo provider —
 * never for building a request, which sends `content` as it stands.
 */
export function messageText(message: AiMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map(blockText).join(' ');
}

export interface GenerateRequest {
  readonly model?: ModelId;
  /** One string, or a stable part and a per-run part (`./prompt-cache`) — two blocks on the wire. */
  readonly system?: SystemPrompt;
  /**
   * Ask the provider to cache this request's prefix: the stable system part and the transcript's
   * tail, marked per wire and host by `PROMPT_CACHE_RULES`. Absent sends no mark. Not part of
   * `promptCacheKey` — it changes what a call costs, never what it answers.
   */
  readonly promptCache?: PromptCacheHint;
  readonly messages: readonly AiMessage[];
  /** Enforced output ceiling. The model never sees it, so it can be cut off mid-answer. */
  readonly maxTokens: number;
  readonly effort?: Effort;
  readonly thinking?: ThinkingMode;
  readonly tools?: readonly LlmTool[];
  readonly stopSequences?: readonly string[];
  /** Sent only to a model whose row takes it (`ModelSpec.sampling`, `./sampling`). 0 to 2. */
  readonly temperature?: number;
  /** As `temperature`; chat-completions only — the Messages API has no seed. */
  readonly seed?: number;
  /**
   * The caller's abort signal, forwarded to the socket by every provider in this package.
   *
   * Deliberately absent from `promptCacheKey` and from every estimate: it says whether a request was
   * ABANDONED, never what it asked for, so two calls that differ only in it are the same call and
   * must share a cache entry. Omitted means the call runs to completion — there is no ambient
   * default, because a timeout the caller did not ask for is a truncated answer nothing reports.
   */
  readonly signal?: AbortSignal;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * Why generation stopped. `refusal` is a successful HTTP response whose content may be
 * empty or partial — callers must branch on this BEFORE reading `text`.
 */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  /** The prompt plus the answer outgrew the model's context window: cut off, like `max_tokens`. */
  | 'model_context_window_exceeded';

/** Whether an answer was CUT OFF — never parse one of these as a complete answer. */
export const isTruncated = (reason: StopReason): boolean =>
  reason === 'max_tokens' || reason === 'model_context_window_exceeded';

/**
 * Why a refusal happened. Only ever present when `stopReason` is `refusal`, and `category` is
 * an open set — a closed union here would turn the provider adding a category into a parse
 * failure. Carried rather than dropped because the category is the one thing that says whether
 * a different model would answer, which is the only decision a caller can act on.
 */
export interface StopDetails {
  readonly type: 'refusal';
  readonly category: string | undefined;
  readonly explanation: string | undefined;
}

export interface GenerateResult {
  readonly model: ModelId;
  /**
   * Which provider actually answered. Stamped by the GATEWAY, not by the provider: falling back
   * from one provider to the next is a gateway concept, and a `Provider` implementation an app
   * wrote cannot be asked to report on a decision it did not make. Optional for exactly that
   * reason — a provider's own result has not been through the router yet. `llm()` puts it on the
   * span as `llm.provider`, which is what makes a fallback visible rather than silent.
   */
  readonly provider?: string;
  readonly text: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly stopReason: StopReason;
  /** Required, not optional: a provider that forgets it turns a refusal into a silent empty answer. */
  readonly stopDetails: StopDetails | undefined;
  readonly usage: TokenUsage;
  /** Cost of this call in the currency's minor units, rounded up once (`costOf`). */
  readonly cost: Money;
  /**
   * The same cost EXACTLY, as `Money` at a finer `scale` (`exactCostOf`) — what a ledger sums, so
   * a run of cheap calls is rounded once at the end and not once per call. Optional: a `Provider`
   * an app wrote may not state it, and its `cost` is summed in its place.
   */
  readonly costExact?: Money;
}

/** One streamed increment. `done` carries the assembled result. */
export type StreamChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'tool-call'; readonly call: LlmToolCall }
  | { readonly type: 'done'; readonly result: GenerateResult };

export type { AnthropicProvider, AnthropicProviderInput } from './anthropic-provider';
export {
  anthropicProvider,
  parseMessage,
  requiresStreaming,
  STREAM_ONLY_MAX_TOKENS,
} from './anthropic-provider';
export { costOf } from './cost';

export interface Provider {
  readonly name: string;
  /** Models this provider can serve. The gateway routes by membership. */
  readonly models: readonly ModelId[];
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;
  /**
   * Whether a request carrying `promptCache` for this model would be sent with an explicit cache
   * mark — billed as a cache WRITE. Absent is no: the gateway prices the write only where one
   * can happen.
   */
  marksPromptCache?(model: ModelId): boolean;
  /** Which wire format this provider speaks, when it is one of the two built in (`./sampling`). */
  readonly wire?: SamplingWire;
}

/** Total tokens a usage record accounts for — what a budget is debited by. */
export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * ~4 characters per token. Deliberately an ESTIMATE and never used for billing — the gateway's
 * pre-flight budget check needs a number before the call exists, and `usage` replaces it after.
 * The completion is clamped to what the model can write, exactly as `estimateCost` clamps it.
 */
export function estimateTokens(request: GenerateRequest): number {
  return estimateInputTokens(request) + completionCeiling(request);
}

const completionCeiling = (request: GenerateRequest): number =>
  Math.min(request.maxTokens, modelSpec(resolveModel('provider', request.model)).maxOutput);

/** The prompt half alone — what the provider bills at the input rate. */
export function estimateInputTokens(request: GenerateRequest): number {
  const body = request.messages.map(messageText).join(' ');
  const text = estimateTextTokens(body) + estimateTextTokens(systemText(request.system));
  return text + mediaTokenEstimate(request.messages);
}

/**
 * Worst-case price of a request before it exists: the prompt at the input rate, the FULL
 * `maxTokens` at the output rate. Deliberately pessimistic — a ceiling checked against an
 * optimistic estimate is a ceiling one long completion walks through.
 */
export function estimateCost(request: GenerateRequest, marked = false): Money {
  const model = resolveModel('provider', request.model);
  const prompt = estimateInputTokens(request);
  const usage = { outputTokens: completionCeiling(request), cacheReadTokens: 0 };
  const asInput = costOf(model, { ...usage, inputTokens: prompt, cacheWriteTokens: 0 });
  // A request a provider WILL mark (`marked`: the gateway asks the providers serving the model) can
  // be billed as a cache write end to end. The DEARER of the two: a row whose write is cheaper
  // than input must not lower the ceiling's estimate below what an unmarked call costs.
  if (!marked || request.promptCache === undefined) return asInput;
  const asWrite = costOf(model, { ...usage, inputTokens: 0, cacheWriteTokens: prompt });
  return asWrite.minor > asInput.minor ? asWrite : asInput;
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
