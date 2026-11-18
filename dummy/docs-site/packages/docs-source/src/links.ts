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

// `[text](target "title")`, one level of brackets inside the text (`[`x`]` and `[a [b]]` both
// occur in the wiki), and one level of parentheses inside the target.
const LINK = /(!?\[(?:[^[\]]|\[[^\]]*\])*\]\()([^()\s]+(?:\([^()\s]*\))?)((?:\s+"[^"]*")?\))/g;

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
  for (const match of masked.matchAll(LINK)) {
    const open = match[1] ?? '';
    const target = match[2] ?? '';
    const next = resolve({ line: at, target });
    if (next === undefined) continue;
    const targetAt = match.index + open.length;
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
