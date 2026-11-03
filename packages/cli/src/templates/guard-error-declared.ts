// The `error-declared` guard `x new` ships: an app code is declared with `defineError`, never a
// handwritten `UltimateError` subclass or a literal-coded `new UltimateError`. Those forms take a
// title, a status and a class in three places, and nothing made the status get written — so the
// reference app's "post not found" answered 500, hid its cause and paged the error monitor.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'error-declared';
const CODE = guardCode(NAME);

const source =
  (): string => `// error-declared: an app code is declared once, with defineError — its title, its status and its class.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Known limits, both read by nothing short of a type checker: an alias by assignment
// (const Base = UltimateError) and a shorthand key whose value is a literal elsewhere
// (const code = 'X_NOT_FOUND'; new UltimateError({ code, … })).

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/** Every import of core — the barrel or its page subpath: a named list (an alias) or a namespace. */
const NAMED_IMPORT =
  /\\bimport\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]@ultimat3\\/core(?:\\/page)?['"]/g;
const NAMESPACE_IMPORT =
  /\\bimport\\s+\\*\\s+as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['"]@ultimat3\\/core(?:\\/page)?['"]/g;
const ALIAS = /^\\s*UltimateError\\s+as\\s+([A-Za-z_$][\\w$]*)\\s*$/;

/** A literal code as the object's own key — bare or quoted — read where the walk below stands. */
const LITERAL_CODE = /^(?:code|'code'|"code")\\s*:\\s*['"\`]/;

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

/** The names UltimateError goes by in this file: its own, an alias, or a namespace's member. */
const classNames = (text: string): readonly string[] => {
  const names = ['UltimateError'];
  for (const match of text.matchAll(NAMED_IMPORT)) {
    for (const part of (match[1] ?? '').split(',')) {
      const alias = ALIAS.exec(part)?.[1];
      if (alias !== undefined) names.push(alias);
    }
  }
  for (const match of text.matchAll(NAMESPACE_IMPORT)) {
    if (match[1] !== undefined) names.push(\`\${match[1]}.UltimateError\`);
  }
  return names;
};

/** One alternation over those names, a namespace's dot allowed its whitespace. */
const nameSource = (names: readonly string[]): string =>
  names.map((name) => name.replaceAll('$', '\\\\$').replaceAll('.', '\\\\s*\\\\.\\\\s*')).join('|');

/** Past the string or template opening at open. */
const pastQuoted = (text: string, open: number): number => {
  let index = open + 1;
  while (index < text.length && text[index] !== text[open]) {
    index += text[index] === '\\\\' ? 2 : 1;
  }
  return index + 1;
};

/**
 * Whether the object literal opening at open carries a literal code as its OWN key, or spreads one
 * in from a nested literal. A key deeper down — meta: { code: 'X_TIMEOUT' } — is a value, not
 * the error's code.
 */
const literalCodeIn = (text: string, open: number): boolean => {
  let depth = 0;
  let index = open + 1;
  while (index < text.length) {
    const char = text[index] ?? '';
    // Read before a quote is skipped: a quoted key ('code': …) starts with one.
    if (depth === 0) {
      const rest = text.slice(index);
      if (LITERAL_CODE.test(rest) && !/[\\w$.]/.test(text[index - 1] ?? '')) return true;
      const spread = /^\\.\\.\\.\\s*\\{/.exec(rest);
      if (spread !== null && literalCodeIn(text, index + spread[0].length - 1)) return true;
    }
    if (char === "'" || char === '"' || char === '\`') {
      index = pastQuoted(text, index);
      continue;
    }
    if ('{[('.includes(char)) depth += 1;
    if ('}])'.includes(char)) depth -= 1;
    if (depth < 0) return false;
    index += 1;
  }
  return false;
};

const finding = (file: SourceFile, line: number, what: string): Finding => ({
  code: CODE,
  cause: \`\${file.path}:\${line} \${what} — the title, the HTTP status and the class are then declared apart, and a code with no status answers 500 and hides its cause\`,
  fix: \`rewrite it in \${file.path} as defineError({ code, title, status, cause, fix }) from @ultimat3/core (offSocket: true for a code no response carries), then: x verify\`,
  at: file.path,
});

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function undeclaredErrors(files: readonly SourceFile[]): readonly Finding[] {
  const found: { readonly path: string; readonly line: number; readonly finding: Finding }[] = [];
  for (const file of files) {
    const text = blank(file.source);
    const names = nameSource(classNames(text));
    const push = (index: number, what: string): void => {
      const line = lineOf(text, index);
      found.push({ path: file.path, line, finding: finding(file, line, what) });
    };
    for (const match of text.matchAll(new RegExp(\`\\\\bextends\\\\s+(?:\${names})\\\\b\`, 'g'))) {
      push(match.index, 'subclasses UltimateError by hand');
    }
    for (const match of text.matchAll(new RegExp(\`\\\\bnew\\\\s+(?:\${names})\\\\s*\\\\(\\\\s*\`, 'g'))) {
      const at = match.index + match[0].length;
      // Anything but an object literal hides its code from this read: a value built elsewhere,
      // Object.assign over a literal. A re-raise is written as a literal, with code: err.code.
      if (text[at] !== '{')
        push(match.index, 'builds new UltimateError from a value this guard cannot read');
      else if (literalCodeIn(text, at))
        push(match.index, 'builds new UltimateError with a literal code');
    }
  }
  return found
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
    .map((entry) => entry.finding);
}

export const guard: Guard = {
  summary:
    'an app error code is declared with defineError — never a handwritten UltimateError subclass',
  async check(_root, sources) {
    // A test may build any error it likes as INPUT. The run's ONE read of the source: every guard
    // asking for this glob shares the walk.
    const code = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return undeclaredErrors(
      code
        .filter((file) => !/\\.(?:test|d)\\.tsx?$/.test(file.path))
        .map((file) => ({ path: file.path, source: file.text })),
    );
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { undeclaredErrors } from './error-declared';

const file = (source: string) => [{ path: 'apps/web/app/post/errors.ts', source }];

/** Spelled from parts, so a grep of the app for a handwritten subclass finds only real ones. */
const EXTENDS = ['extends', 'UltimateError'].join(' ');

unitTest('a handwritten subclass is refused, and the finding names the line', () => {
  const findings = undeclaredErrors(file(\`const x = 1;\\nexport class PostNotFound \${EXTENDS} {}\`));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.cause).toContain(':2');
});

unitTest('a literal code handed to new UltimateError is refused', () => {
  expect(
    undeclaredErrors(
      file("throw new UltimateError({ code: 'X_NOT_FOUND', cause: 'c', fix: 'x' });"),
    ),
  ).toHaveLength(1);
  expect(
    undeclaredErrors(file("new UltimateError({ cause: 'c', code: \\"X_NOT_FOUND\\", fix: 'x' });")),
  ).toHaveLength(1);
});

unitTest('a re-raise passing err.code is not a declaration', () => {
  expect(
    undeclaredErrors(
      file("new UltimateError({ code: err.code, cause: err.cause, fix: 'x verify' });"),
    ),
  ).toEqual([]);
});

unitTest('defineError is what the rule asks for, and a comment is not code', () => {
  expect(
    undeclaredErrors(
      file(
        "export const Gone = defineError({ code: 'X_FORBIDDEN', title: 't', status: 410, cause: 'c', fix: 'x' });",
      ),
    ),
  ).toEqual([]);
  expect(undeclaredErrors(file(\`// class Old \${EXTENDS} {}\`))).toEqual([]);
});

unitTest('an aliased or namespaced UltimateError is the same class', () => {
  const aliased = "import { UltimateError as Base } from '@ultimat3/core';\\n";
  expect(
    undeclaredErrors(
      file(\`\${aliased}export class A \${EXTENDS.replace('UltimateError', 'Base')} {}\`),
    ),
  ).toHaveLength(1);
  const namespaced = "import * as core from '@ultimat3/core';\\n";
  expect(
    undeclaredErrors(
      file(
        \`\${namespaced}throw new core.UltimateError({ code: 'X_NOT_FOUND', cause: 'c', fix: 'x' });\`,
      ),
    ),
  ).toHaveLength(1);
});

unitTest(
  'a code spread in, or behind a value, is refused; one nested in meta is not the code',
  () => {
    expect(
      undeclaredErrors(
        file("throw new UltimateError({ ...{ code: 'X_NOT_FOUND' }, cause: 'c', fix: 'x' });"),
      ),
    ).toHaveLength(1);
    expect(undeclaredErrors(file('throw new UltimateError(init);'))).toHaveLength(1);
    expect(
      undeclaredErrors(
        file(
          "new UltimateError({ code: err.code, cause: 'c', fix: 'x', meta: { code: 'X_TIMEOUT' } });",
        ),
      ),
    ).toEqual([]);
  },
);

unitTest('an alias from the page subpath and a quoted code key are the same rule', () => {
  const paged = "import { UltimateError as PageError } from '@ultimat3/core/page';\\n";
  expect(
    undeclaredErrors(
      file(\`\${paged}throw new PageError({ code: 'X_NOT_FOUND', cause: 'c', fix: 'x' });\`),
    ),
  ).toHaveLength(1);
  expect(
    undeclaredErrors(
      file("throw new UltimateError({ 'code': 'X_INTERNAL', cause: 'c', fix: 'x' });"),
    ),
  ).toHaveLength(1);
});
`;

/** `guards/error-declared.ts` and its test. No index, no registry — the directory registers it. */
export const errorDeclaredGuardFiles = (): readonly GeneratedFile[] => [
  { path: 'guards/error-declared.ts', contents: source() },
  { path: 'guards/error-declared.test.ts', contents: test() },
];
