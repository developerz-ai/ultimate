// Single responsibility: the ONE request a compaction's summary call sends. The run's own request
// up to the cut, plus the instruction, when that fits the writer — it reads the cached prefix.
// Otherwise the same tools, system and first message, then the turns to summarise as TEXT,
// shortened oldest first (./agent-compact-text) — never a second call, never a dropped turn.

import { shortestFit } from './agent-compact-text';
import type { ModelId } from './models';
import type { AiContentBlock, AiMessage, GenerateRequest } from './provider';

/** How a compacted first message's summary block starts — the marker a later compaction reads. */
export const COMPACTED_MARK = '[compacted:';

/** What the summary call is asked, appended to the last message it is sent. */
export const SUMMARY_INSTRUCTION = `${COMPACTED_MARK} instruction] This conversation is about to be shortened to fit the context window: everything after the task in the first message, any earlier summary included, will be replaced by the summary you write now. Summarise it for yourself — what you did, every tool you called and what it returned (keep exact ids, numbers, names and quotes you will still need), what you concluded, and what remains to do. Do not call any tool. Reply with the summary as plain text only.`;

/** Opens the text form's transcript block: what it is, and that it may have been shortened. */
export const TRANSCRIPT_NOTE = `${COMPACTED_MARK} transcript] The turns after the task, oldest first, as text: they did not fit as messages. The oldest tool results may be clipped (their start and end kept) or left out — say so in the summary where it matters.`;

/** The turns before the cut, split off the first message and the kept ones. */
export interface SummarySplit {
  /** The first user message: the rendered prompt, and any earlier summary. */
  readonly head: AiMessage;
  /** Whole turns — an assistant message and the user message answering it — oldest first. */
  readonly older: readonly AiMessage[];
}

/** How the summarised turns reached the summary call. */
export type SummaryInput =
  | { readonly form: 'messages' }
  | { readonly form: 'text'; readonly clipped: number; readonly omitted: number };

export interface SummaryCall {
  readonly request: GenerateRequest;
  readonly input: SummaryInput;
}

/**
 * The summary call for `split`: as messages when `fits` takes them, else as text shortened until
 * it does. `undefined` when even every tool result left out does not fit.
 */
export function summaryCall(
  base: GenerateRequest,
  writer: ModelId,
  maxTokens: number,
  split: SummarySplit,
  fits: (request: GenerateRequest) => boolean,
): SummaryCall | undefined {
  const asMessages = writerRequest(base, writer, maxTokens, withInstruction(split));
  if (fits(asMessages)) return { request: asMessages, input: { form: 'messages' } };
  const asText = (transcript: string): GenerateRequest =>
    writerRequest(base, writer, maxTokens, textForm(split.head, transcript));
  const fit = shortestFit(pairsOf(split.older), (text) => fits(asText(text)));
  if (fit === undefined) return undefined;
  const { clipped, omitted } = fit;
  return { request: asText(fit.text), input: { form: 'text', clipped, omitted } };
}

/**
 * The run's own tools, system and cache hint, so the provider reads the prefix the run wrote. A
 * different summary model takes none of the run model's reasoning controls: one it lacks would be
 * `X_AI_REQUEST_INVALID`.
 */
function writerRequest(
  base: GenerateRequest,
  writer: ModelId,
  maxTokens: number,
  messages: readonly AiMessage[],
): GenerateRequest {
  if (writer === base.model) return { ...base, messages, maxTokens };
  const { effort: _effort, thinking: _thinking, ...rest } = base;
  return { ...rest, model: writer, messages, maxTokens };
}

/** Roles must alternate, and the older turns end on a user message: the instruction joins it. */
function withInstruction(split: SummarySplit): readonly AiMessage[] {
  const messages = [split.head, ...split.older];
  const last = messages.at(-1) ?? split.head;
  return [...messages.slice(0, -1), { role: 'user', content: [...blocksOf(last), instruction()] }];
}

/** The first message as it was sent — its bytes, its cache — then the transcript, then the ask. */
function textForm(head: AiMessage, transcript: string): readonly AiMessage[] {
  const block = { type: 'text' as const, text: `${TRANSCRIPT_NOTE}\n\n${transcript}` };
  return [{ role: 'user', content: [...blocksOf(head), block, instruction()] }];
}

const instruction = (): AiContentBlock => ({ type: 'text', text: SUMMARY_INSTRUCTION });

/** The older turns, two messages each: the cut is between turns, so they pair exactly. */
function pairsOf(older: readonly AiMessage[]): readonly (readonly AiMessage[])[] {
  const pairs: AiMessage[][] = [];
  for (let i = 0; i < older.length; i += 2) pairs.push(older.slice(i, i + 2));
  return pairs;
}

export function blocksOf(message: AiMessage): readonly AiContentBlock[] {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content;
}
