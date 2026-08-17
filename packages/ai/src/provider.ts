// The `Provider` interface, its two implementations — `AnthropicProvider` (the real Messages API,
// streaming and not) and `EchoProvider` (deterministic, for tests and `x dev` without a key) —
// and the money arithmetic over a call's reported usage. The REQUEST half only: ./models owns the
// catalogue and the per-model rules, ./wire owns the response half.

import type { Money } from '@ultimat3/money';
import { detailOf, withoutKey } from './error-body';
import { AiKeyMissingError, AiTransportError } from './errors';
import type { Effort, ModelId, ThinkingMode } from './models';
import { ANTHROPIC_MODEL_IDS, DEFAULT_MODEL, modelIds, modelSpec, reasoningBody } from './models';
import { readSse } from './sse';
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
 * to name the `tool_use` it answers, and a string has nowhere to put the id.
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
    };

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
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'tool_result') return block.content;
      return JSON.stringify(block.input);
    })
    .join(' ');
}

export interface GenerateRequest {
  readonly model?: ModelId;
  readonly system?: string;
  readonly messages: readonly AiMessage[];
  /** Enforced output ceiling. The model never sees it, so it can be cut off mid-answer. */
  readonly maxTokens: number;
  readonly effort?: Effort;
  readonly thinking?: ThinkingMode;
  readonly tools?: readonly LlmTool[];
  readonly stopSequences?: readonly string[];
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
  | 'refusal';

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
  /** Cost of this call, computed from `usage` and the model's prices. */
  readonly cost: Money;
}

/** One streamed increment. `done` carries the assembled result. */
export type StreamChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'tool-call'; readonly call: LlmToolCall }
  | { readonly type: 'done'; readonly result: GenerateResult };

export interface Provider {
  readonly name: string;
  /** Models this provider can serve. The gateway routes by membership. */
  readonly models: readonly ModelId[];
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;
}

/**
 * Cost of one call, in integer minor units. Rounded UP: a fraction of a cent that we round
 * away is money the framework silently absorbs, and under-reporting spend defeats a budget.
 */
export function costOf(model: ModelId, usage: TokenUsage): Money {
  const spec = modelSpec(model);
  // Cache reads are ~0.1x input; cache writes ~1.25x. Scaled by 10 to stay integral.
  const inputUnits =
    usage.inputTokens * 10 + usage.cacheReadTokens * 1 + Math.ceil(usage.cacheWriteTokens * 12.5);
  const inputMinor = divideCeil(inputUnits * spec.inputPerMillion.minor, 10_000_000);
  const outputMinor = divideCeil(usage.outputTokens * spec.outputPerMillion.minor, 1_000_000);
  return { minor: inputMinor + outputMinor, currency: spec.inputPerMillion.currency };
}

function divideCeil(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator);
}

/** Total tokens a usage record accounts for — what a budget is debited by. */
export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

// ── Anthropic ────────────────────────────────────────────────────────────────

export interface AnthropicProviderInput {
  /** Reads `ANTHROPIC_API_KEY` when omitted. Absent at call time is a labelled throw. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Injectable so a test can assert the request body without a network. Defaults to `fetch`. */
  readonly fetch?: typeof fetch;
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
  const model = request.model ?? DEFAULT_MODEL;
  return Math.min(request.maxTokens, modelSpec(model).maxOutput) > STREAM_ONLY_MAX_TOKENS;
}

/**
 * The real Messages API shape. The request-surface rules are encoded rather than documented,
 * because getting them wrong is a 400:
 *   - `temperature`/`top_p`/`top_k` are REJECTED on every current model. Steer with the prompt.
 *   - `thinking.budget_tokens` is REJECTED. Use `output_config.effort`.
 *   - `effort` and adaptive thinking are per-model, and ./models owns which model takes which.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  /** Its own list, never the registry's: an app's internal model must not be routed here. */
  readonly models: readonly ModelId[] = ANTHROPIC_MODEL_IDS;
  private readonly config: AnthropicProviderInput;

  constructor(config: AnthropicProviderInput = {}) {
    this.config = config;
  }

  /**
   * Above `STREAM_ONLY_MAX_TOKENS` this runs the STREAMING transport and returns the assembled
   * result, rather than refusing. Refusing would leak a transport limit into the API: `llm()`
   * has no streaming path, so a declaration asking for a legal 64k completion would become
   * undeclarable instead of merely awkward — and the caller wanting the whole answer at once is
   * the same caller either way.
   */
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (requiresStreaming(request)) return this.assemble(request);
    const response = await this.send({ ...this.body(request), stream: false });
    const raw = (await response.json()) as Record<string, unknown>;
    return parseMessage(request.model ?? DEFAULT_MODEL, raw);
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
    const model = request.model ?? DEFAULT_MODEL;
    const response = await this.send({ ...this.body(request), stream: true });
    if (response.body === null) {
      throw new AiTransportError({
        provider: this.name,
        status: response.status,
        detail: 'a streaming response arrived with no body',
      });
    }
    const message = new MessageStream();
    for await (const frame of readSse(response.body)) {
      for (const chunk of message.push(frame)) yield chunk;
    }
    // A connection cut mid-answer must fail, not resolve: the partial text reads as a complete
    // answer, and `end_turn` would be a lie the caller has no way to detect.
    if (!message.isComplete()) {
      throw new AiTransportError({
        provider: this.name,
        detail: 'the stream ended before message_stop — the answer is truncated',
      });
    }
    const state = message.state();
    yield {
      type: 'done',
      result: { model, ...state, cost: costOf(model, state.usage) },
    };
  }

  /** The request body. Pure and side-effect free so a test can assert it directly. */
  body(request: GenerateRequest): Record<string, unknown> {
    const model = request.model ?? DEFAULT_MODEL;
    const body: Record<string, unknown> = {
      model,
      max_tokens: Math.min(request.maxTokens, modelSpec(model).maxOutput),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      ...reasoningBody(model, request.effort, request.thinking),
    };
    if (request.system !== undefined) body['system'] = request.system;
    if (request.tools !== undefined && request.tools.length > 0) body['tools'] = request.tools;
    if (request.stopSequences !== undefined) body['stop_sequences'] = request.stopSequences;
    return body;
  }

  /**
   * The one place a request leaves the process. A non-2xx becomes an `AiTransportError`
   * carrying its status, because the gateway decides whether to retry from that status and a
   * body parsed as if it were a message would read as an empty, successful answer.
   */
  private async send(body: Record<string, unknown>): Promise<Response> {
    const apiKey = this.config.apiKey ?? Bun.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === '') {
      throw new AiKeyMissingError({ provider: this.name, envVar: API_KEY_ENV });
    }
    const doFetch = this.config.fetch ?? fetch;
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
  };
}

// ── Echo ─────────────────────────────────────────────────────────────────────

export interface EchoProviderInput {
  /** Fixed replies keyed by the last user message, for eval fixtures. */
  readonly replies?: Readonly<Record<string, string>>;
  /** Fallback when no key matches. Defaults to echoing the last user message. */
  readonly fallback?: (prompt: string) => string;
  readonly tokensPerCall?: number;
}

/**
 * Deterministic provider. Same input, same output, same usage — which is what makes an eval
 * suite a test rather than a sample. Token counts are derived from length, so a budget test
 * can assert a refusal without a network.
 */
export class EchoProvider implements Provider {
  readonly name = 'echo';
  /**
   * A getter over the whole registry, not a snapshot: the test double has to serve whatever the
   * test registered, and a field read at construction time would miss a model registered after.
   */
  get models(): readonly ModelId[] {
    return modelIds();
  }

  private readonly config: EchoProviderInput;

  constructor(config: EchoProviderInput = {}) {
    this.config = config;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const model = request.model ?? DEFAULT_MODEL;
    const prompt = lastUserMessage(request.messages);
    const text = this.config.replies?.[prompt] ?? this.config.fallback?.(prompt) ?? prompt;
    const usage: TokenUsage = {
      inputTokens: this.config.tokensPerCall ?? estimateTokens(request),
      outputTokens: estimateTextTokens(text),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    return {
      model,
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      stopDetails: undefined,
      usage,
      cost: costOf(model, usage),
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const result = await this.generate(request);
    // One word per chunk: enough to exercise a consumer's assembly logic.
    for (const word of result.text.split(' ')) {
      if (word !== '') yield { type: 'text', text: `${word} ` };
    }
    yield { type: 'done', result };
  }
}

function lastUserMessage(messages: readonly AiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== undefined && message.role === 'user') return messageText(message);
  }
  return '';
}

/**
 * ~4 characters per token. Deliberately an ESTIMATE and never used for billing — the
 * gateway's pre-flight budget check needs a number before the call exists, and the real
 * count from `usage` replaces it afterwards.
 */
export function estimateTokens(request: GenerateRequest): number {
  return estimateInputTokens(request) + request.maxTokens;
}

/** The prompt half alone — what the provider bills at the input rate. */
export function estimateInputTokens(request: GenerateRequest): number {
  const body = request.messages.map(messageText).join(' ');
  return estimateTextTokens(body) + estimateTextTokens(request.system ?? '');
}

/**
 * Worst-case price of a request before it exists: the prompt at the input rate, the FULL
 * `maxTokens` at the output rate. Deliberately pessimistic — a ceiling checked against an
 * optimistic estimate is a ceiling one long completion walks through.
 */
export function estimateCost(request: GenerateRequest): Money {
  const model = request.model ?? DEFAULT_MODEL;
  return costOf(model, {
    inputTokens: estimateInputTokens(request),
    outputTokens: Math.min(request.maxTokens, modelSpec(model).maxOutput),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
