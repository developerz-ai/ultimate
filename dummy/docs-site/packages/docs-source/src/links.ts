// Every markdown link in a text, outside fences and code spans, handed to a resolver that returns
// its new target. The resolver decides what a target means; this file only finds links and
// splices, so the one parse of link syntax is here and nowhere else.

import { fencedLines } from './fences';

/** Where a link sits, for a refusal that names the line to edit. */
export interface LinkAt {
  /** 0-based line within the text handed in. */
  readonly line: number;
  readonly target: string;
}

/** The new target, or `undefined` to leave the link as written. */
export type LinkResolver = (link: LinkAt) => string | undefined;

const isSpace = (char: string): boolean => char.trim() === '';

/** The first offset from `from` holding a space, a parenthesis, or the end of the line. */
function wordEnd(line: string, from: number): number {
  let end = from;
  while (end < line.length) {
    const char = line.charAt(end);
    if (char === '(' || char === ')' || isSpace(char)) break;
    end += 1;
  }
  return end;
}

/**
 * What follows `](` at `from`: the target, one level of parentheses inside it, an optional
 * `"title"`, then the `)`. Read by hand, each part stopping at the next parenthesis, space or
 * quote, so no input makes it look back. `undefined` when that is not what follows.
 */
function targetAt(line: string, from: number): string | undefined {
  let end = wordEnd(line, from);
  if (end === from) return undefined;
  if (line[end] === '(') {
    end = wordEnd(line, end + 1);
    if (line[end] !== ')') return undefined;
    end += 1;
  }
  let next = end;
  while (next < line.length && isSpace(line.charAt(next))) next += 1;
  if (next > end) {
    if (line[next] !== '"') return undefined;
    next = line.indexOf('"', next + 1);
    if (next < 0) return undefined;
    next += 1;
  }
  return line[next] === ')' ? line.slice(from, end) : undefined;
}

interface FoundLink {
  /** Offset of the `[` that opens the link's text. */
  readonly opener: number;
  /** Offset of the target. */
  readonly at: number;
  readonly target: string;
}

/**
 * `[text](target "title")` on a line, in order, in one pass: a stack pairs each `]` with its `[`,
 * so brackets may nest in the text (`[a [b]](c)`). A link inside another's text is that link's
 * text, as in the `[![badge](image)](target)` the wiki writes, so the outer one replaces it.
 */
function findLinks(line: string): readonly FoundLink[] {
  const open: number[] = [];
  const links: FoundLink[] = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '[') open.push(index);
    if (line[index] !== ']') continue;
    const opener = open.pop();
    if (opener === undefined || line[index + 1] !== '(') continue;
    const target = targetAt(line, index + 2);
    if (target === undefined) continue;
    while ((links.at(-1)?.opener ?? -1) > opener) links.pop();
    links.push({ opener, at: index + 2, target });
  }
  return links;
}

/**
 * The line with every code span blanked to `x`s of the same length. A span closes on the next run
 * of exactly its opener's length, and a run with no such closer is literal. Knowing each length's
 * last run means only a scan that will succeed is made, and it skips what it read: linear.
 */
function maskCodeSpans(line: string): string {
  const runs = [...line.matchAll(/`+/g)].map((run) => ({ at: run.index, size: run[0].length }));
  const lastOfSize = new Map(runs.map((run, index) => [run.size, index]));
  let out = '';
  let from = 0;
  for (let open = 0; open < runs.length; open += 1) {
    const opener = runs[open];
    if (opener === undefined || (lastOfSize.get(opener.size) ?? open) <= open) continue;
    let close = open + 1;
    while (runs[close]?.size !== opener.size) close += 1;
    const closer = runs[close];
    if (closer === undefined) continue;
    const end = closer.at + closer.size;
    out += line.slice(from, opener.at) + 'x'.repeat(end - opener.at);
    from = end;
    open = close;
  }
  return out + line.slice(from);
}

/**
 * Links found on the line with every code span blanked, so a bracket inside code opens nothing
 * while a link whose TEXT holds code (`[\`x verify\`](CLI-Reference)`) is still one link; the
 * splice is made on the line as written, at the same offsets.
 */
function rewriteLine(line: string, at: number, resolve: LinkResolver): string {
  const masked = maskCodeSpans(line);
  let out = '';
  let from = 0;
  for (const { at: targetAt, target } of findLinks(masked)) {
    const next = resolve({ line: at, target });
    if (next === undefined) continue;
    out += line.slice(from, targetAt) + next;
    from = targetAt + target.length;
  }
  return out + line.slice(from);
}

/** The text with every link outside code passed through `resolve`. */
export function rewriteLinks(markdown: string, resolve: LinkResolver): string {
  const lines = markdown.split('\n');
  const fenced = fencedLines(lines);
  return lines
    .map((line, index) => (fenced[index] === true ? line : rewriteLine(line, index, resolve)))
    .join('\n');
}
