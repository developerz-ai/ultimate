// The `bare-error` guard `x new` ships: no shipped module throws a bare `Error`.
// `AGENTS.md` has always stated the rule and NOTHING enforced it — `throw new Error(...)` in a
// scaffolded `repo.ts` was green on `x verify`, and it reaches an agent as a stack trace with no
// code, no cause and nothing to run.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/**
 * Derived from the guard's name, never written as a literal — the same rule `x g guard` follows.
 * An `X_*` literal in framework source is a FRAMEWORK code: `error-catalog.test.ts` refuses one the
 * registry does not hold, and `wiki/Error-Codes.md` would owe it a row. The APP owns the codes its
 * own conventions raise, so this one is spelled by the file it lands in and nowhere else.
 */
const NAME = 'bare-error';
const CODE = guardCode(NAME);

const source =
  (): string => `// bare-error: a failure this app raises carries a code, a cause and an executable fix.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/**
 * A THROW, never a construction. \`new Error(…)\` handed to something as INPUT is legitimate — a
 * test fixture, an \`AbortSignal\` reason, a rejection this module is passing along — and only the
 * throw is this module stating its own verdict.
 */
const BARE_THROW = /\\bthrow\\s+new\\s+(Error|TypeError|RangeError|SyntaxError)\\s*\\(/g;

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

/** Comments blanked IN PLACE — not deleted — so a reported line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, (match) => match.replaceAll(/[^\\n]/g, ' '))
    .replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, (match) => ' '.repeat(match.length));

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function bareThrows(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    for (const match of text.matchAll(BARE_THROW)) {
      const line = lineOf(text, match.index);
      const thrown = match[1] ?? 'Error';
      findings.push({
        code: CODE,
        cause: \`\${file.path}:\${line} throws a bare \${thrown} — it reaches its reader as a stack trace with no code, no cause and nothing to run\`,
        fix: \`subclass UltimateError in \${file.path} with an X_SCREAMING_SNAKE code, a cause and a fix naming a command, then: x verify\`,
        at: file.path,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a failure carries a code, a cause and an executable fix — never a bare Error',
  async check(root) {
    const files: SourceFile[] = [];
    for await (const entry of new Bun.Glob('{apps,packages}/**/*.{ts,tsx}').scan({
      cwd: root,
      absolute: false,
    })) {
      const path = entry.split('\\\\').join('/');
      // A test states its verdict with \`expect.unreachable()\`, which the suite reports on its own
      // terms; \`node_modules\` is not this app's source.
      if (path.includes('node_modules/') || /\\.(?:test|d)\\.tsx?$/.test(path)) continue;
      files.push({ path, source: await Bun.file(\`\${root}/\${path}\`).text() });
    }
    return bareThrows(files);
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { bareThrows } from './bare-error';

const file = (source: string) => [{ path: 'apps/web/app/post/repo.ts', source }];

unitTest('a bare throw is refused, and the finding names the line', () => {
  const findings = bareThrows(file("const x = 1;\\nthrow new Error('no post');"));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.cause).toContain(':2');
});

unitTest('TypeError and RangeError are the same rule', () => {
  expect(bareThrows(file("throw new TypeError('x');"))).toHaveLength(1);
  expect(bareThrows(file("throw new RangeError('x');"))).toHaveLength(1);
});

unitTest('an UltimateError subclass is what the rule asks for', () => {
  expect(bareThrows(file('throw new PostError(missingPost(id));'))).toEqual([]);
});

unitTest('a bare Error that is INPUT is not a verdict', () => {
  expect(bareThrows(file("controller.abort(new Error('cancelled'));"))).toEqual([]);
  expect(bareThrows(file("// throw new Error('x');"))).toEqual([]);
});
`;

/** `guards/bare-error.ts` and its test. No index, no registry — the directory registers it. */
export const bareErrorGuardFiles = (): readonly GeneratedFile[] => [
  { path: 'guards/bare-error.ts', contents: source() },
  { path: 'guards/bare-error.test.ts', contents: test() },
];
