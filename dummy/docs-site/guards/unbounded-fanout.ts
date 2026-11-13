// unbounded-fanout: a database call per row runs a bounded number at a time, never all at once.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Why: `Promise.all(rows.map(async (row) => db…))` opens one statement per row AT ONCE. Ten rows
// is fine; the ten thousand a table grows to is ten thousand statements queued on a pool of ten,
// every other request waiting behind them. `mapBounded` from `@ultimat3/core` is the same map with
// a stated width, results in input order, and the first failure stops the rest.
// Read: a `Promise.all(` or `Promise.allSettled(` over `<list>.map(async …)` whose callback names
// `db`, `tx` or `repo`, anywhere under apps/ and packages/ but a test. Not read: an array literal,
// which is bounded where it is written. Admitted: a `// why:` on the line or the line above it.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_UNBOUNDED_FANOUT';

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const ALL = /\bPromise\s*\.\s*all(?:Settled)?\s*\(/g;
const MAPPED = /\.\s*map\s*\(\s*async\b/;
const DATABASE = /\b(?:db|tx|repo)\s*[.(]/;
const WHY = /\/\/\s*why:/;

/** Comments and string bodies blanked IN PLACE, so a line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//g, (match) => match.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/(?<![:\w])\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
    .replaceAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (match) =>
      match.replaceAll(/[^\n]/g, ' '),
    );

/** The text between the `(` at `open` and the `)` that closes it. */
const argumentAt = (text: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (depth === 0) return text.slice(open + 1, index);
  }
  return text.slice(open + 1);
};

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function unboundedFanouts(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const lines = file.source.split('\n');
    const text = blank(file.source);
    for (const match of text.matchAll(ALL)) {
      const argument = argumentAt(text, match.index + match[0].length - 1);
      const mapped = argument.search(MAPPED);
      const list = argument.slice(0, Math.max(mapped, 0)).trim().replaceAll(/\s+/g, ' ');
      // An array literal is as long as the line that writes it; a list read from anywhere is not.
      if (mapped < 1 || list.startsWith('[') || !DATABASE.test(argument)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      if (WHY.test(lines[line - 1] ?? '') || WHY.test(lines[line - 2] ?? '')) continue;
      const at = `${file.path}:${line}`;
      findings.push({
        code: CODE,
        cause: `${at} starts a database call for every element of ${list} at once — as many statements in flight as the list is long, queued on a pool a fraction of that size`,
        fix: `mapBounded(${list}, <the same async callback>, { width: 8 }) — from @ultimat3/core, in place of the Promise.all at ${at}, the width what the pool can take — or a // why: comment on that line naming the list's bound — then: x verify`,
        at,
      });
    }
  }
  return findings;
}

/** Every source file but a test: a fixture's fan-out is over the rows it planted. */
export const readsFile = (path: string): boolean => !/\.test\.tsx?$/.test(path);

export const guard: Guard = {
  summary: 'a database call per row runs through mapBounded, never Promise.all over the list',
  async check(_root, sources) {
    // The run's ONE read of the source: every guard asking for this glob shares the walk.
    const code = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return unboundedFanouts(
      code
        .filter((file) => readsFile(file.path))
        .map((file) => ({ path: file.path, source: file.text })),
    );
  },
};
