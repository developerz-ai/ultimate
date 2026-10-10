// Adding an entry to an array literal in a file the app owns, read off the MASKED source. Every
// generator that grows a list — a role's `grants`, `definePermissions([…])`, a `defineApi` list —
// found its `]` with `indexOf` and its entries with a quote regex, so an apostrophe in a comment
// was a string delimiter and a `]` in one closed the list: `x g entity` rewrote a role map's
// comments into permissions. Here a comment and a literal's contents are never read as code, and
// an edit that does not read back as "the same list plus the new entries" is refused, not written.

import { maskLiterals, stripComments } from '@ultimat3/core';
import { wrapList } from './templates/wrap';

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

/** One top-level entry of a bracketed list: where its code starts and ends, and its exact text. */
export interface ListEntry {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A bracketed list as written: the bracket pair and every top-level entry between them. */
export interface SourceList {
  /** Index of the opening bracket. */
  readonly open: number;
  /** Index of the bracket that closes it. */
  readonly close: number;
  readonly entries: readonly ListEntry[];
  /** Whether a comma follows the last entry. */
  readonly trailingComma: boolean;
}

/** `maskLiterals(source)`, spelled here so every caller of this module reads one mask. */
export const maskOf = (source: string): string => maskLiterals(source);

/**
 * Index of the bracket closing the one at `open`, or -1 when nothing closes it. `masked` is
 * `maskOf(source)`: a bracket in a comment, a string or a regex is a space there.
 */
export function closingBracket(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    const ch = masked[index] as string;
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * The list whose opening bracket is at `open` — an array's `[` or an object's `{` — split at its
 * own commas. `undefined` when the bracket never closes. An entry's span is its CODE: a comment
 * above or beside it belongs to nobody, which is what lets an edit leave every comment alone.
 */
export function readList(source: string, masked: string, open: number): SourceList | undefined {
  const close = closingBracket(masked, open);
  if (close === -1) return undefined;
  const entries: ListEntry[] = [];
  let trailingComma = false;
  const push = (from: number, to: number, comma: boolean): void => {
    let start = from;
    let end = to;
    while (start < end && /\s/.test(masked[start] as string)) start += 1;
    while (end > start && /\s/.test(masked[end - 1] as string)) end -= 1;
    if (start < end) {
      entries.push({ start, end, text: source.slice(start, end) });
      trailingComma = comma;
    }
  };
  let depth = 0;
  let from = open + 1;
  for (let index = open + 1; index < close; index += 1) {
    const ch = masked[index] as string;
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      push(from, index, true);
      from = index + 1;
    }
  }
  push(from, close, false);
  return { open, close, entries, trailingComma };
}

/** What a plain string literal holds, or `undefined` for any other expression. */
const QUOTED = /^(['"`])((?:(?!\1)[^\\$\n])*)\1$/;
export const literalValue = (text: string): string | undefined => QUOTED.exec(text)?.[2];

/** Two entries are the same when their text is, or when both are literals of one value. */
const sameEntry = (left: string, right: string): boolean =>
  left === right ||
  (literalValue(left) !== undefined && literalValue(left) === literalValue(right));

/** The entries of `wanted` the list does not hold yet, each once. */
export function absentFrom(list: SourceList, wanted: readonly string[]): readonly string[] {
  const absent: string[] = [];
  for (const entry of wanted) {
    const held = [...list.entries.map((one) => one.text), ...absent];
    if (!held.some((text) => sameEntry(text, entry))) absent.push(entry);
  }
  return absent;
}

const leadingSpace = (text: string): string => /^[ \t]*/.exec(text)?.[0] ?? '';

/** A list that holds no comment: re-wrapped whole, on one line when it fits and a row each when not. */
function rewrapped(source: string, list: SourceList, entries: readonly string[]): string {
  const lineStart = source.lastIndexOf('\n', list.open) + 1;
  const newline = source.indexOf('\n', list.close);
  const lineEnd = newline === -1 ? source.length : newline;
  const head = source.slice(lineStart, list.open + 1);
  const indent = leadingSpace(head);
  const all = [...list.entries.map((entry) => entry.text), ...entries];
  const line = wrapList(indent, head.slice(indent.length), all, source.slice(list.close, lineEnd));
  return `${source.slice(0, lineStart)}${line}${source.slice(lineEnd)}`;
}

/** A list over several lines: the new entries are INSERTED, and no existing byte moves. */
function inserted(source: string, list: SourceList, entries: readonly string[]): string {
  const closeLine = source.lastIndexOf('\n', list.close) + 1;
  const beforeClose = source.slice(closeLine, list.close);
  const last = list.entries.at(-1);
  if (beforeClose.trim() !== '') {
    // The closing bracket shares its line with code: the entries go right before it.
    const lead = last === undefined ? '' : list.trailingComma ? ' ' : ', ';
    return `${source.slice(0, list.close)}${lead}${entries.join(', ')}${source.slice(list.close)}`;
  }
  // The comma the last entry owes, placed right after its code — before any comment beside it.
  const comma = last !== undefined && !list.trailingComma ? last.end : undefined;
  const before = source.slice(0, closeLine);
  const head = comma === undefined ? before : `${before.slice(0, comma)},${before.slice(comma)}`;
  const first = list.entries[0];
  const firstLine = first === undefined ? -1 : source.lastIndexOf('\n', first.start) + 1;
  // An entry's own indent where one starts its line; else one step in from the closing bracket.
  const indent =
    first !== undefined && source.slice(firstLine, first.start).trim() === ''
      ? source.slice(firstLine, first.start)
      : `${beforeClose}  `;
  const rows = entries.map((entry) => `${indent}${entry},\n`).join('');
  return `${head}${rows}${source.slice(closeLine)}`;
}

/**
 * `source` with `wanted` added to the list opening at `open`, or `undefined` when that cannot be
 * done safely — the caller then reports the edit instead of making it.
 *
 * A list that holds NO comment is re-wrapped the way Biome prints it — on one line while it fits,
 * a row per entry once it does not — because a formatter would move it there anyway and the app's
 * own `lint` step reads the difference. A list with a comment in it, or with an entry that spans
 * rows, gains rows before its closing bracket and nothing else changes: every comment, every
 * literal and every byte outside the insertion is the author's.
 *
 * The result is READ BACK before it is answered: the list must hold exactly what it held plus the
 * new entries, and the text before and after it must be untouched. A shape this reasoning is wrong
 * about fails that check here, never in the app.
 */
export function appendToList(
  source: string,
  open: number,
  wanted: readonly string[],
): string | undefined {
  const masked = maskOf(source);
  const list = readList(source, masked, open);
  if (list === undefined) return undefined;
  const entries = absentFrom(list, wanted);
  if (entries.length === 0) return source;
  const span = source.slice(list.open, list.close + 1);
  const commented = stripComments(source).slice(list.open, list.close + 1) !== span;
  const simple = list.entries.every((entry) => !entry.text.includes('\n'));
  const next =
    !commented && simple ? rewrapped(source, list, entries) : inserted(source, list, entries);
  // Read back: same prefix, same suffix, the old entries then the new ones.
  const reread = readList(next, maskOf(next), open);
  const expected = [...list.entries.map((entry) => entry.text), ...entries];
  if (
    reread === undefined ||
    next.slice(0, open) !== source.slice(0, open) ||
    next.slice(reread.close) !== source.slice(list.close) ||
    reread.entries.length !== expected.length ||
    reread.entries.some((entry, index) => entry.text !== expected[index])
  ) {
    return undefined;
  }
  return next;
}

/** One `key: value` of an object literal, located on the masked text. */
export interface SourceProperty {
  readonly key: string;
  /** Index of the first character of the value. */
  readonly value: number;
}

/**
 * The `key: value` properties of the object opening at `open`. A shorthand, a spread, a method
 * and a computed key are not `key: value` and are not answered.
 */
export function readProperties(
  source: string,
  masked: string,
  open: number,
): readonly SourceProperty[] {
  const list = readList(source, masked, open);
  if (list === undefined) return [];
  return list.entries.flatMap((entry) => {
    const colon = /^(?:[A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:/.exec(
      masked.slice(entry.start, entry.end),
    );
    if (colon === null) return [];
    const raw = source.slice(entry.start, entry.start + colon[0].length - 1).trim();
    let value = entry.start + colon[0].length;
    while (value < entry.end && /\s/.test(masked[value] as string)) value += 1;
    return [{ key: literalValue(raw) ?? raw, value }];
  });
}
