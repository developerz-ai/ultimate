// The `Provider` interface, the model catalogue with its prices, and two implementations:
// `AnthropicProvider` (the real Messages API, streaming and not) and `EchoProvider`
// (deterministic, for tests and `x dev` without a key).
//
// This file owns the REQUEST half and the prices; ./wire owns the response half.
//
// Prices live here in INTEGER MINOR UNITS per million tokens. Token spend is money, and the
// house rule applies to money regardless of where it comes from: never a float.
//
// As of 2026-08. Model IDs are exact alias strings — never append a date suffix.

import type { Money } from '@ultimat3/money';
import { AiKeyMissingError, AiRequestInvalidError, AiTransportError } from './errors';
import { readSse } from './sse';
import type { LlmTool, LlmToolCall } from './tools';
import { MessageStream, parseStopReason, parseUsage } from './wire';

/** Blessed models. Opus 5 is the default; the others are explicit downgrades. */
export const MODEL_IDS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const DEFAULT_MODEL: ModelId = 'claude-opus-5';

/**
 * Reasoning depth. `xhigh` is the best setting for coding and agentic work; `high` is the
 * API default. Distinct from `maxTokens`, which is an enforced ceiling the model cannot see.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Thinking mode. Adaptive lets the model decide depth per request and is the default. There
 * is no token budget to tune — `effort` replaced it.
 */
export type ThinkingMode = 'adaptive' | 'disabled';

export interface ModelSpec {
  readonly id: ModelId;
  readonly contextWindow: number;
  readonly maxOutput: number;
  /** Cost of one million input tokens, in minor units. */
  readonly inputPerMillion: Money;
  /** Cost of one million output tokens, in minor units. */
  readonly outputPerMillion: Money;
  /** Minimum cacheable prefix; a shorter prefix silently does not cache. */
  readonly cacheMinimumTokens: number;
}

const usd = (minor: number): Money => ({ minor, currency: 'USD' });

export const MODELS: Readonly<Record<ModelId, ModelSpec>> = {
  // $5 / $25 per MTok.
  'claude-opus-5': {
    id: 'claude-opus-5',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    inputPerMillion: usd(500),
    outputPerMillion: usd(2_500),
    cacheMinimumTokens: 512,
  },
  // $3 / $15 per MTok.
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    inputPerMillion: usd(300),
    outputPerMillion: usd(1_500),
    cacheMinimumTokens: 1_024,
  },
  // $1 / $5 per MTok.
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    contextWindow: 200_000,
    maxOutput: 64_000,
    inputPerMillion: usd(100),
    outputPerMillion: usd(500),
    cacheMinimumTokens: 4_096,
  },
};

export interface AiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
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

export interface GenerateResult {
  readonly model: ModelId;
  readonly text: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly stopReason: StopReason;
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
  const spec = MODELS[model];
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
/** Enough of an error body to name the field that was wrong, not enough to fill a log. */
const DETAIL_LIMIT = 300;

/**
 * The real Messages API shape. Three request-surface rules are encoded here rather than
 * documented, because getting them wrong is a 400 on every current model:
 *   - `temperature`/`top_p`/`top_k` are REJECTED. Steer with the prompt.
 *   - `thinking.budget_tokens` is REJECTED. Use `output_config.effort`.
 *   - `thinking: 'disabled'` is only valid at effort `high` or below.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly models = MODEL_IDS;
  private readonly config: AnthropicProviderInput;

  constructor(config: AnthropicProviderInput = {}) {
    this.config = config;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const response = await this.send({ ...this.body(request), stream: false });
    const raw = (await response.json()) as Record<string, unknown>;
    return parseMessage(request.model ?? DEFAULT_MODEL, raw);
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
    const effort = request.effort ?? 'high';
    const thinking = request.thinking ?? 'adaptive';
    const body: Record<string, unknown> = {
      model,
      max_tokens: Math.min(request.maxTokens, MODELS[model].maxOutput),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      // `output_config`, not a top-level `effort` — a top-level one is silently ignored.
      output_config: { effort },
      thinking:
        thinking === 'disabled'
          ? assertDisableAllowed(effort)
          : { type: 'adaptive', display: 'summarized' },
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
        detail: await detailOf(response),
      });
    }
    return response;
  }
}

/** The provider's own message, when it sent one — it names the offending field, we name the fix. */
async function detailOf(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as Record<string, unknown>)['error'];
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>)['message'];
        if (typeof message === 'string') return message.slice(0, DETAIL_LIMIT);
      }
    }
  } catch {
    // Not JSON — a proxy or a gateway timeout page. The raw text is still the best evidence.
  }
  return body === '' ? response.statusText : body.slice(0, DETAIL_LIMIT);
}

/** `thinking: 'disabled'` above `high` effort is a 400 — refuse locally with a real code. */
function assertDisableAllowed(effort: Effort): Record<string, unknown> {
  if (effort === 'xhigh' || effort === 'max') {
    throw new AiRequestInvalidError({
      detail: `thinking cannot be disabled at effort "${effort}" — the API allows it only at 'high' or below`,
      fix: `use effort 'high' or below with thinking disabled, or leave thinking adaptive`,
    });
  }
  return { type: 'disabled' };
}

/** Map a Messages API response onto `GenerateResult`. Exported so tests can drive it. */
export function parseMessage(model: ModelId, raw: Record<string, unknown>): GenerateResult {
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
        input: (b['input'] ?? {}) as Record<string, unknown>,
      });
    }
  }
  const usage = parseUsage(raw['usage']);
  return {
    model,
    text,
    toolCalls,
    stopReason: parseStopReason(raw['stop_reason']),
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
  readonly models = MODEL_IDS;
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
    if (message !== undefined && message.role === 'user') return message.content;
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
  const body = request.messages.map((m) => m.content).join(' ');
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
    outputTokens: Math.min(request.maxTokens, MODELS[model].maxOutput),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
