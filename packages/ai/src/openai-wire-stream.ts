// Single responsibility: one streamed OpenAI-format chat completion, assembled frame by frame —
// fragmented, indexed tool calls and the trailing usage chunk. Split from ./openai-wire (the
// non-streamed answer and the field readers both share) at its line ceiling.

import { renderThrowable } from '@ultimat3/core';
import type { ChatAnswer, ReadCalls } from './openai-wire';
import {
  asRecord,
  collect,
  malformed,
  numberOf,
  parseOpenAiUsage,
  readFinishReason,
  settledAs,
  throwInBandError,
} from './openai-wire';
import type { StopDetails, StopReason, StreamChunk, TokenUsage } from './provider';
import type { SseFrame } from './sse';

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
    const where = `unreadable "${frame.event}" frame`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch (error) {
      throw malformed(this.provider, `${where}: ${renderThrowable(error)}`);
    }
    const record = asRecord(parsed);
    // The same coded refusal the catch above produces, thrown where the frame is known: a bare
    // `SyntaxError` in shipped source carries no code, no cause and no fix.
    if (record === undefined) {
      throw malformed(this.provider, `${where}: frame data is not an object`);
    }
    return record;
  }
}
