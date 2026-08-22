// The `raw-colour` guard `x new` ships: no stylesheet in this app names a colour.
// `AGENTS.md` has always stated the rule and NOTHING enforced it — `verify-checks.ts` said it rode
// on `packages/ui/src/tokens/tokens.test.ts`, which covers the framework's stylesheets and never
// the app's, so `color: #ff0000` in a scaffolded `page.module.scss` was green on `x verify`.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/**
 * Derived from the guard's name, never written as a literal — the same rule `x g guard` follows.
 * An `X_*` literal in framework source is a FRAMEWORK code: `error-catalog.test.ts` refuses one the
 * registry does not hold, and `wiki/Error-Codes.md` would owe it a row. The APP owns the codes its
 * own conventions raise, so this one is spelled by the file it lands in and nowhere else.
 */
const NAME = 'raw-colour';
const CODE = guardCode(NAME);

const source =
  (): string => `// raw-colour: every colour in this app is a semantic token, so dark theme is not a later project.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/** A hex literal. \`#{$x}\` is Sass interpolation, not a colour, and \`{\` is not a hex digit. */
const HEX = /#[0-9a-fA-F]{3,8}\\b/;
const CHANNEL_FUNCTION = /\\b(?:rgba?|hsla?|lab|lch|oklab|oklch|color)\\(/i;
/** The named colours a human actually types. The full CSS list would report \`.item\` selectors. */
const NAMED =
  /\\b(?:white|black|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|silver|navy|teal|olive|lime|aqua|maroon|fuchsia|gold|beige|coral|crimson|indigo|violet|khaki|salmon|tan|turquoise|wheat)\\b/i;

/**
 * A DECLARATION, never a whole line: a selector carries no colon, so \`#hero { … }\` is not a value
 * and is never reported. The value stops at the first \`;\`, \`{\` or \`}\`.
 */
const DECLARATION = /([\\w-]+)\\s*:\\s*([^;{}]+)/g;

export interface StyleFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly scss: string;
}

/**
 * Comments blanked rather than removed, so the reported line number still points at the source
 * line. \`//\` is skipped when a \`:\` precedes it — \`url(https://…)\` is a value, not a comment.
 */
const blankComments = (scss: string): string =>
  scss
    .replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, (match) => match.replaceAll(/[^\\n]/g, ' '))
    .replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, (match) => ' '.repeat(match.length));

/** Quoted text is a filename or a token name, never a colour: \`url('red.png')\`, \`role('bg')\`. */
const unquote = (value: string): string => value.replaceAll(/'[^']*'|"[^"]*"/g, ' ');

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawColours(files: readonly StyleFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const scss = blankComments(file.scss);
    for (const match of scss.matchAll(DECLARATION)) {
      const property = match[1] ?? '';
      const value = unquote(match[2] ?? '');
      const literal = HEX.exec(value) ?? CHANNEL_FUNCTION.exec(value) ?? NAMED.exec(value);
      if (literal === null) continue;
      findings.push({
        code: CODE,
        cause: \`\${file.path}:\${lineOf(scss, match.index)} sets \${property} to the raw colour \${literal[0]} — a value no theme can restate, so dark theme renders it unchanged\`,
        fix: \`replace \${literal[0]} in \${file.path} with tokens.role('fg'), tokens.role('bg') or the role this element means, then: x verify\`,
        at: file.path,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a stylesheet names a semantic token, never a colour',
  async check(root) {
    const files: StyleFile[] = [];
    for await (const entry of new Bun.Glob('{apps,packages}/**/*.scss').scan({
      cwd: root,
      absolute: false,
    })) {
      const path = entry.split('\\\\').join('/');
      if (path.includes('node_modules/')) continue;
      files.push({ path, scss: await Bun.file(\`\${root}/\${path}\`).text() });
    }
    return rawColours(files);
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawColours } from './raw-colour';

const sheet = (scss: string) => [{ path: 'apps/web/site/page.module.scss', scss }];

unitTest('a hex literal in a declaration is refused', () => {
  const findings = rawColours(sheet('.hero {\\n  color: #ff0000;\\n}\\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.cause).toContain('#ff0000');
  expect(findings[0]?.cause).toContain(':2');
});

unitTest('rgb(), hsl() and a named colour are the same rule', () => {
  expect(rawColours(sheet('.a { background: rgb(1 2 3); }'))).toHaveLength(1);
  expect(rawColours(sheet('.a { background: hsl(1 2% 3%); }'))).toHaveLength(1);
  expect(rawColours(sheet('.a { border-color: white; }'))).toHaveLength(1);
});

unitTest('a token, a selector and a quoted filename are not colours', () => {
  expect(rawColours(sheet(".a { background: tokens.role('bg'); }"))).toEqual([]);
  expect(rawColours(sheet('#hero { padding: 0; }'))).toEqual([]);
  expect(rawColours(sheet(".a { background: url('red-hero.png'); }"))).toEqual([]);
});

unitTest('a commented-out colour is a note, not a declaration', () => {
  expect(rawColours(sheet('// color: #ff0000;\\n.a { padding: 0; }'))).toEqual([]);
  expect(rawColours(sheet('/* color: #ff0000; */\\n.a { padding: 0; }'))).toEqual([]);
});
`;

/** `guards/raw-colour.ts` and its test. No index, no registry — the directory is the registration. */
export const rawColourGuardFiles = (): readonly GeneratedFile[] => [
  { path: 'guards/raw-colour.ts', contents: source() },
  { path: 'guards/raw-colour.test.ts', contents: test() },
];
