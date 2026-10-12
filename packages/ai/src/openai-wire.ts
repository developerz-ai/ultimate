// Single responsibility: reading what an OpenAI-format endpoint sends back — one chat completion,
// and the SSE stream of the same answer arriving in pieces.
//
// Split from the provider for the reason wire.ts is: the assembler can then be driven frame by
// frame with no socket, which is the only way to cover a stream that arrives fragmented, out of
// order, or stops half way. An LLM response is untrusted input, so every field is parsed and
// nothing is cast.

import { renderThrowable } from '@ultimat3/core';
import { AiTransportError } from './errors';
import type { StopDetails, StopReason, StreamChunk, TokenUsage } from './provider';
import type { SseFrame } from './sse';
import type { MalformedToolCall } from './tool-arguments';
import { parseToolArguments } from './tool-arguments';
import type { LlmToolCall } from './tools';

/**
 * What one answer amounts to. `usage` is optional and that is the format's fault, not a laxity:
 * a streamed answer reports usage only in a final chunk, and only when the request asked for it.
 * The provider decides what to do with an absent one — never this file, which reports what arrived.
 */
export interface ChatAnswer {
  readonly text: string;
  readonly toolCalls: readonly LlmToolCall[];
  /**
   * Calls whose arguments were not JSON. Never among `toolCalls` — a fragment is never a call —
   * and what they mean is the provider's decision (`assertToolArguments`), once usage is known.
   */
  readonly malformed: readonly MalformedToolCall[];
  readonly stopReason: StopReason;
  readonly stopDetails: StopDetails | undefined;
  readonly usage: TokenUsage | undefined;
  /** The raw finish reason when this build does not know it — `stopReason` is then read off the content. */
  readonly unknownFinish?: string;
}

// A `Map`, not an object literal: `raw` is the PROVIDER's string on every read, and
// `FINISH_REASONS['constructor']` on an object answers the `Object` FUNCTION — which
// `parseFinishReason` returned as a `StopReason`, and which the stream reader below then treated
// as a finish, so `isComplete()` answered true for a stream that never finished. Same fix core
// made in `error-retry.ts` for the same shape.
const FINISH_REASONS: ReadonlyMap<string, StopReason> = new Map(
  Object.entries({
    stop: 'end_turn',
    // Synonyms for "the model finished", as endpoints in the family spell it: the Messages API's
    // word passed through by a gateway, a tokenizer's end-of-sequence, Gemini's `STOP`.
    end_turn: 'end_turn',
    eos: 'end_turn',
    eos_token: 'end_turn',
    stop_sequence: 'stop_sequence',
    length: 'max_tokens',
    max_tokens: 'max_tokens',
    model_context_window_exceeded: 'model_context_window_exceeded',
    tool_calls: 'tool_use',
    // The legacy name for the same event; LiteLLM and older self-hosted servers still send it.
    function_call: 'tool_use',
    tool_use: 'tool_use',
    content_filter: 'refusal',
  } as const),
);

/** What a `finish_reason` field said: nothing yet, a reason this build knows, or one it does not. */
export type FinishReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'known'; readonly reason: StopReason }
  | { readonly kind: 'unknown'; readonly raw: string };

/**
 * Read a finish reason, case-insensitively (`STOP`, `MAX_TOKENS`). A non-string (`null` on a
 * delta) is "still going". A string this table does not list is UNKNOWN, and deliberately not
 * truncation: `llm()` and `agent()` refuse a truncated turn before reading it, so guessing
 * "cut off" fails every call of an endpoint that merely spells "done" its own way. What an unknown
 * reason amounts to is decided from the answer itself (`unknownFinishReason`), by the provider.
 */
export function readFinishReason(raw: unknown): FinishReading {
  if (typeof raw !== 'string') return { kind: 'none' };
  const reason = FINISH_REASONS.get(raw) ?? FINISH_REASONS.get(raw.toLowerCase());
  return reason === undefined ? { kind: 'unknown', raw } : { kind: 'known', reason };
}

/** The stop reason of a turn whose finish reason is unknown: what its content shows it to be. */
const settledAs = (calls: readonly LlmToolCall[]): StopReason =>
  calls.length > 0 ? 'tool_use' : 'end_turn';

/**
 * In-band error frames carry a type, not a status, and the gateway's retry rule reads a status.
 * Same mapping job as wire.ts's, over this format's own vocabulary.
 */
// A `Map`, for the reason `FINISH_REASONS` above is one: `type` is the provider's string, and a
// function where `AiTransportError.status` is declared `number | undefined` makes `isRetryable`
// answer false for a 429-class frame and interpolates JS source into the operator-facing `cause`.
const ERROR_STATUS: ReadonlyMap<string, number> = new Map(
  Object.entries({
    invalid_request_error: 400,
    authentication_error: 401,
    permission_error: 403,
    not_found_error: 404,
    rate_limit_exceeded: 429,
    insufficient_quota: 429,
    server_error: 500,
    api_error: 500,
    overloaded_error: 503,
  }),
);

/**
 * The finish reason as a `StopReason`, or `undefined` for a non-string. An UNKNOWN string reads
 * `end_turn` here — the bare lookup has no answer to judge it by; the two readers below do, and
 * report the raw reason as `unknownFinish` so the provider can refuse a turn that is not whole.
 */
export function parseFinishReason(raw: unknown): StopReason | undefined {
  const read = readFinishReason(raw);
  return read.kind === 'none' ? undefined : read.kind === 'known' ? read.reason : 'end_turn';
}

/**
 * `usage`, or `undefined` when the payload carried none.
 *
 * `prompt_tokens` is the WHOLE prompt on this wire — the part read from a cache and the part
 * written to one included — where Anthropic's `input_tokens` excludes both. So both are subtracted
 * out before they are reported under their own counters. Left in place a cached token would be
 * billed twice: once at the full input rate and again at the cache rate.
 *
 * `cache_write_tokens` is OpenRouter's (`prompt_tokens_details.cache_write_tokens`, "Number of
 * tokens written to the cache"), reported for a model whose vendor bills a write. An endpoint that
 * never sends it — OpenAI's own, where a write is free — reads as zero.
 */
export function parseOpenAiUsage(raw: unknown): TokenUsage | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const prompt = countOf(record['prompt_tokens']);
  const completion = countOf(record['completion_tokens']);
  if (prompt === undefined && completion === undefined) return undefined;
  const details = asRecord(record['prompt_tokens_details']);
  const total = prompt ?? 0;
  // Each clamped to what is left of the prompt: a counter larger than the prompt it is part of is
  // the endpoint's mistake, and an unclamped one bills tokens that were never sent.
  const cached = Math.min(countOf(details?.['cached_tokens']) ?? 0, total);
  const written = Math.min(countOf(details?.['cache_write_tokens']) ?? 0, total - cached);
  return {
    inputTokens: total - cached - written,
    // `completion_tokens` already contains `reasoning_tokens`; adding them is a double count.
    outputTokens: completion ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: written,
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
  // Non-empty, as the stream decides it: a gateway that always serialises the field sends
  // `"refusal": ""` beside a real answer, and that body must not refuse here and answer streamed.
  const declined = message['refusal'];
  const refusal = typeof declined === 'string' && declined !== '' ? declined : undefined;
  const read = parseToolCalls(message['tool_calls']);
  const reading = readFinishReason(choice['finish_reason']);
  const finish =
    reading.kind === 'none'
      ? undefined
      : reading.kind === 'known'
        ? reading.reason
        : settledAs(read.calls);
  return {
    text: typeof message['content'] === 'string' ? message['content'] : '',
    toolCalls: read.calls,
    malformed: read.malformed,
    // A refusal string is a refusal whatever the finish reason says: the field only ever appears
    // when the model declined, and `stop` beside it would read downstream as an empty answer.
    stopReason: refusal === undefined ? (finish ?? 'end_turn') : 'refusal',
    stopDetails: refusalDetails(finish, refusal),
    usage: parseOpenAiUsage(record['usage']),
    ...(reading.kind === 'unknown' ? { unknownFinish: reading.raw } : {}),
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

interface ReadCalls {
  readonly calls: LlmToolCall[];
  readonly malformed: MalformedToolCall[];
}

function parseToolCalls(raw: unknown): ReadCalls {
  const read: ReadCalls = { calls: [], malformed: [] };
  if (!Array.isArray(raw)) return read;
  for (const entry of raw) {
    const record = asRecord(entry);
    const fn = asRecord(record?.['function']);
    if (record === undefined || fn === undefined) continue;
    const name = typeof fn['name'] === 'string' ? fn['name'] : '';
    if (name === '') continue;
    const args = fn['arguments'];
    collect(read, typeof record['id'] === 'string' ? record['id'] : '', name, args);
  }
  return read;
}

/** One call, read: among the calls when its arguments parse, among the malformed when not. */
function collect(
  read: ReadCalls,
  id: string,
  name: string,
  args: unknown,
): LlmToolCall | undefined {
  const raw = typeof args === 'string' ? args : '';
  const input = parseToolArguments(raw);
  if (input === undefined) {
    read.malformed.push({ name, chars: raw.length });
    return undefined;
  }
  const call: LlmToolCall = { id, name, input };
  read.calls.push(call);
  return call;
}

interface PendingCall {
  /** Where the call sorts among its turn's: the wire's `index`, else its order of arrival. */
  readonly index: number;
  id: string;
  name: string;
  args: string;
  /** A second NAMED fragment arrived with no index and no id: two calls, indistinguishable. */
  unkeyed?: boolean;
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
  private unknownFinish: string | undefined;
  private finished = false;
  private done = false;
  private usage: TokenUsage | undefined;
  /** Every open call, in order of arrival; `byIndex` is which one a wire index currently means. */
  private readonly pending: PendingCall[] = [];
  private readonly byIndex = new Map<number, PendingCall>();
  private readonly read: ReadCalls = { calls: [], malformed: [] };
  private readonly provider: string;

  constructor(provider: string) {
    this.provider = provider;
  }

  /** Chunks this frame produced, in order. An unknown field yields nothing — the format grows. */
  push(frame: SseFrame): readonly StreamChunk[] {
    // The sentinel is not JSON, and parsing it is how a stream reader ends in a syntax error.
    if (frame.data.trim() === '[DONE]') {
      this.done = true;
      return this.end();
    }
    const payload = this.payloadOf(frame);
    throwInBandError(payload, this.provider);
    const usage = parseOpenAiUsage(payload['usage']);
    if (usage !== undefined) this.usage = usage;
    const choice = asRecord(Array.isArray(payload['choices']) ? payload['choices'][0] : undefined);
    if (choice === undefined) return [];
    const chunks = this.onDelta(asRecord(choice['delta']) ?? {});
    this.onFinish(choice['finish_reason']);
    return chunks;
  }

  /**
   * The stream is over: the calls a finished turn made, whole, in index order. Called by the
   * provider when the socket closes, and by `[DONE]` — whichever comes first; the second is empty.
   *
   * Here, and not when the finish reason arrives: this format has no per-call stop event, and
   * nothing in it orders the finish reason against the last argument fragment — a call read at the
   * reason is read half way whenever a gateway sends the reason first. A turn with no finish
   * reason drains nothing: its fragments stay open, and `isComplete()` refuses the stream.
   */
  end(): readonly StreamChunk[] {
    if (!this.finished) return [];
    const chunks: StreamChunk[] = [];
    for (const pending of this.pending.splice(0).sort((a, b) => a.index - b.index)) {
      if (pending.name === '') continue;
      if (pending.unkeyed === true) {
        // Deliberate: merged arguments are never parsed, even when they happen to be JSON.
        this.read.malformed.push({ name: pending.name, chars: pending.args.length, unkeyed: true });
        continue;
      }
      const call = collect(this.read, pending.id, pending.name, pending.args);
      if (call !== undefined) chunks.push({ type: 'tool-call', call });
    }
    this.byIndex.clear();
    return chunks;
  }

  /** True once the answer is accounted for. False means the connection died mid-answer. */
  isComplete(): boolean {
    // Either sentinel counts. `[DONE]` is the format's own end marker, but plenty of servers in
    // the family close the socket straight after the finish-reason chunk — and a finish reason IS
    // the model saying why it stopped, which is the fact a truncated stream cannot produce.
    //
    // One exception, and it is REFUSAL rather than a flush: `[DONE]` while tool-call fragments are
    // still open. This format has no per-call stop event, so the finish reason is the only thing
    // that ever closes a call and `onFinish` is the only drain of `pending` — which means `[DONE]`
    // alone cannot tell "the model finished asking" from "the connection died mid-arguments".
    // Reporting complete discarded a whole tool call and answered an empty, successful `end_turn`;
    // emitting the fragments anyway would run a tool's side effects from arguments that may be
    // half a JSON object, and would report `end_turn` for a turn that stopped to call one. So the
    // stream is refused exactly as the Anthropic half refuses a missing `message_stop`
    // (`provider.ts`), and `openai-provider.ts`'s existing truncation guard is what raises it.
    return this.finished || (this.done && this.pending.length === 0);
  }

  /** What the stream accumulated. `cost` is applied by the provider, which owns prices. */
  state(): ChatAnswer {
    // Idempotent, so a reader that never called `end()` still sees a finished turn's calls.
    this.end();
    const details = this.refusalDetails();
    return {
      text: this.text,
      toolCalls: [...this.read.calls],
      malformed: [...this.read.malformed],
      // A refusal that arrived as a `refusal` delta finishes with `stop`, so the reason alone would
      // read as a complete answer that happens to be empty.
      stopReason:
        details !== undefined
          ? 'refusal'
          : this.unknownFinish === undefined
            ? this.stopReason
            : settledAs(this.read.calls),
      stopDetails: details,
      usage: this.usage,
      ...(this.unknownFinish === undefined ? {} : { unknownFinish: this.unknownFinish }),
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
   * Merge one chunk's tool-call fragments into the calls they belong to. `index` is the key —
   * `id` and `name` arrive on the first fragment and are absent from every later one, so appending
   * by array position instead would build one call per chunk and lose every argument but the last.
   *
   * It is not the WHOLE key. A gateway translating another vendor's stream may number every call
   * of a turn `0` (or send no index) and tell them apart by id alone; merged by index, two
   * well-formed calls became one string — `{…}{…}` — that is not JSON. So a fragment carrying an id
   * that is not the open call's starts a new call. An id repeated on every fragment, or absent
   * from all but the first, is still one call.
   */
  private accumulate(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      const record = asRecord(entry);
      if (record === undefined) continue;
      const index = numberOf(record['index']);
      const rawId = record['id'];
      const id = typeof rawId === 'string' && rawId !== '' ? rawId : undefined;
      let call = index === undefined ? this.pending.at(-1) : this.byIndex.get(index);
      if (call === undefined || (id !== undefined && call.id !== '' && call.id !== id)) {
        call = { index: index ?? this.pending.length, id: '', name: '', args: '' };
        this.pending.push(call);
      }
      if (index !== undefined) this.byIndex.set(index, call);
      if (id !== undefined) call.id = id;
      const fn = asRecord(record['function']);
      const name = fn?.['name'];
      // No index, no id, and a tool NAMED again after arguments already arrived: a second call
      // this stream gives no way to tell from the first. A name split across frames arrives
      // before any argument, so that legal case is not this one.
      if (
        index === undefined &&
        id === undefined &&
        call.args !== '' &&
        name !== undefined &&
        name !== ''
      ) {
        call.unkeyed = true;
      }
      // Concatenated, not assigned: a server that splits the name across two frames is rare and
      // legal, and assigning would keep only the tail.
      if (typeof name === 'string') call.name += name;
      const args = fn?.['arguments'];
      if (typeof args === 'string') call.args += args;
    }
  }

  /** The finish reason closes the TURN. The calls are read by `end()`, when the stream is over. */
  private onFinish(raw: unknown): void {
    const reading = readFinishReason(raw);
    if (reading.kind === 'none') return;
    if (reading.kind === 'known') this.stopReason = reading.reason;
    else this.unknownFinish = reading.raw;
    this.finished = true;
  }

  private payloadOf(frame: SseFrame): Record<string, unknown> {
    try {
      const record = asRecord(JSON.parse(frame.data));
      if (record === undefined) throw new SyntaxError('frame data is not an object');
      return record;
    } catch (error) {
      throw malformed(
        this.provider,
        `unreadable "${frame.event}" frame: ${renderThrowable(error)}`,
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
    status:
      ERROR_STATUS.get(type) ?? (code === undefined ? undefined : ERROR_STATUS.get(code)) ?? 500,
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

/**
 * A token count, floored at zero. Usage is the PROVIDER's number and a proxy in front of one can
 * send anything: a negative count becomes a negative `cost`, and `MemoryBudgetStore.add` takes a
 * negative debit as a credit deliberately (releasing an unspent reservation IS one) — so an
 * unclamped `-1` here does not under-report spend, it TOPS THE LEDGER UP. Twin of `wire.ts`'s.
 */
function countOf(value: unknown): number | undefined {
  const count = numberOf(value);
  return count === undefined ? undefined : Math.max(0, count);
}
