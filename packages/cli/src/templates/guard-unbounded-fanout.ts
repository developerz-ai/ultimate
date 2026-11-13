// The `unbounded-fanout` guard `x new` ships: a database call per element of a list runs through
// `mapBounded` with a stated width, never `Promise.all` over the whole list at once. Three adopters
// hand-rolled the pool this replaces; the list a table grows to is what makes the shape a defect.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'unbounded-fanout';
const CODE = guardCode(NAME);

const source =
  (): string => `// unbounded-fanout: a database call per row runs a bounded number at a time, never all at once.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Why: \`Promise.all(rows.map(async (row) => db…))\` opens one statement per row AT ONCE. Ten rows
// is fine; the ten thousand a table grows to is ten thousand statements queued on a pool of ten,
// every other request waiting behind them. \`mapBounded\` from \`@ultimat3/core\` is the same map with
// a stated width, results in input order, and the first failure stops the rest.
// Read: a \`Promise.all(\` or \`Promise.allSettled(\` over \`<list>.map(async …)\` whose callback names
// \`db\`, \`tx\` or \`repo\`, anywhere under apps/ and packages/ but a test. Not read: an array literal,
// which is bounded where it is written. Admitted: a \`// why:\` on the line or the line above it.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const ALL = /\\bPromise\\s*\\.\\s*all(?:Settled)?\\s*\\(/g;
const MAPPED = /\\.\\s*map\\s*\\(\\s*async\\b/;
const DATABASE = /\\b(?:db|tx|repo)\\s*[.(]/;
const WHY = /\\/\\/\\s*why:/;

/** Comments and string bodies blanked IN PLACE, so a line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, (match) => match.replaceAll(/[^\\n]/g, ' '))
    .replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, (match) => ' '.repeat(match.length))
    .replaceAll(/'(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|\`(?:[^\`\\\\]|\\\\.)*\`/g, (match) =>
      match.replaceAll(/[^\\n]/g, ' '),
    );

/** The text between the \`(\` at \`open\` and the \`)\` that closes it. */
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
    const lines = file.source.split('\\n');
    const text = blank(file.source);
    for (const match of text.matchAll(ALL)) {
      const argument = argumentAt(text, match.index + match[0].length - 1);
      const mapped = argument.search(MAPPED);
      const list = argument.slice(0, Math.max(mapped, 0)).trim().replaceAll(/\\s+/g, ' ');
      // An array literal is as long as the line that writes it; a list read from anywhere is not.
      if (mapped < 1 || list.startsWith('[') || !DATABASE.test(argument)) continue;
      const line = text.slice(0, match.index).split('\\n').length;
      if (WHY.test(lines[line - 1] ?? '') || WHY.test(lines[line - 2] ?? '')) continue;
      const at = \`\${file.path}:\${line}\`;
      findings.push({
        code: CODE,
        cause: \`\${at} starts a database call for every element of \${list} at once — as many statements in flight as the list is long, queued on a pool a fraction of that size\`,
        fix: \`mapBounded(\${list}, <the same async callback>, { width: 8 }) — from @ultimat3/core, in place of the Promise.all at \${at}, the width what the pool can take — or a // why: comment on that line naming the list's bound — then: x verify\`,
        at,
      });
    }
  }
  return findings;
}

/** Every source file but a test: a fixture's fan-out is over the rows it planted. */
export const readsFile = (path: string): boolean => !/\\.test\\.tsx?$/.test(path);

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
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { readsFile, unboundedFanouts } from './unbounded-fanout';

const file = (source: string) => [{ path: 'apps/web/app/posts/service.ts', source }];

unitTest('a database call per row, all at once, is refused at its line', () => {
  const source =
    'const a = 1;\\nawait Promise.all(rows.map(async (row) => db.posts.update(row.id, row)));';
  const findings = unboundedFanouts(file(source));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.at).toBe('apps/web/app/posts/service.ts:2');
  expect(findings[0]?.fix).toStartWith('mapBounded(rows, <the same async callback>, { width: 8 })');
});

unitTest('allSettled, a tx, a repo and a chained list are the same rule', () => {
  const settled = 'Promise.allSettled(ids.map(async (id) => tx.posts.delete(id)));';
  expect(unboundedFanouts(file(settled))).toHaveLength(1);
  const chained =
    'Promise.all(\\n  rows\\n    .filter((row) => row.ok)\\n    .map(async (row) => repo.byId(row.id)),\\n);';
  expect(unboundedFanouts(file(chained))[0]?.cause).toContain('rows .filter((row) => row.ok)');
});

unitTest('an array literal, a map with no database call and a why: are not refused', () => {
  const literal = 'Promise.all([a, b].map(async (one) => db.posts.byId(one)));';
  expect(unboundedFanouts(file(literal))).toEqual([]);
  expect(unboundedFanouts(file('Promise.all(urls.map(async (url) => hash(url)));'))).toEqual([]);
  const why = '// why: at most three locales\\nPromise.all(locales.map(async (l) => db.t.byId(l)));';
  expect(unboundedFanouts(file(why))).toEqual([]);
});

unitTest('a comment and a string naming the shape are not code', () => {
  expect(unboundedFanouts(file('// Promise.all(rows.map(async (r) => db.x(r)))'))).toEqual([]);
  expect(
    unboundedFanouts(file("const s = 'Promise.all(rows.map(async (r) => db.x(r)))';")),
  ).toEqual([]);
});

unitTest('every source file is read but a test', () => {
  expect(readsFile('apps/web/app/posts/service.ts')).toBe(true);
  expect(readsFile('packages/domain/src/rules.ts')).toBe(true);
  expect(readsFile('apps/web/app/posts/service.test.ts')).toBe(false);
});
`;

/** `guards/unbounded-fanout.ts` and its test. No index, no registry — the directory registers it. */
export const unboundedFanoutGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
