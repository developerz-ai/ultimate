// The `Provider` interface and `AnthropicProvider` (the real Messages API, streaming and not) —
// `EchoProvider`, the double, is ./echo-provider's, and the money arithmetic is ./cost's
// (`costOf` is re-exported here, where every caller has always imported it from). The REQUEST half only: ./models owns the catalogue and the per-model rules,
// ./wire owns the response half.

import type { Money } from '@ultimat3/money';
import type { AiMediaBlock } from './content-blocks';
import { assertMediaContent, blockText, mediaTokenEstimate } from './content-blocks';
import { costOf, exactCostOf } from './cost';
import { detailOf, withoutKey } from './error-body';
import { AiKeyMissingError, AiRequestInvalidError, AiTransportError } from './errors';
import type { AiFetch } from './fetch-seam';
import { resolveModel } from './model-resolve';
import type { Effort, ModelId, ThinkingMode } from './models';
import { modelSpec, reasoningBody } from './models';
import type { PromptCacheHint, SystemPrompt } from './prompt-cache';
import { promptCacheRule, systemText } from './prompt-cache';
import { anthropicPrompt } from './prompt-cache-blocks';
import { samplingBody } from './sampling';
import { readSse } from './sse';
import { assertToolArguments } from './tool-arguments';
import type { LlmTool, LlmToolCall } from './tools';
import {
  asToolInput,
  MessageStream,
  parseStopDetails,
  parseStopReason,
  parseUsage,
  throwInBandError,
} from './wire';

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
}

/** Total tokens a usage record accounts for — what a budget is debited by. */
export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

// ── Anthropic ────────────────────────────────────────────────────────────────

export interface AnthropicProviderInput {
  /**
   * The ids this endpoint serves — REQUIRED, the app's list, never a built-in one: the gateway
   * routes by membership, and each id is one the app `registerModel`-ed. A direct call names its
   * model or is refused (`X_AI_MODEL_UNRESOLVED`), as `openAiProvider({ models })`'s is.
   */
  readonly models: readonly ModelId[];
  /** Reads `ANTHROPIC_API_KEY` when omitted. Absent at call time is a labelled throw. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Injectable so a test can assert the request body without a network. Defaults to `fetch`. */
  readonly fetch?: AiFetch;
}

const ANTHROPIC_VERSION = '2023-06-01';
const API_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * Above this ceiling a non-streaming request sits on an open socket past the HTTP timeout and
 * fails AFTER the completion was generated and billed. Every current model can be asked for
 * eight times this, so the limit is the transport's, not the model's.
 */
export const STREAM_ONLY_MAX_TOKENS = 16_000;

/** Whether this request has to go over the streaming transport to arrive at all. */
export function requiresStreaming(request: GenerateRequest): boolean {
  const model = resolveModel('provider', request.model);
  return Math.min(request.maxTokens, modelSpec(model).maxOutput) > STREAM_ONLY_MAX_TOKENS;
}

/** The Anthropic Messages API provider — the one way to build one; the class is a type only. */
export function anthropicProvider(input: AnthropicProviderInput): AnthropicProvider {
  return new AnthropicProvider(input);
}

/**
 * The real Messages API shape. The request-surface rules are encoded rather than documented,
 * because getting them wrong is a 400:
 *   - `top_p`/`top_k` are never sent, and `temperature` only to a model whose row takes it
 *     (`ModelSpec.sampling`): a reasoning model rejects all three.
 *   - `thinking.budget_tokens` is REJECTED. Use `output_config.effort`.
 *   - `effort` and adaptive thinking are per-model, and ./models owns which model takes which.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  /** The app's list, never the registry's: a model served elsewhere must not be routed here. */
  readonly models: readonly ModelId[];
  private readonly config: AnthropicProviderInput;

  // `| undefined`: plain JS (or a cast) reaches here with no argument, and that is the same boot
  // mistake as an empty list — it gets the coded refusal, never a TypeError on `.models`.
  constructor(config: AnthropicProviderInput | undefined) {
    if (config === undefined || (config.models ?? []).length === 0) {
      // A provider serving nothing can never be routed to — the same boot mistake, refused the
      // same way, as an empty `openAiProvider({ models })`.
      throw new AiRequestInvalidError({
        detail:
          'anthropicProvider() was given an empty models list, so the gateway can never route to it',
        fix: "anthropicProvider({ models: ['<id>'] })   # the ids this endpoint serves, each one your app registerModel-ed",
      });
    }
    this.models = config.models;
    this.config = config;
  }

  /**
   * The model this request is for. The gateway resolves one before it routes; a direct call names
   * one or is refused — this provider's own list is never a fourth place a model comes from.
   */
  private modelOf(request: GenerateRequest): ModelId {
    return resolveModel('provider', request.model);
  }

  /**
   * Above `STREAM_ONLY_MAX_TOKENS` this runs the STREAMING transport and returns the assembled
   * result, rather than refusing. Refusing would leak a transport limit into the API: `llm()`
   * has no streaming path, so a declaration asking for a legal 64k completion would become
   * undeclarable instead of merely awkward — and the caller wanting the whole answer at once is
   * the same caller either way.
   */
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const model = this.modelOf(request);
    if (requiresStreaming({ ...request, model })) return this.assemble(request);
    const response = await this.send({ ...this.body(request), stream: false }, request.signal);
    const raw = (await response.json()) as Record<string, unknown>;
    return parseMessage(model, raw);
  }

  /** Drive `stream()` to its `done` chunk. It throws on a cut stream, so a partial never lands. */
  private async assemble(request: GenerateRequest): Promise<GenerateResult> {
    for await (const chunk of this.stream(request)) {
      if (chunk.type === 'done') return chunk.result;
    }
    throw new AiTransportError({
      provider: this.name,
      detail: 'the stream completed without a result',
    });
  }

  /**
   * Streaming is mandatory above ~16k `maxTokens`: a non-streaming request that large hits the
   * HTTP timeout before the model finishes. The final `done` chunk carries the assembled
   * result, so a consumer that only wants the answer can ignore every chunk before it.
   */
  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const model = this.modelOf(request);
    const response = await this.send({ ...this.body(request), stream: true }, request.signal);
    if (response.body === null) {
      throw new AiTransportError({
        provider: this.name,
        status: response.status,
        detail: 'a streaming response arrived with no body',
      });
    }
    const message = new MessageStream();
    for await (const frame of readSse(response.body, this.name)) {
      for (const chunk of message.push(frame)) yield chunk;
    }
    // A connection cut mid-answer must fail, not resolve: the partial text reads as a complete
    // answer, and `end_turn` would be a lie the caller has no way to detect.
    if (!message.isComplete()) {
      throw new AiTransportError({
        provider: this.name,
        detail:
          'the stream ended before message_stop, or with a tool call still open — the answer is truncated',
      });
    }
    const { malformed, ...state } = message.state();
    const cost = costOf(model, state.usage);
    // After usage is known, so a finished turn with unreadable arguments fails WITH its bill.
    assertToolArguments({ provider: this.name, model, ...state, malformed, cost });
    yield {
      type: 'done',
      result: { model, ...state, cost, costExact: exactCostOf(model, state.usage) },
    };
  }

  marksPromptCache(model: ModelId): boolean {
    return promptCacheRule('anthropic', this.config.baseUrl, model).marks === 'blocks';
  }

  /** The request body. Pure and side-effect free so a test can assert it directly. */
  body(request: GenerateRequest): Record<string, unknown> {
    const model = this.modelOf(request);
    // The blocks pass through untouched below — they ARE this wire's shapes — so this is the screen.
    assertMediaContent(request.messages, { provider: this.name, model });
    const prompt = anthropicPrompt(
      request,
      request.promptCache !== undefined && this.marksPromptCache(model),
    );
    const body: Record<string, unknown> = {
      model,
      max_tokens: Math.min(request.maxTokens, modelSpec(model).maxOutput),
      messages: prompt.messages,
      ...reasoningBody(model, request.effort, request.thinking),
      ...samplingBody('anthropic', model, request),
    };
    if (prompt.system !== undefined) body['system'] = prompt.system;
    if (request.tools !== undefined && request.tools.length > 0) body['tools'] = request.tools;
    if (request.stopSequences !== undefined) body['stop_sequences'] = request.stopSequences;
    return body;
  }

  /**
   * The one place a request leaves the process. A non-2xx becomes an `AiTransportError`
   * carrying its status, because the gateway decides whether to retry from that status and a
   * body parsed as if it were a message would read as an empty, successful answer.
   */
  private async send(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const apiKey = this.config.apiKey ?? Bun.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === '') {
      throw new AiKeyMissingError({ provider: this.name, envVar: API_KEY_ENV });
    }
    const doFetch: AiFetch = this.config.fetch ?? fetch;
    const url = `${this.config.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        accept: body['stream'] === true ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      // Attached only when the caller has one: `exactOptionalPropertyTypes`, and an explicit
      // `signal: undefined` is a different value to some fetch implementations.
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new AiTransportError({
        provider: this.name,
        status: response.status,
        // The endpoint's own message, with the credential scrubbed out of it — the same rule the
        // OpenAI-format provider follows, and for the same reason: a proxy echoing the request
        // headers into its 4xx body is the one path by which `x-api-key` reaches an error.
        detail: withoutKey(await detailOf(response), apiKey),
        envVar: API_KEY_ENV,
      });
    }
    return response;
  }
}

/** Map a Messages API response onto `GenerateResult`. Exported so tests can drive it. */
export function parseMessage(model: ModelId, raw: Record<string, unknown>): GenerateResult {
  // A 200 carrying an `error` object instead of an answer — how a gateway in front of a model
  // reports a fault it noticed after the headers were sent. Read as a message it is an empty,
  // successful answer, which is the one outcome nothing downstream can detect; the STREAMED half
  // of this same provider has always refused it.
  throwInBandError(raw);
  const content = Array.isArray(raw['content']) ? raw['content'] : [];
  let text = '';
  const toolCalls: LlmToolCall[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] === 'text' && typeof b['text'] === 'string') text += b['text'];
    if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
      toolCalls.push({
        id: b['id'],
        name: b['name'],
        // Parsed, never cast: `input` is untrusted, and a string under `Record<string, unknown>`
        // is a lie every later reader indexes into. The streamed half already parses it.
        input: asToolInput(b['input']),
      });
    }
  }
  const usage = parseUsage(raw['usage']);
  const stopDetails = parseStopDetails(raw['stop_details']);
  return {
    model,
    text,
    toolCalls,
    // A refusal detail is a refusal whatever the stop field says: `parseStopReason` answers
    // `end_turn` for a spelling this build has never seen, and `llm()` branches on the REASON —
    // `stopDetails` has no reader that can refuse — so the pair would arrive as a complete answer
    // that happens to be empty. The OpenAI-format read has always forced it.
    stopReason: stopDetails === undefined ? parseStopReason(raw['stop_reason']) : 'refusal',
    stopDetails,
    usage,
    cost: costOf(model, usage),
    costExact: exactCostOf(model, usage),
  };
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
