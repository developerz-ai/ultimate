// The source half of the parked-break list: every comment in `packages/*/src` that promises a
// removal at the next major (an `@deprecated` naming it, or any comment naming a later major) must
// be a `PARKED_BREAKS` row's `removes`, so the list stays the one record of what `next` deletes.

import type { Finding } from './log';
import type { ParkedBreak, RemovedSymbol } from './next-breaks-list';
import { isTestPath } from './source-scan';

const LIST = 'scripts/lib/next-breaks-list.ts';

/** A comment promising a removal; `symbol` is the declaration below it, when one is. */
export interface TagSite {
  readonly path: string;
  readonly line: number;
  readonly symbol: string | undefined;
}

const NAMED =
  /^\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
/** A property (`name?: T`) or a method signature (`name(args): T` / `name(args) {`), never a call. */
const MEMBER = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/;
const METHOD = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*[:{]/;
/** A `N.0.0` that is a release, not part of a prerelease or an address. */
const MAJOR = /(?<![\d.])(\d+)\.0\.0(?!\d|\.\d|-)/g;

/** The name the line declares, or undefined when it declares nothing. */
const declared = (line: string): string | undefined => {
  const named = NAMED.exec(line)?.[1];
  if (named !== undefined) return named;
  if (/^\s*(?:return|await|if|for|while|switch|case|throw)\b/.test(line)) return undefined;
  return MEMBER.exec(line)?.[1] ?? METHOD.exec(line)?.[1];
};

/** Whether a comment's text promises a removal at a major later than `currentMajor`. */
const promises = (text: string, currentMajor: number): boolean =>
  [...text.matchAll(MAJOR)].some((match) => Number(match[1]) > currentMajor) ||
  (/@deprecated\b/.test(text) && /\bnext major\b/i.test(text));

const isComment = (line: string): boolean => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/** Every comment in `text` that promises a removal at the next major, with the line it sits on. */
export function parkedTagsIn(path: string, text: string, currentMajor: number): readonly TagSite[] {
  const lines = text.split('\n');
  const sites: TagSite[] = [];
  let index = 0;
  while (index < lines.length) {
    const start = index;
    const first = lines[index] ?? '';
    if (/^\s*\/\*/.test(first)) {
      while (index < lines.length && !(lines[index] ?? '').includes('*/')) index += 1;
    } else if (/^\s*\/\//.test(first)) {
      while (index + 1 < lines.length && /^\s*\/\//.test(lines[index + 1] ?? '')) index += 1;
    } else {
      index += 1;
      continue;
    }
    const block = lines.slice(start, index + 1);
    index += 1;
    if (!promises(block.join('\n'), currentMajor)) continue;
    const later = block.findIndex((line) =>
      [...line.matchAll(MAJOR)].some((match) => Number(match[1]) > currentMajor),
    );
    const offset = later === -1 ? block.findIndex((line) => /@deprecated\b/.test(line)) : later;
    let next = index;
    while (next < lines.length && (lines[next] ?? '').trim() === '') next += 1;
    const below = lines[next];
    const symbol = below === undefined || isComment(below) ? undefined : declared(below);
    sites.push({ path, line: start + Math.max(offset, 0) + 1, symbol });
  }
  return sites;
}

/** The 1-based line declaring `symbol`, or undefined when no line does. */
export const declarationLine = (text: string, symbol: string): number | undefined => {
  const index = text.split('\n').findIndex((line) => declared(line) === symbol);
  return index === -1 ? undefined : index + 1;
};

const listed = (list: readonly ParkedBreak[]): readonly RemovedSymbol[] =>
  list.flatMap((parked) => parked.removes ?? []);

const listLine = (listText: string): number =>
  listText.split('\n').findIndex((text) => text.includes('export const PARKED_BREAKS')) + 1 || 1;

/** A finding per site no row's `removes` names at that file and symbol. */
export function unparkedTags(
  sites: readonly TagSite[],
  list: readonly ParkedBreak[],
  listText = '',
): readonly Finding[] {
  const removes = listed(list);
  return sites.flatMap(({ path, line, symbol }): Finding[] => {
    const at = `${path}:${line}`;
    if (symbol === undefined) {
      return [
        {
          code: 'X_NEXT_BREAK_UNPARKED',
          cause: `${at} promises a removal at the next major above no declaration, so no parked-break row can name what it removes`,
          fix: `bun run scripts/next-breaks.ts --json   # once the comment at ${at} sits on the declaration it retires`,
          at,
        },
      ];
    }
    if (removes.some((removed) => removed.path === path && removed.symbol === symbol)) return [];
    return [
      {
        code: 'X_NEXT_BREAK_UNPARKED',
        cause: `${at} promises \`${symbol}\` goes at the next major, and no row of the parked-break list removes it, so the \`next\` tracking issue omits it`,
        fix: `edit ${LIST}:${listLine(listText)} — add removes: [{ path: '${path}', symbol: '${symbol}' }] to the row for this break, or a new row with its ids, title, change and that removal`,
        at,
      },
    ];
  });
}

/** Each listed removal with no tag at its file and symbol: its `@deprecated` is still owed. */
export const untaggedRemovals = (
  sites: readonly TagSite[],
  list: readonly ParkedBreak[],
): readonly RemovedSymbol[] =>
  listed(list).filter(
    (removed) =>
      !sites.some((site) => site.path === removed.path && site.symbol === removed.symbol),
  );

/** Every tag site under `packages/*\/src`, tests excluded, in path order. */
export async function scanParkedTags(root: string, currentMajor: number): Promise<TagSite[]> {
  const paths = [...new Bun.Glob('packages/*/src/**/*.{ts,tsx}').scanSync({ cwd: root })]
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => !isTestPath(path))
    .sort();
  const sites: TagSite[] = [];
  for (const path of paths) {
    const text = await Bun.file(`${root}/${path}`).text();
    if (text.includes('.0.0') || text.includes('@deprecated')) {
      sites.push(...parkedTagsIn(path, text, currentMajor));
    }
  }
  return sites;
}
