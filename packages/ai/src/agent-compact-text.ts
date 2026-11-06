// Single responsibility: the turns to summarise as TEXT, shortened oldest first until they fit —
// the summary call's input when the run's own messages up to the cut do not. Tool results are
// clipped to their start and end, then left out; a turn itself is never dropped. Where the design
// came from: `docs/history/ai.md`.

import type { AiContentBlock, AiMessage } from './provider';

/** The characters of one tool result a clipped turn keeps: half from its start, half from its end. */
export const SUMMARY_CLIP_CHARS = 2_000;

/** One turn's render at each shortening: whole, its tool results clipped, its tool results left out. */
type Renders = readonly [whole: string, clipped: string, omitted: string];

/** The transcript that fit, and how far it was shortened to. */
export interface TextTranscript {
  readonly text: string;
  /** Turns, oldest first, whose tool results were clipped or left out. */
  readonly clipped: number;
  /** ...of those, the turns whose tool results were left out entirely. */
  readonly omitted: number;
}

/**
 * `value` cut to `max` characters, the first and last halves kept — the end of a tool result is
 * where its error, its count or its last row is. By code point, so no surrogate pair is split.
 * Never longer than `value`: a cut that would add more marker than it removes is not made.
 */
export function clipText(value: string, max: number = SUMMARY_CLIP_CHARS): string {
  if (value.length <= max) return value;
  const chars = Array.from(value);
  const half = Math.floor(max / 2);
  const left = chars.length - 2 * half;
  if (left <= 0) return value;
  const clipped = `${chars.slice(0, half).join('')}\n[… ${left} characters left out …]\n${chars.slice(-half).join('')}`;
  return clipped.length < value.length ? clipped : value;
}

/**
 * The least shortening of `turns` (each an assistant message and the user message answering it)
 * that `fits`: every turn reaches a level before any turn reaches the next, oldest first.
 * `undefined` when even every tool result left out does not fit.
 */
export function shortestFit(
  turns: readonly (readonly AiMessage[])[],
  fits: (text: string) => boolean,
): TextTranscript | undefined {
  const renders = turns.map(rendersOf);
  const n = renders.length;
  // Shortening `s` (0..2n): turns before `s` clipped, turns before `s - n` left out. Each step
  // only ever shortens one turn, so the size falls with `s` and the least `s` that fits is found
  // by bisection — a handful of estimates, never one per turn.
  const at = (s: number): string =>
    renders.map((render, i) => render[(i < s ? 1 : 0) + (i < s - n ? 1 : 0)]).join('\n\n');
  if (!fits(at(2 * n))) return undefined;
  let low = 0;
  let high = 2 * n;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(at(mid))) high = mid;
    else low = mid + 1;
  }
  return { text: at(low), clipped: Math.min(low, n), omitted: Math.max(0, low - n) };
}

function rendersOf(turn: readonly AiMessage[]): Renders {
  const whole = render(turn, 0);
  // A level is never longer than the one before it, so the bisection above stays sound.
  const clipped = shorter(render(turn, 1), whole);
  return [whole, clipped, shorter(render(turn, 2), clipped)];
}

const shorter = (a: string, b: string): string => (a.length < b.length ? a : b);

const render = (turn: readonly AiMessage[], level: 0 | 1 | 2): string =>
  turn
    .flatMap((message) => blocksOf(message).map((block) => line(message.role, block, level)))
    .filter((text) => text !== '')
    .join('\n');

function line(role: AiMessage['role'], block: AiContentBlock, level: 0 | 1 | 2): string {
  if (block.type === 'text') return block.text === '' ? '' : `[${role}]: ${block.text}`;
  if (block.type === 'tool_use') {
    const input = JSON.stringify(block.input) ?? '';
    return `[tool call ${block.name} #${block.id}]: ${level === 2 ? clipText(input) : input}`;
  }
  if (block.type === 'tool_result') {
    const label = `${block.is_error === true ? 'tool error' : 'tool result'} #${block.tool_use_id}`;
    if (level === 2) return `[${label} left out: ${block.content.length} characters]`;
    return `[${label}]: ${level === 1 ? clipText(block.content) : block.content}`;
  }
  return `[${block.type} left out]`;
}

const blocksOf = (message: AiMessage): readonly AiContentBlock[] =>
  typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
