// The `raw-z-index` guard `x new` ships: a `z-index` is a named layer of `@ultimat3/ui/tokens`' z
// ladder. `_z.scss` has always said "a magic number in a component is a review failure"; this is
// that sentence as a build error.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'raw-z-index';
const CODE = guardCode(NAME);

const source =
  (): string => `// raw-z-index: a layer is a name on the one z ladder, so "above the dialog" means one thing.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// The NEGATIVE of a named layer is still a named layer — \`calc(-1 * #{tokens.z(raised)})\` puts a
// decoration behind its own stacking context — so a \`-1 *\` beside a token is not a number.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/** \`@ultimat3/ui/tokens\`' z ladder. */
export const LAYERS: readonly (readonly [string, number])[] = [
  ['base', 0],
  ['raised', 10],
  ['sticky', 100],
  ['dropdown', 200],
  ['drawer', 300],
  ['dialog', 400],
  ['popover', 500],
  ['tooltip', 600],
  ['toast', 700],
  ['skip-nav', 800],
];

export interface StyleFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly scss: string;
}

const blank = (text: string): string => text.replaceAll(/[^\\n]/g, ' ');

/** Comments blanked rather than removed, so a reported line number still points at the source. */
const blankComments = (scss: string): string =>
  scss.replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, blank).replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, blank);

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

/** The \`as <name>\` the token entry point is used under in this sheet; \`tokens\` when it is not. */
const namespaceOf = (scss: string): string =>
  /@use\\s+['"][^'"]*tokens[^'"]*['"]\\s+as\\s+([\\w-]+)/.exec(scss)?.[1] ?? 'tokens';

const Z_INDEX = /(?<![\\w$-])z-index\\s*:\\s*((?:#\\{[^}]*\\}|[^;{}])+)/g;
/** A token read: \`tokens.z(dialog)\`, \`z('dialog')\`, \`var(--z-dialog)\` — and the negation of one. */
const TOKEN = /(?:[\\w-]+\\.)?z\\([^)]*\\)|var\\(\\s*--z-[\\w-]+\\s*\\)|-1\\s*\\*|\\*\\s*-1/g;

/** The nearest layer to a number. Never \`base\` for a non-zero one: \`-0\` is not behind anything. */
const layerFor = (value: number): string => {
  let best: readonly [string, number] | undefined;
  for (const layer of LAYERS) {
    if (value !== 0 && layer[1] === 0) continue;
    if (
      best === undefined ||
      Math.abs(layer[1] - Math.abs(value)) < Math.abs(best[1] - Math.abs(value))
    ) {
      best = layer;
    }
  }
  return best?.[0] ?? 'raised';
};

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawZIndexes(files: readonly StyleFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const scss = blankComments(file.scss);
    const ns = namespaceOf(file.scss);
    for (const match of scss.matchAll(Z_INDEX)) {
      const value = (match[1] ?? '').trim();
      const literal = /-?\\d+/.exec(value.replaceAll(TOKEN, ' '))?.[0];
      if (literal === undefined) continue;
      const line = lineOf(scss, match.index);
      const layer = \`\${ns}.z(\${layerFor(Number(literal))})\`;
      const written = Number(literal) < 0 ? \`calc(-1 * #{\${layer}})\` : layer;
      findings.push({
        code: CODE,
        cause: \`\${file.path}:\${line} writes \\\`z-index: \${value}\\\` — a number only this file knows, on no ladder another layer can be placed against\`,
        fix: \`z-index: \${written} — at \${file.path}:\${line} (layers: \${LAYERS.map(([name]) => name).join(' ')}), then: x verify\`,
        at: \`\${file.path}:\${line}\`,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a z-index is a named layer, never a number',
  async check(_root, sources) {
    const sheets = await sources.files('{apps,packages}/**/*.scss');
    return rawZIndexes(sheets.map((file) => ({ path: file.path, scss: file.text })));
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawZIndexes } from './raw-z-index';

const sheet = (scss: string) => [{ path: 'apps/web/site/page.module.scss', scss }];
const fixes = (scss: string) => rawZIndexes(sheet(scss)).map((finding) => finding.fix);

unitTest('a numeric z-index is refused, and the fix is the layer it means', () => {
  const findings = rawZIndexes(sheet('.menu {\\n  z-index: 200;\\n}\\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:2');
  expect(findings[0]?.fix).toStartWith('z-index: tokens.z(dropdown) — ');
});

unitTest('a number off the ladder gets the nearest layer', () => {
  expect(fixes('.a { z-index: 9999; }')[0]).toStartWith('z-index: tokens.z(skip-nav) — ');
  expect(fixes('.a { z-index: 1; }')[0]).toStartWith('z-index: tokens.z(raised) — ');
  expect(fixes('.a { z-index: 0; }')[0]).toStartWith('z-index: tokens.z(base) — ');
});

unitTest('a negative number is the negation of a layer, never of base', () => {
  expect(fixes('.a { z-index: -1; }')[0]).toStartWith('z-index: calc(-1 * #{tokens.z(raised)}) — ');
});

unitTest('a number beside a token is still a number', () => {
  expect(rawZIndexes(sheet('.a { z-index: calc(#{tokens.z(dialog)} + 1); }'))).toHaveLength(1);
});

unitTest('the fix speaks the namespace the sheet uses the tokens under', () => {
  const scss = "@use '../shared/tokens' as t;\\n.a { z-index: 400; }";
  expect(fixes(scss)[0]).toStartWith('z-index: t.z(dialog) — ');
});

// The legitimate lookalikes — the reason the rule can stay switched on.
unitTest('a token, its negation and a keyword are silent', () => {
  const silent = [
    '.a { z-index: tokens.z(dialog); }',
    ".a { z-index: tokens.z('skip-nav'); }",
    '.a { z-index: var(--z-toast); }',
    '.a { z-index: calc(-1 * #{tokens.z(raised)}); }',
    '.a { z-index: auto; }',
    '.a { z-index: inherit; }',
    '// z-index: 5;\\n.a { z-index: auto; }',
    '$z-index: 5;',
  ];
  for (const scss of silent) expect(rawZIndexes(sheet(scss))).toEqual([]);
});
`;

/** `guards/raw-z-index.ts` and its test. No index, no registry — the directory is the registration. */
export const rawZIndexGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
