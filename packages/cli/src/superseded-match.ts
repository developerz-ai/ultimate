// The superseded-workaround matcher, pure over one file's text: its comment blocks, and which
// table rows one of them names (`superseded.ts`). No I/O — `doctor-superseded.ts` walks the app.

import type { SupersededWorkaround } from './superseded';
import { NEAR_LINES } from './superseded';

/** Consecutive comment lines, joined: a note wrapped over three lines is one sentence. */
export interface CommentBlock {
  /** 1-based, inclusive. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface SupersededHit {
  readonly id: string;
  /** `path:line` of the note's first line. */
  readonly at: string;
}

const WHOLE = /^(?:\/\/+|\/\*+|\*+\/?|\{\/\*+)\s?(.*)$/;
const TAIL = /\s\/\/\s(.*)$/;

/** A whole-line comment's text, or the tail after a trailing ` // `; `undefined` for code. */
function commentText(line: string): string | undefined {
  const whole = WHOLE.exec(line.trim());
  if (whole !== null) return whole[1] ?? '';
  return TAIL.exec(line)?.[1];
}

/** The code on a line: nothing for a whole-line comment, the head before a trailing ` // `. */
function codePart(line: string): string {
  if (WHOLE.test(line.trim())) return '';
  const tail = TAIL.exec(line);
  return tail === null ? line : line.slice(0, tail.index);
}

/** Markdown is prose throughout: each paragraph is a block. Code reads its comments only. */
export function commentBlocks(path: string, text: string): readonly CommentBlock[] {
  const prose = path.endsWith('.md');
  const lines = text.split(/\r?\n/);
  const blocks: CommentBlock[] = [];
  let open: { start: number; parts: string[] } | undefined;
  const close = (end: number): void => {
    if (open !== undefined) blocks.push({ start: open.start, end, text: open.parts.join(' ') });
    open = undefined;
  };
  lines.forEach((line, index) => {
    const part = prose ? (line.trim() === '' ? undefined : line.trim()) : commentText(line);
    if (part === undefined) {
      close(index);
      return;
    }
    if (open === undefined) open = { start: index + 1, parts: [] };
    open.parts.push(part);
  });
  close(lines.length);
  return blocks;
}

/** Every row a block of `text` names, once per block, in file order. */
export function matchSuperseded(
  path: string,
  text: string,
  rows: readonly SupersededWorkaround[],
): readonly SupersededHit[] {
  const prose = path.endsWith('.md');
  const blocks = commentBlocks(path, text);
  const lines = text.split(/\r?\n/);
  const hits: SupersededHit[] = [];
  for (const block of blocks) {
    for (const row of rows) {
      if (!row.pattern.comment.every((pattern) => pattern.test(block.text))) continue;
      const near = row.pattern.near;
      if (near !== undefined) {
        // Prose has no code to stand beside: a page quoting the workaround is not holding it.
        if (prose) continue;
        const from = Math.max(0, block.start - 1 - NEAR_LINES);
        const window = lines.slice(from, block.end + NEAR_LINES);
        // Code only: a note quoting `render: 'ssr'` is not the page declaring it.
        if (!window.some((line) => near.test(codePart(line)))) continue;
      }
      hits.push({ id: row.id, at: `${path}:${block.start}` });
    }
  }
  return hits;
}
