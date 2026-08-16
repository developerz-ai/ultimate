// Single responsibility: reading what an OpenAI-format endpoint sends back — one chat completion,
// and the SSE stream of the same answer arriving in pieces.
//
// Split from the provider for the reason wire.ts is: the assembler can then be driven frame by
// frame with no socket, which is the only way to cover a stream that arrives fragmented, out of
// order, or stops half way. An LLM response is untrusted input, so every field is parsed and
// nothing is cast.

import { AiTransportError } from './errors';
import type { StopDetails, StopReason, StreamChunk, TokenUsage } from './provider';
import type { SseFrame } from './sse';
import type { LlmToolCall } from './tools';

/**
 * What one answer amounts to. `usage` is optional and that is the format's fault, not a laxity:
 * a streamed answer reports usage only in a final chunk, and only when the request asked for it.
 * The provider decides what to do with an absent one — never this file, which reports what arrived.
 */
export interface ChatAnswer {
  readonly text: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly stopReason: StopReason;
  readonly stopDetails: StopDetails | undefined;
  readonly usage: TokenUsage | undefined;
}

const FINISH_REASONS: Readonly<Record<string, StopReason>> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  // The legacy name for the same event; LiteLLM and older self-hosted servers still send it.
  function_call: 'tool_use',
  content_filter: 'refusal',
};

/**
 * In-band error frames carry a type, not a status, and the gateway's retry rule reads a status.
 * Same mapping job as wire.ts's, over this format's own vocabulary.
 */
const ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  rate_limit_exceeded: 429,
  insufficient_quota: 429,
  server_error: 500,
  api_error: 500,
  overloaded_error: 503,
};

/** A finish reason this format knows, or `undefined` for `null` — which means "still going". */
export function parseFinishReason(raw: unknown): StopReason | undefined {
  return typeof raw === 'string' ? FINISH_REASONS[raw] : undefined;
}

/**
 * `usage`, or `undefined` when the payload carried none.
 *
 * `prompt_tokens` INCLUDES the cached prefix on this wire, where Anthropic's `input_tokens`
 * excludes it — so the cached half is subtracted out before it is reported as `cacheReadTokens`.
 * Left in place it would be billed twice: once at the full input rate and again at the cache rate.
 */
export function parseOpenAiUsage(raw: unknown): TokenUsage | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const prompt = numberOf(record['prompt_tokens']);
  const completion = numberOf(record['completion_tokens']);
  if (prompt === undefined && completion === undefined) return undefined;
  const cached = numberOf(asRecord(record['prompt_tokens_details'])?.['cached_tokens']) ?? 0;
  return {
    inputTokens: Math.max((prompt ?? 0) - cached, 0),
    // `completion_tokens` already contains `reasoning_tokens`; adding them is a double count.
    outputTokens: completion ?? 0,
    cacheReadTokens: cached,
    // Caching is automatic here and carries no write surcharge, so there is nothing to report.
    cacheWriteTokens: 0,
  };
}

/** One non-streamed chat completion. Refusal is read BEFORE anything else trusts the content. */
export function parseChatCompletion(raw: unknown, provider: string): ChatAnswer {
  const record = asRecord(raw);
  if (record === undefined) throw malformed(provider, 'the response body is not a JSON object');
  throwInBandError(record, provider);
  const choice = asRecord(Array.isArray(record['choices']) ? record['choices'][0] : undefined);
  if (choice === undefined) throw malformed(provider, 'the response carried no choices');
  const message = asRecord(choice['message']) ?? {};
  const refusal = typeof message['refusal'] === 'string' ? message['refusal'] : undefined;
  const finish = parseFinishReason(choice['finish_reason']);
  return {
    text: typeof message['content'] === 'string' ? message['content'] : '',
    toolCalls: parseToolCalls(message['tool_calls'], provider),
    // A refusal string is a refusal whatever the finish reason says: the field only ever appears
    // when the model declined, and `stop` beside it would read downstream as an empty answer.
    stopReason: refusal === undefined ? (finish ?? 'end_turn') : 'refusal',
    stopDetails: refusalDetails(finish, refusal),
    usage: parseOpenAiUsage(record['usage']),
  };
}

function refusalDetails(
  finish: StopReason | undefined,
  refusal: string | undefined,
): StopDetails | undefined {
  if (refusal !== undefined) return { type: 'refusal', category: 'refusal', explanation: refusal };
  if (finish !== 'refusal') return undefined;
  // `content_filter` is all the endpoint says. Carried as the category rather than dropped: it is
  // the only thing that distinguishes a policy stop from a model that chose not to answer.
  return { type: 'refusal', category: 'content_filter', explanation: undefined };
}

function parseToolCalls(raw: unknown, provider: string): readonly LlmToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: LlmToolCall[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const fn = asRecord(record?.['function']);
    if (record === undefined || fn === undefined) continue;
    const name = typeof fn['name'] === 'string' ? fn['name'] : '';
    if (name === '') continue;
    calls.push({
      id: typeof record['id'] === 'string' ? record['id'] : '',
      name,
      input: parseArguments(fn['arguments'], name, provider),
    });
  }
  return calls;
}

/** Arguments are a JSON string. A tool that takes none sends `''` or `'{}'`; neither is a fault. */
function parseArguments(raw: unknown, name: string, provider: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    return asRecord(JSON.parse(raw)) ?? {};
  } catch (error) {
    throw malformed(
      provider,
      `tool "${name}" returned arguments that are not JSON: ${
        error instanceof Error ? error.message : 'unreadable'
      }`,
    );
  }
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

/**
 * One streamed chat completion, assembled frame by frame.
 *
 * Two things this format does that the Anthropic one does not, and both are easy to get subtly
 * wrong: a tool call arrives FRAGMENTED and INDEXED — its id, its name and successive slices of its
 * arguments spread across chunks, keyed only by `tool_calls[].index` — and `usage` arrives once, in
 * a trailing chunk whose `choices` array is empty, long after the finish reason.
 */
export class ChatCompletionStream {
  private text = '';
  private refusal = '';
  private stopReason: StopReason = 'end_turn';
  private finished = false;
  private done = false;
  private usage: TokenUsage | undefined;
  private readonly pending = new Map<number, PendingCall>();
  private readonly toolCalls: LlmToolCall[] = [];
  private readonly provider: string;

  constructor(provider: string) {
    this.provider = provider;
  }

  /** Chunks this frame produced, in order. An unknown field yields nothing — the format grows. */
  push(frame: SseFrame): readonly StreamChunk[] {
    // The sentinel is not JSON, and parsing it is how a stream reader ends in a syntax error.
    if (frame.data.trim() === '[DONE]') {
      this.done = true;
      return [];
    }
    const payload = this.payloadOf(frame);
    throwInBandError(payload, this.provider);
    const usage = parseOpenAiUsage(payload['usage']);
    if (usage !== undefined) this.usage = usage;
    const choice = asRecord(Array.isArray(payload['choices']) ? payload['choices'][0] : undefined);
    if (choice === undefined) return [];
    const chunks = this.onDelta(asRecord(choice['delta']) ?? {});
    return [...chunks, ...this.onFinish(choice['finish_reason'])];
  }

  /** True once the answer is accounted for. False means the connection died mid-answer. */
  isComplete(): boolean {
    // Either sentinel counts. `[DONE]` is the format's own end marker, but plenty of servers in
    // the family close the socket straight after the finish-reason chunk — and a finish reason IS
    // the model saying why it stopped, which is the fact a truncated stream cannot produce.
    return this.done || this.finished;
  }

  /** What the stream accumulated. `cost` is applied by the provider, which owns prices. */
  state(): ChatAnswer {
    const details = this.refusalDetails();
    return {
      text: this.text,
      toolCalls: [...this.toolCalls],
      // A refusal that arrived as a `refusal` delta finishes with `stop`, so the reason alone would
      // read as a complete answer that happens to be empty.
      stopReason: details === undefined ? this.stopReason : 'refusal',
      stopDetails: details,
      usage: this.usage,
    };
  }

  private refusalDetails(): StopDetails | undefined {
    if (this.refusal !== '') {
      return { type: 'refusal', category: 'refusal', explanation: this.refusal };
    }
    return this.stopReason === 'refusal'
      ? { type: 'refusal', category: 'content_filter', explanation: undefined }
      : undefined;
  }

  private onDelta(delta: Record<string, unknown>): readonly StreamChunk[] {
    const chunks: StreamChunk[] = [];
    const content = delta['content'];
    if (typeof content === 'string' && content !== '') {
      this.text += content;
      chunks.push({ type: 'text', text: content });
    }
    // `reasoning_content` is vLLM's and DeepSeek's; `reasoning` is the OpenRouter spelling. Neither
    // is ever appended to `text`, for the reason thinking deltas are not: a consumer concatenating
    // every chunk must not end up shipping the reasoning to the user.
    const thinking = delta['reasoning_content'] ?? delta['reasoning'];
    if (typeof thinking === 'string' && thinking !== '') {
      chunks.push({ type: 'thinking', text: thinking });
    }
    const refusal = delta['refusal'];
    if (typeof refusal === 'string') this.refusal += refusal;
    this.accumulate(delta['tool_calls']);
    return chunks;
  }

  /**
   * Merge one chunk's tool-call fragments into the calls they belong to. `index` is the only key —
   * `id` and `name` arrive on the first fragment and are absent from every later one, so appending
   * by array position instead would build one call per chunk and lose every argument but the last.
   */
  private accumulate(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      const record = asRecord(entry);
      if (record === undefined) continue;
      const index = numberOf(record['index']) ?? 0;
      const call = this.pending.get(index) ?? { id: '', name: '', args: '' };
      const id = record['id'];
      if (typeof id === 'string' && id !== '') call.id = id;
      const fn = asRecord(record['function']);
      const name = fn?.['name'];
      // Concatenated, not assigned: a server that splits the name across two frames is rare and
      // legal, and assigning would keep only the tail.
      if (typeof name === 'string') call.name += name;
      const args = fn?.['arguments'];
      if (typeof args === 'string') call.args += args;
      this.pending.set(index, call);
    }
  }

  /**
   * The finish reason closes the turn, and it is the only close this format has: there is no
   * per-block stop event, so pending tool calls are emitted here — whole, in index order, exactly
   * as the Anthropic path emits them at `content_block_stop`. A fragment is never a call.
   */
  private onFinish(raw: unknown): readonly StreamChunk[] {
    const reason = parseFinishReason(raw);
    if (reason === undefined) return [];
    this.stopReason = reason;
    this.finished = true;
    const chunks: StreamChunk[] = [];
    for (const index of [...this.pending.keys()].sort((a, b) => a - b)) {
      const pending = this.pending.get(index);
      if (pending === undefined || pending.name === '') continue;
      const call: LlmToolCall = {
        id: pending.id,
        name: pending.name,
        input: parseArguments(pending.args, pending.name, this.provider),
      };
      this.toolCalls.push(call);
      chunks.push({ type: 'tool-call', call });
    }
    this.pending.clear();
    return chunks;
  }

  private payloadOf(frame: SseFrame): Record<string, unknown> {
    try {
      const record = asRecord(JSON.parse(frame.data));
      if (record === undefined) throw new SyntaxError('frame data is not an object');
      return record;
    } catch (error) {
      throw malformed(
        this.provider,
        `unreadable "${frame.event}" frame: ${
          error instanceof Error ? error.message : 'unreadable'
        }`,
      );
    }
  }
}

/**
 * A 200 that carries an `error` object instead of an answer — how a gateway in front of a model
 * reports a fault it noticed after the headers were sent. Parsed as a message it would read as an
 * empty, successful answer, which is the one outcome nothing downstream can detect.
 */
function throwInBandError(payload: Record<string, unknown>, provider: string): void {
  const error = asRecord(payload['error']);
  if (error === undefined) return;
  const type = typeof error['type'] === 'string' ? error['type'] : 'api_error';
  const code = typeof error['code'] === 'string' ? error['code'] : undefined;
  const message = typeof error['message'] === 'string' ? error['message'] : type;
  throw new AiTransportError({
    provider,
    status: ERROR_STATUS[type] ?? (code === undefined ? undefined : ERROR_STATUS[code]) ?? 500,
    detail: message,
  });
}

function malformed(provider: string, detail: string): AiTransportError {
  return new AiTransportError({ provider, detail });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
