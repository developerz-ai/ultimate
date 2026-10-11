// Single responsibility: the Anthropic Messages wire's half of prompt caching — `system` as text
// blocks, and `cache_control` on the blocks ./prompt-cache's `blocks` rule names. Pure, so the body
// a test asserts is the body the socket gets.

import type { SystemPrompt } from './prompt-cache';
import { CACHE_MARK, systemParts } from './prompt-cache';
import type { AiMessage, GenerateRequest } from './provider';

type Marked<T> = T & { readonly cache_control?: typeof CACHE_MARK };
type TextBlock = Marked<{ readonly type: 'text'; readonly text: string }>;
type WireMessage = { readonly role: AiMessage['role']; readonly content: unknown };

/** The vendor's ceiling on breakpoints in one request; a fifth is a 400. */
const MAX_BREAKPOINTS = 4;

/** An empty or whitespace-only text block cannot carry a mark (and is a 400 with one). */
const blank = (text: string): boolean => text.trim() === '';

export interface AnthropicPrompt {
  readonly system: string | readonly TextBlock[] | undefined;
  readonly messages: readonly WireMessage[];
}

/**
 * `system` and `messages` as the wire takes them. Unmarked, a string system stays the string every
 * existing request sent and the messages pass through untouched.
 *
 * Marked, at most three breakpoints, spent in this order: the transcript's TAIL (what the next
 * request reads back), the stable system block (what other runs share), then the message before
 * the tail (a second start for the 20-block lookback). Marks the caller already placed — a raw
 * block or tool carrying its own `cache_control` — count against the four first, so this never
 * turns a legal request into a 400; ours are the ones dropped.
 */
export function anthropicPrompt(request: GenerateRequest, marked: boolean): AnthropicPrompt {
  const { messages } = request;
  if (!marked) {
    return { system: systemOf(request.system, false), messages: messages.map(plain) };
  }
  let left = MAX_BREAKPOINTS - placedBy(request);
  const take = (wanted: boolean): boolean => {
    if (!wanted || left <= 0) return false;
    left -= 1;
    return true;
  };
  const tail = messages.length - 1;
  const markTail = take(tail >= 0 && markableAt(messages[tail]) !== undefined);
  const markSystem = take(!blank(systemParts(request.system).stable));
  const markPrevious = take(tail >= 1 && markableAt(messages[tail - 1]) !== undefined);
  return {
    system: systemOf(request.system, markSystem),
    messages: messages.map((message, index) =>
      (index === tail && markTail) || (index === tail - 1 && markPrevious)
        ? { role: message.role, content: markedContent(message.content) }
        : plain(message),
    ),
  };
}

const plain = (message: AiMessage): WireMessage => ({
  role: message.role,
  content: message.content,
});

/** The stable block first and the only one marked; an empty part is dropped, never sent. */
function systemOf(
  system: SystemPrompt | undefined,
  marked: boolean,
): string | readonly TextBlock[] | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string' && !marked) return system;
  const { stable, run } = systemParts(system);
  const blocks: TextBlock[] = [];
  if (stable !== '') {
    blocks.push({ type: 'text', text: stable, ...(marked ? { cache_control: CACHE_MARK } : {}) });
  }
  if (run !== '') blocks.push({ type: 'text', text: run });
  return blocks.length === 0 ? undefined : blocks;
}

/**
 * Where one message's mark goes: its LAST block that is not blank text, so the mark moves back
 * past a trailing empty block rather than landing on it. `undefined` when no block can carry one.
 */
function markableAt(message: AiMessage | undefined): number | undefined {
  if (message === undefined) return undefined;
  const { content } = message;
  if (typeof content === 'string') return blank(content) ? undefined : 0;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (block !== undefined && !(block.type === 'text' && blank(block.text))) return index;
  }
  return undefined;
}

function markedContent(content: AiMessage['content']): unknown {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, cache_control: CACHE_MARK }];
  }
  const at = markableAt({ role: 'user', content });
  return content.map((block, index) =>
    index === at ? { ...block, cache_control: CACHE_MARK } : block,
  );
}

/** Breakpoints the caller placed itself: the types do not offer the field, a cast still sends it. */
function placedBy(request: GenerateRequest): number {
  const carries = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && Object.hasOwn(value, 'cache_control');
  let count = (request.tools ?? []).filter(carries).length;
  for (const { content } of request.messages) {
    if (typeof content !== 'string') count += content.filter(carries).length;
  }
  return count;
}
