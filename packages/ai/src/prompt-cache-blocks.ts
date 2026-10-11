// Single responsibility: the Anthropic Messages wire's half of prompt caching — `system` as text
// blocks, and `cache_control` on the blocks ./prompt-cache's `blocks` rule names. Pure, so the body
// a test asserts is the body the socket gets.

import type { SystemPrompt } from './prompt-cache';
import { CACHE_MARK, systemParts } from './prompt-cache';
import type { AiMessage } from './provider';

type Marked<T> = T & { readonly cache_control?: typeof CACHE_MARK };
type TextBlock = Marked<{ readonly type: 'text'; readonly text: string }>;

/** How many trailing messages carry a mark. With the system block: three of the four breakpoints. */
const MARKED_TAIL = 2;

/**
 * `system`, as the wire takes it. A plain string with no mark stays the string every existing
 * request sent. Otherwise blocks, the stable one FIRST and the only one marked: it is the half
 * other runs share, and the per-run half after it is covered by the transcript's own marks.
 * An empty part is dropped — an empty text block is a 400, and a mark on one is too.
 */
export function anthropicSystem(
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
 * The transcript, with the last block of the last two messages marked. The tail is what the NEXT
 * request reads back; the one before it gives the lookup a second start, so a turn that appended
 * more than the 20 blocks one breakpoint looks back over still finds the previous turn's entry.
 */
export function anthropicMessages(
  messages: readonly AiMessage[],
  marked: boolean,
): readonly { readonly role: AiMessage['role']; readonly content: unknown }[] {
  const from = marked ? messages.length - MARKED_TAIL : messages.length;
  return messages.map((message, index) => ({
    role: message.role,
    content: index >= from ? markedContent(message.content) : message.content,
  }));
}

function markedContent(content: AiMessage['content']): unknown {
  if (typeof content === 'string') {
    // An empty text block cannot be marked (or sent); the string goes as it stood.
    return content === '' ? content : [{ type: 'text', text: content, cache_control: CACHE_MARK }];
  }
  const last = content.length - 1;
  return content.map((block, index) =>
    index === last ? { ...block, cache_control: CACHE_MARK } : block,
  );
}
