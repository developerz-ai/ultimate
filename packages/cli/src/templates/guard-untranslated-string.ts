// The `untranslated-string` guard `x new` ships: no user-facing string is typed into a page.
// `AGENTS.md` has always stated the rule and NOTHING enforced it — a hardcoded JSX string sitting
// beside a `t()` call in a scaffolded page was green on `x verify`, and `x i18n check` cannot see
// it either: a literal that is in no catalog is a literal the catalog audit has no key for.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/**
 * Derived from the guard's name, never written as a literal — the same rule `x g guard` follows.
 * An `X_*` literal in framework source is a FRAMEWORK code: `error-catalog.test.ts` refuses one the
 * registry does not hold, and `wiki/Error-Codes.md` would owe it a row. The APP owns the codes its
 * own conventions raise, so this one is spelled by the file it lands in and nowhere else.
 */
const NAME = 'untranslated-string';
const CODE = guardCode(NAME);

const source =
  (): string => `// untranslated-string: every user-facing string on a rendered surface goes through \`t()\`.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/**
 * \`<tag …>text</tag>\`, matched on the CLOSING tag rather than on the next \`<\`.
 *
 * That is the whole reason this rule can run over TypeScript at all: \`createSignal<State>('idle')\`
 * is a \`>\` followed by prose-shaped source, and a pattern reading to the next \`<\` reports every
 * generic in the file. A closing tag that names the same element cannot be a type argument.
 *
 * Only the INNERMOST element matches — the content class excludes \`<\` and \`>\` — which is what the
 * rule wants: a parent whose children are elements has no text of its own.
 */
const ELEMENT = /<([A-Za-z][\\w.:-]*)(?:\\s[^<>]*)?>([^<>]*?)<\\/\\1>/g;
/** A \`{…}\` child is an expression — \`{t('key')}\`, \`{props.row.title}\` — never typed prose. */
const EXPRESSION = /\\{[^{}]*\\}/g;
/** Two word characters in a row. One is \`&\`, \`×\`, an initial — never a sentence. */
const PROSE = /[\\p{L}\\p{N}]{2,}/u;

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
export function untranslatedStrings(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    for (const match of text.matchAll(ELEMENT)) {
      const typed = (match[2] ?? '').replaceAll(EXPRESSION, ' ').trim();
      if (!PROSE.test(typed)) continue;
      findings.push({
        code: CODE,
        cause: \`\${file.path}:\${lineOf(text, match.index)} renders the typed string "\${typed}" inside <\${match[1] ?? 'element'}> — it is in no catalog, so every locale but the one it was typed in reads it verbatim\`,
        fix: \`add a key for "\${typed}" to packages/i18n/catalogs/en.json, render it as {t('…')} in \${file.path}, then: x i18n check\`,
        at: file.path,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a rendered string comes from t(), never typed into the page',
  async check(root) {
    const files: SourceFile[] = [];
    // The two rendered surfaces. \`api/\` renders nothing and \`shared/\` is a leaf of helpers.
    for await (const entry of new Bun.Glob('apps/*/{site,app}/**/*.tsx').scan({
      cwd: root,
      absolute: false,
    })) {
      const path = entry.split('\\\\').join('/');
      if (path.includes('node_modules/') || /\\.test\\.tsx?$/.test(path)) continue;
      files.push({ path, source: await Bun.file(\`\${root}/\${path}\`).text() });
    }
    return untranslatedStrings(files);
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { untranslatedStrings } from './untranslated-string';

const file = (source: string) => [{ path: 'apps/web/site/page.tsx', source }];

unitTest('a typed JSX string is refused, and the finding quotes it', () => {
  const findings = untranslatedStrings(file('<h1>Welcome back</h1>'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.cause).toContain('Welcome back');
});

unitTest('a t() child satisfies it, and so does any other expression', () => {
  expect(untranslatedStrings(file("<h1>{t('site.home.title')}</h1>"))).toEqual([]);
  expect(untranslatedStrings(file('<li class={styles.item}>{row.title}</li>'))).toEqual([]);
});

// The reason the rule reads a CLOSING tag: a generic type argument is a > followed by source that
// looks exactly like prose, and a pattern reading to the next < reports every one of them.
unitTest('a generic type argument is not a JSX text node', () => {
  const generic = "const [state, setState] = createSignal<SaveState>('idle');\\nconst n = 1;";
  expect(untranslatedStrings(file(generic))).toEqual([]);
});

unitTest('one word character is a symbol, not a sentence', () => {
  expect(untranslatedStrings(file('<span>&</span>'))).toEqual([]);
});
`;

/** `guards/untranslated-string.ts` and its test. The directory is the registration. */
export const untranslatedStringGuardFiles = (): readonly GeneratedFile[] => [
  { path: 'guards/untranslated-string.ts', contents: source() },
  { path: 'guards/untranslated-string.test.ts', contents: test() },
];
