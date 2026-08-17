// Single responsibility: reading what the Anthropic Messages API sends back — the `usage` and
// `stop_reason` shapes both transports share, and the assembler that turns one SSE stream into
// `StreamChunk`s.
//
// Split from provider.ts so the request half (what we send) and the response half (what we
// read) stay separately readable, and so the assembler can be driven frame by frame in a test
// with no socket, which is the only way to cover a stream that arrives out of order or stops
// half way. Imports from provider.ts are types only — the dependency runs one way.

import { AiTransportError } from './errors';
import type { StopDetails, StopReason, StreamChunk, TokenUsage } from './provider';
import type { SseFrame } from './sse';
import type { LlmToolCall } from './tools';

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const USAGE_FIELDS: Readonly<Record<keyof TokenUsage, string>> = {
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  cacheReadTokens: 'cache_read_input_tokens',
  cacheWriteTokens: 'cache_creation_input_tokens',
};

/** Every counter, zero filled — what a completed non-streaming response reports. */
export function parseUsage(raw: unknown): TokenUsage {
  return { ...ZERO_USAGE, ...parsePartialUsage(raw) };
}

/**
 * Only the counters the payload actually carries. A stream reports usage twice — an opening
 * `message_start` and a closing `message_delta` — and zero filling the second would erase the
 * cache counters the first one carried, silently under-reporting spend.
 */
export function parsePartialUsage(raw: unknown): Partial<TokenUsage> {
  const record = asRecord(raw);
  if (record === undefined) return {};
  const usage: Partial<Record<keyof TokenUsage, number>> = {};
  for (const [field, wire] of Object.entries(USAGE_FIELDS) as [keyof TokenUsage, string][]) {
    const value = record[wire];
    if (typeof value === 'number') usage[field] = value;
  }
  return usage;
}

const STOP_REASONS: readonly StopReason[] = [
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
];

export function parseStopReason(raw: unknown): StopReason {
  return STOP_REASONS.find((reason) => reason === raw) ?? 'end_turn';
}

/**
 * The refusal detail, when the payload carries one. Populated ONLY on a refusal — every other
 * stop reason leaves it null — so a caller reading it unguarded reads null on the happy path.
 * `category` is passed through as written rather than matched against a union: it is an open
 * set, and a new category is information, not a parse failure.
 */
export function parseStopDetails(raw: unknown): StopDetails | undefined {
  const record = asRecord(raw);
  if (record === undefined || record['type'] !== 'refusal') return undefined;
  return {
    type: 'refusal',
    category: typeof record['category'] === 'string' ? record['category'] : undefined,
    explanation: typeof record['explanation'] === 'string' ? record['explanation'] : undefined,
  };
}

/**
 * In-band `error` events carry a type, not a status. Mapping them back to one keeps a single
 * retry rule in the gateway: an overloaded provider is retryable whether it says so with a
 * 529 on the handshake or with an `overloaded_error` frame ten tokens in.
 */
const ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

/**
 * A 200 whose body carries an `error` object instead of an answer, refused — how a gateway in
 * front of a model reports a fault it noticed after the headers were sent. Exported because the
 * non-streaming read needs the identical rule and the identical status table: the envelope arrives
 * on either transport, and one copy of the mapping is what keeps the gateway's retry decision the
 * same on both. The twin of `openai-wire.ts`'s.
 */
export function throwInBandError(payload: Record<string, unknown>): void {
  const error = asRecord(payload['error']);
  if (error === undefined) return;
  throw inBandFailure(error);
}

/**
 * A tool call's arguments, or `{}`. Never a cast: `input` is untrusted, so a string or an array
 * arriving under `Record<string, unknown>` is a type lie every later reader indexes into.
 */
export function asToolInput(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

interface PendingTool {
  readonly id: string;
  readonly name: string;
  json: string;
}

/** What the stream has accumulated so far. `cost` is applied by the provider that owns prices. */
export interface StreamState {
  readonly text: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly stopReason: StopReason;
  readonly stopDetails: StopDetails | undefined;
  readonly usage: TokenUsage;
}

/**
 * One streamed message, assembled frame by frame. Text and thinking are yielded as they land;
 * a tool call is not — its arguments arrive as `input_json_delta` fragments that are only
 * parseable once the block closes, so the call is emitted whole or not at all.
 */
export class MessageStream {
  private text = '';
  private readonly toolCalls: LlmToolCall[] = [];
  private stopReason: StopReason = 'end_turn';
  private stopDetails: StopDetails | undefined;
  private usage: TokenUsage = ZERO_USAGE;
  private readonly pending = new Map<number, PendingTool>();
  private stopped = false;

  /** Chunks this frame produced, in order. Unknown events yield nothing — the API adds them. */
  push(frame: SseFrame): readonly StreamChunk[] {
    const payload = this.payloadOf(frame);
    const type = typeof payload['type'] === 'string' ? payload['type'] : frame.event;
    switch (type) {
      case 'message_start':
        return this.onMessageStart(payload);
      case 'content_block_start':
        return this.onBlockStart(payload);
      case 'content_block_delta':
        return this.onBlockDelta(payload);
      case 'content_block_stop':
        return this.onBlockStop(payload);
      case 'message_delta':
        return this.onMessageDelta(payload);
      case 'message_stop':
        this.stopped = true;
        return [];
      case 'error':
        return this.onError(payload);
      default:
        return [];
    }
  }

  /** True once `message_stop` arrived. False means the connection died mid-answer. */
  isComplete(): boolean {
    return this.stopped;
  }

  state(): StreamState {
    return {
      text: this.text,
      toolCalls: [...this.toolCalls],
      // A refusal detail is a refusal whatever the stop reason says. `parseStopReason` answers
      // `end_turn` for a spelling this build has never seen, and every consumer branches on the
      // REASON, so the pair would read as a complete answer that happens to be empty.
      stopReason: this.stopDetails === undefined ? this.stopReason : 'refusal',
      stopDetails: this.stopDetails,
      usage: this.usage,
    };
  }

  private payloadOf(frame: SseFrame): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(frame.data);
      const record = asRecord(parsed);
      if (record === undefined) throw new SyntaxError('frame data is not an object');
      return record;
    } catch (error) {
      throw new AiTransportError({
        provider: 'anthropic',
        detail: `unreadable "${frame.event}" frame: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  private onMessageStart(payload: Record<string, unknown>): readonly StreamChunk[] {
    const message = asRecord(payload['message']);
    this.usage = { ...this.usage, ...parsePartialUsage(message?.['usage']) };
    return [];
  }

  private onBlockStart(payload: Record<string, unknown>): readonly StreamChunk[] {
    const block = asRecord(payload['content_block']);
    const index = asIndex(payload['index']);
    if (block === undefined || index === undefined) return [];
    if (block['type'] !== 'tool_use') return [];
    const id = typeof block['id'] === 'string' ? block['id'] : '';
    const name = typeof block['name'] === 'string' ? block['name'] : '';
    this.pending.set(index, { id, name, json: '' });
    return [];
  }

  private onBlockDelta(payload: Record<string, unknown>): readonly StreamChunk[] {
    const delta = asRecord(payload['delta']);
    if (delta === undefined) return [];
    const text = delta['text'];
    if (delta['type'] === 'text_delta' && typeof text === 'string') {
      this.text += text;
      return [{ type: 'text', text }];
    }
    const thinking = delta['thinking'];
    if (delta['type'] === 'thinking_delta' && typeof thinking === 'string') {
      // Deliberately NOT appended to `text`: thinking is not the answer, and a caller that
      // concatenated every chunk would otherwise ship the reasoning to the user.
      return [{ type: 'thinking', text: thinking }];
    }
    const partial = delta['partial_json'];
    const index = asIndex(payload['index']);
    if (
      delta['type'] === 'input_json_delta' &&
      typeof partial === 'string' &&
      index !== undefined
    ) {
      const tool = this.pending.get(index);
      if (tool !== undefined) tool.json += partial;
    }
    return [];
  }

  private onBlockStop(payload: Record<string, unknown>): readonly StreamChunk[] {
    const index = asIndex(payload['index']);
    if (index === undefined) return [];
    const tool = this.pending.get(index);
    if (tool === undefined) return [];
    this.pending.delete(index);
    const call: LlmToolCall = { id: tool.id, name: tool.name, input: this.inputOf(tool) };
    this.toolCalls.push(call);
    return [{ type: 'tool-call', call }];
  }

  /** A tool with no arguments streams no `input_json_delta` at all, which is `{}`, not a fault. */
  private inputOf(tool: PendingTool): Record<string, unknown> {
    if (tool.json === '') return {};
    try {
      return asToolInput(JSON.parse(tool.json));
    } catch (error) {
      throw new AiTransportError({
        provider: 'anthropic',
        detail: `tool "${tool.name}" streamed arguments that are not JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  private onMessageDelta(payload: Record<string, unknown>): readonly StreamChunk[] {
    const delta = asRecord(payload['delta']);
    if (delta !== undefined && delta['stop_reason'] !== null) {
      this.stopReason = parseStopReason(delta['stop_reason']);
      // A refusal mid-stream keeps whatever was already streamed, so the reason alone reads as
      // a complete answer that simply stopped. The detail is what says it is not one.
      this.stopDetails = parseStopDetails(delta['stop_details']);
    }
    this.usage = { ...this.usage, ...parsePartialUsage(payload['usage']) };
    return [];
  }

  /**
   * An `error` EVENT is a failure whether or not it carried a detail — the event type is itself
   * the report. A body has no such signal, which is why `throwInBandError` reads the object first.
   */
  private onError(payload: Record<string, unknown>): never {
    throw inBandFailure(asRecord(payload['error']) ?? {});
  }
}

function inBandFailure(error: Record<string, unknown>): AiTransportError {
  const type = typeof error['type'] === 'string' ? error['type'] : 'api_error';
  const message = typeof error['message'] === 'string' ? error['message'] : type;
  return new AiTransportError({
    provider: 'anthropic',
    status: ERROR_STATUS[type],
    detail: message,
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
