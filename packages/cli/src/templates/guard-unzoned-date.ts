// The `unzoned-date` guard `x new` ships: no date is formatted without an explicit IANA zone.
// `AGENTS.md` has always stated the rule and NOTHING enforced it — `toLocaleDateString('en-US')`
// in a scaffolded page was green on `x verify`, and it renders the SERVER's zone, so the same row
// reads as two different days depending on which container answered.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/**
 * Derived from the guard's name, never written as a literal — the same rule `x g guard` follows.
 * An `X_*` literal in framework source is a FRAMEWORK code: `error-catalog.test.ts` refuses one the
 * registry does not hold, and `wiki/Error-Codes.md` would owe it a row. The APP owns the codes its
 * own conventions raise, so this one is spelled by the file it lands in and nowhere else.
 */
const NAME = 'unzoned-date';
const CODE = guardCode(NAME);

const source =
  (): string => `// unzoned-date: a date is stored in UTC and formatted with an explicit IANA zone, never with the
// host's ambient one. \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside
// the \`boundaries\` step — nothing registers this file, so nothing can forget to.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/** Every call whose output depends on a zone. The \`(\` is the start of the argument list. */
const FORMATTER = /(?:\\.toLocale(?:Date|Time)?String|Intl\\.DateTimeFormat)\\s*\\(/g;

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

/**
 * Comments blanked IN PLACE — not deleted — so the line number a finding reports still points at
 * the source line. What it does not blank is a string body: a call spelled inside a quoted string
 * is reported, which is the one false positive this rule can produce and the reason its own test
 * lives in \`guards/\`, which nothing here scans.
 */
const blank = (text: string): string =>
  text
    .replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, (match) => match.replaceAll(/[^\\n]/g, ' '))
    .replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, (match) => ' '.repeat(match.length));

/**
 * The call's own argument list, from its \`(\` to the \`)\` that closes it. Depth-counted rather
 * than "up to the next \`)\`": \`toLocaleDateString(locale, { timeZone: zoneFor(x) })\` closes twice
 * before the one that ends the call, and reading only the first would report a zoned call.
 */
function argumentsOf(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function unzonedDates(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    for (const match of text.matchAll(FORMATTER)) {
      const open = match.index + match[0].length - 1;
      if (argumentsOf(text, open).includes('timeZone')) continue;
      const line = lineOf(text, match.index);
      findings.push({
        code: CODE,
        cause: \`\${file.path}:\${line} calls \${match[0].trim()}) with no timeZone — it formats in whatever zone the process happens to run in, so one row reads as two different days across two containers\`,
        fix: \`pass an explicit IANA zone in \${file.path} — toLocaleDateString(locale, { timeZone: 'UTC' }) — then: x verify\`,
        at: file.path,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a date is never formatted without an explicit IANA time zone',
  async check(root) {
    const files: SourceFile[] = [];
    for await (const entry of new Bun.Glob('{apps,packages}/**/*.{ts,tsx}').scan({
      cwd: root,
      absolute: false,
    })) {
      const path = entry.split('\\\\').join('/');
      // A test's subject is often the wrong shape on purpose, and \`node_modules\` is not this
      // app's source. Neither exclusion hides a rendered date from a user.
      if (path.includes('node_modules/') || /\\.(?:test|d)\\.tsx?$/.test(path)) continue;
      files.push({ path, source: await Bun.file(\`\${root}/\${path}\`).text() });
    }
    return unzonedDates(files);
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { unzonedDates } from './unzoned-date';

const file = (source: string) => [{ path: 'apps/web/app/dashboard/page.tsx', source }];

unitTest('toLocaleDateString with no timeZone is refused', () => {
  const findings = unzonedDates(file("const shown = at.toLocaleDateString('en-US');"));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.fix).toContain('timeZone');
});

unitTest('an explicit zone satisfies it, even nested behind another call', () => {
  const zoned = "at.toLocaleDateString('en-US', { timeZone: zoneFor(actor) });";
  expect(unzonedDates(file(zoned))).toEqual([]);
});

unitTest('Intl.DateTimeFormat and toLocaleTimeString are the same rule', () => {
  expect(unzonedDates(file("new Intl.DateTimeFormat('en-US').format(at);"))).toHaveLength(1);
  expect(unzonedDates(file("at.toLocaleTimeString('en-US');"))).toHaveLength(1);
});

unitTest('a commented-out call is a note, not a call', () => {
  expect(unzonedDates(file("// at.toLocaleDateString('en-US');"))).toEqual([]);
});
`;

/** `guards/unzoned-date.ts` and its test. No index, no registry — the directory registers it. */
export const unzonedDateGuardFiles = (): readonly GeneratedFile[] => [
  { path: 'guards/unzoned-date.ts', contents: source() },
  { path: 'guards/unzoned-date.test.ts', contents: test() },
];
