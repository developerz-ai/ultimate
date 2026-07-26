// The `Provider` interface, the model catalogue with its prices, and two implementations:
// `AnthropicProvider` (shaped for the real Messages API) and `EchoProvider` (deterministic,
// for tests and `x dev` without a key).
//
// Prices live here in INTEGER MINOR UNITS per million tokens. Token spend is money, and the
// house rule applies to money regardless of where it comes from: never a float.
//
// As of 2026-07. Model IDs are exact alias strings — never append a date suffix.

import type { Money } from '@ultimat3/money';
import { AiNotImplementedError } from './errors.ts';
import type { LlmTool, LlmToolCall } from './tools.ts';

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

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

// ── Anthropic ────────────────────────────────────────────────────────────────

export interface AnthropicProviderInput {
  /** Reads `ANTHROPIC_API_KEY` when omitted. Absent at call time is a labelled throw. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Injectable so a test can assert the request body without a network. */
  readonly fetch?: typeof fetch;
}

const ANTHROPIC_VERSION = '2023-06-01';

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
    const response = await this.post({ ...this.body(request), stream: false });
    return parseMessage(request.model ?? DEFAULT_MODEL, response);
  }

  /**
   * Streaming is mandatory above ~16k `maxTokens`: a non-streaming request that large hits
   * the HTTP timeout before the model finishes.
   */
  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    // The SSE reader belongs to the transport half, which needs a real connection.
    void this.body(request);
    throw new AiNotImplementedError({
      feature: 'AnthropicProvider.stream (SSE reader)',
      fix: 'set ANTHROPIC_API_KEY and pass a real `fetch` to createGateway, or use EchoProvider in tests',
    });
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

  private async post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const apiKey = this.config.apiKey ?? Bun.env['ANTHROPIC_API_KEY'];
    const doFetch = this.config.fetch;
    if (apiKey === undefined || apiKey === '' || doFetch === undefined) {
      throw new AiNotImplementedError({
        feature: 'AnthropicProvider remote transport',
        fix: 'export ANTHROPIC_API_KEY=sk-ant-... and pass { fetch } to AnthropicProvider',
      });
    }
    const url = `${this.config.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return (await response.json()) as Record<string, unknown>;
  }
}

/** `thinking: 'disabled'` above `high` effort is a 400 — refuse locally with a real code. */
function assertDisableAllowed(effort: Effort): Record<string, unknown> {
  if (effort === 'xhigh' || effort === 'max') {
    throw new AiNotImplementedError({
      feature: `thinking: 'disabled' at effort "${effort}"`,
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

function parseUsage(raw: unknown): TokenUsage {
  if (typeof raw !== 'object' || raw === null) return ZERO_USAGE;
  const u = raw as Record<string, unknown>;
  const num = (key: string): number => (typeof u[key] === 'number' ? (u[key] as number) : 0);
  return {
    inputTokens: num('input_tokens'),
    outputTokens: num('output_tokens'),
    cacheReadTokens: num('cache_read_input_tokens'),
    cacheWriteTokens: num('cache_creation_input_tokens'),
  };
}

const STOP_REASONS: readonly StopReason[] = [
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
];

function parseStopReason(raw: unknown): StopReason {
  return STOP_REASONS.find((r) => r === raw) ?? 'end_turn';
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
  const body = request.messages.map((m) => m.content).join(' ');
  return estimateTextTokens(body) + estimateTextTokens(request.system ?? '') + request.maxTokens;
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
