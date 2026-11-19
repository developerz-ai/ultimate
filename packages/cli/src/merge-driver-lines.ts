// The registry half of `x merge-driver`: conflicts that are only "both sides ADDED here" keep both.
// Not `merge=union`, which also keeps a line one side deleted (a revoked grant in `roles.ts` comes
// back) and splices multi-line entries together. A conflict touching an existing line stays one.

import { maskOf } from './source-list-edit';

export const OURS_MARKER = '<<<<<<< ours';
const BASE_MARKER = '||||||| base';
const SPLIT_MARKER = '=======';
const THEIRS_MARKER = '>>>>>>> theirs';

export interface LineMerge {
  readonly text: string;
  /** The conflicts left in `text`, each still between its markers. */
  readonly conflicts: number;
}

const indentOf = (line: string): number => /^[ \t]*/.exec(line)?.[0].length ?? 0;

const depthOf = (masked: string): number => {
  let depth = 0;
  for (const ch of masked) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
  }
  return depth;
};

/** Brackets balanced and the last code a `,` or `;`: nothing a neighbour could be spliced into. */
const isWhole = (lines: readonly string[]): boolean => {
  const masked = maskOf(lines.join('\n')).trimEnd();
  return depthOf(masked) === 0 && /[,;]$/.test(masked);
};

/**
 * The added lines as whole entries — an entry starts at the block's own indent and runs until it
 * is complete, so `foo: {`…`},` is one and a comment joins what it precedes. `undefined` when they
 * do not divide that way: such a hunk is not a list of additions.
 */
function entriesOf(lines: readonly string[]): readonly string[] | undefined {
  if (lines.some((line) => line.trim() === '')) return undefined;
  const indent = Math.min(...lines.map(indentOf));
  const entries: string[][] = [];
  for (const line of lines) {
    const last = entries.at(-1);
    if (last === undefined || (indentOf(line) === indent && isWhole(last))) entries.push([line]);
    else last.push(line);
  }
  return entries.every(isWhole) ? entries.map((entry) => entry.join('\n')) : undefined;
}

const SPECIFIER = /\bfrom\s+'([^']+)';\s*$/;

/** What may appear once: an import's binding or module, an object entry's key. */
function identityOf(entry: string): string | undefined {
  const code = entry.trimStart();
  if (code.startsWith('import ')) {
    const namespace = /^import \* as ([\w$]+)/.exec(code)?.[1];
    return namespace === undefined ? `from:${SPECIFIER.exec(code)?.[1]}` : `as:${namespace}`;
  }
  const key = /^(?:([\w$]+)|'([^']+)'|"([^"]+)")\s*:/.exec(code);
  return key === null ? undefined : `key:${key[1] ?? key[2] ?? key[3]}`;
}

const sortKeyOf = (entry: string): string => SPECIFIER.exec(entry)?.[1] ?? entry.trimStart();

/**
 * Both sides' entries, each once, in one order. Sorted so that merging A into B and B into A write
 * the same bytes, and so an import block stays in the order Biome requires. `undefined` when the
 * two sides declare one name differently, which is a real conflict.
 */
function bothSides(ours: readonly string[], theirs: readonly string[]): string[] | undefined {
  const left = entriesOf(ours);
  const right = entriesOf(theirs);
  if (left === undefined || right === undefined) return undefined;
  const entries = [...new Set([...left, ...right])];
  const identities = entries.flatMap((entry) => identityOf(entry) ?? []);
  if (new Set(identities).size !== identities.length) return undefined;
  return entries
    .sort((a, b) => {
      const [x, y] = [sortKeyOf(a), sortKeyOf(b)];
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .flatMap((entry) => entry.split('\n'));
}

/** `text` — `git merge-file --diff3 -L ours -L base -L theirs` output — with additions resolved. */
export function resolveAdditions(text: string): LineMerge {
  const lines = text.split('\n');
  const out: string[] = [];
  let conflicts = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line !== OURS_MARKER) {
      out.push(line);
      continue;
    }
    const baseAt = lines.indexOf(BASE_MARKER, index);
    const splitAt = lines.indexOf(SPLIT_MARKER, baseAt);
    const endAt = lines.indexOf(THEIRS_MARKER, splitAt);
    if (baseAt === -1 || splitAt === -1 || endAt === -1) {
      out.push(line);
      continue;
    }
    const merged =
      splitAt === baseAt + 1
        ? bothSides(lines.slice(index + 1, baseAt), lines.slice(splitAt + 1, endAt))
        : undefined;
    if (merged === undefined) conflicts += 1;
    out.push(...(merged ?? lines.slice(index, endAt + 1)));
    index = endAt;
  }
  return { text: out.join('\n'), conflicts };
}
