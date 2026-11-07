// A piece before its links are rewritten: lines that remember which wiki line each came from, so
// a dead link names `wiki/<file>:<line>` even after a split moved it to another page.

import { type WikiHeading, wikiHeadings } from '@ultimat3/manifest';
import type { PieceHeading } from './types';

/** One line of a piece and the 0-based wiki line it came from. */
export interface DraftLine {
  readonly text: string;
  readonly origin: number;
}

export interface Draft {
  readonly url: string;
  readonly file: string;
  readonly title: string;
  readonly lines: readonly DraftLine[];
}

/** Lines `from` up to `to` of a page, each carrying its own index. */
export const linesOf = (all: readonly string[], from: number, to: number): DraftLine[] =>
  all.slice(from, to).map((text, offset) => ({ text, origin: from + offset }));

/** The section a heading opens: up to the next heading at its level or above, or the end. */
export function sectionEnd(
  headings: readonly WikiHeading[],
  index: number,
  lineCount: number,
): number {
  const start = headings[index];
  if (start === undefined) return lineCount;
  const next = headings.slice(index + 1).find((heading) => heading.level <= start.level);
  return next?.line ?? lineCount;
}

/**
 * The headings a draft renders with, under ITS anchors, and the wiki anchor each one had on the
 * whole page. They differ after a split: GitHub numbers a repeated `### Removed` across all of
 * `Upgrading.md`, and the major page that carries one copy numbers it from zero.
 */
export function draftHeadings(
  draft: Draft,
  page: readonly WikiHeading[],
): readonly (PieceHeading & { readonly wiki: string })[] {
  const local = wikiHeadings(draft.lines.map((line) => line.text).join('\n'));
  return local.map((heading) => {
    const origin = draft.lines[heading.line]?.origin;
    const wiki = page.find((one) => one.line === origin)?.anchor ?? heading.anchor;
    return { level: heading.level, text: heading.heading, anchor: heading.anchor, wiki };
  });
}
