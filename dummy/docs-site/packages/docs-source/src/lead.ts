// The first prose line of a piece, as plain text: the meta description, the search snippet. A
// heading, a fence, a table or a list marker is not a lead; a piece with none is refused upstream.

import { DESCRIPTION_MAX_LENGTH } from '@ultimat3/seo';
import { fencedLines } from './fences';

const NOT_PROSE = /^\s*(#|\||<|---|\*\*\*|```|~~~)/;
/** The lead is the meta description, so it is cut where the `seo` gate would refuse it. */
const MAX_LEAD = DESCRIPTION_MAX_LENGTH - 1;

/** Markdown syntax off one line: links to their text, code and emphasis marks dropped. */
export const plainText = (line: string): string =>
  line
    .replace(/!?\[((?:[^[\]]|\[[^\]]*\])*)\]\([^)]*\)/g, '$1')
    .replaceAll('`', '')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    // An underscore is emphasis only at a word's edge: `X_DB_DRIFT` keeps every one of its own.
    .replace(/(?<![\p{L}\p{N}])_{1,3}([^_]+)_{1,3}(?![\p{L}\p{N}])/gu, '$1')
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

/** `text` cut to `max` characters at a word, with an ellipsis; unchanged when it fits. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).trimEnd()}…`;
}

/** The first sentence of the first prose line, capped at a word boundary; empty when none. */
export function leadOf(markdown: string): string {
  const lines = markdown.split('\n');
  const fenced = fencedLines(lines);
  const line = lines.find(
    (text, index) => fenced[index] !== true && text.trim().length > 0 && !NOT_PROSE.test(text),
  );
  if (line === undefined) return '';
  const text = plainText(line);
  return clipText(/^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text, MAX_LEAD);
}
