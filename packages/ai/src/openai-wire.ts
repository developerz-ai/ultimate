// Single responsibility: reading what an OpenAI-format endpoint sends back — one chat completion,
// and the field readers its SSE stream (./openai-wire-stream) shares.
//
// Split from the provider for the reason wire.ts is: the assembler can then be driven frame by
// frame with no socket, which is the only way to cover a stream that arrives fragmented, out of
// order, or stops half way. An LLM response is untrusted input, so every field is parsed and
// nothing is cast.

import { AiTransportError } from './errors';
import type { StopDetails, StopReason, TokenUsage } from './provider';
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
export const settledAs = (calls: readonly LlmToolCall[]): StopReason =>
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

export interface ReadCalls {
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
export function collect(
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

/**
 * A 200 that carries an `error` object instead of an answer — how a gateway in front of a model
 * reports a fault it noticed after the headers were sent. Parsed as a message it would read as an
 * empty, successful answer, which is the one outcome nothing downstream can detect.
 */
export function throwInBandError(payload: Record<string, unknown>, provider: string): void {
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

export function malformed(provider: string, detail: string): AiTransportError {
  return new AiTransportError({ provider, detail });
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function numberOf(value: unknown): number | undefined {
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
