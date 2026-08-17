// The impure half of `scripts/i18n-catalog.ts`: which framework files count as "source that
// renders a string", and what a scan of them yields. Split out so the rule stays a pure function
// over fixtures and the glob stays the only thing that touches disk.

import type { Extraction } from '@ultimat3/i18n';
import { extractKeys, mergeExtractions } from '@ultimat3/i18n';

/**
 * `packages/*​/src` only. `packages/cli/src/templates/**` is excluded because those files are the
 * source of a GENERATED app — their `t('app.dashboard.title')` is a debt the scaffolded app's own
 * catalog owes (`scaffold-i18n.ts` writes it), not one this catalog does. Test files are excluded
 * for the reason `packages/cli/src/i18n-audit.ts` states: a fixture's `t('fixture.key')` is not a
 * gap a shipped catalog answers.
 */
const SOURCE_PATTERN = 'packages/*/src/**/*.{ts,tsx}';
const TEMPLATE_DIR = 'packages/cli/src/templates/';
const TEST_FILE = /\.(test|contract|live|job|e2e|eval)\.tsx?$/;

/** A key: at least two dot-separated segments, the shape every catalog key in this repo has. */
const KEY_LITERAL = /['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g;

/** A line that is entirely a comment. See `stripComments`. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

/**
 * Blank every whole-line comment, keeping the line count so reported positions stay true.
 *
 * WHY at all: `extractKeys` is a regex scan with no lexer, so the JSDoc on
 * `packages/i18n/src/translator.ts` that reads "`t('items', { count })` is how plural selection is
 * called" extracts `items` as a used key — and this check would then demand `items` in the catalog.
 * Whole-line only, deliberately: a string-aware comment stripper has to decide whether `/` starts a
 * regex, and getting that wrong DELETES code, which turns a false positive into a silent false
 * negative. Biome formats every block comment in this repo with a leading `*`, so the cheap rule
 * covers them; a `t('x.y')` in a trailing comment after code is the one shape it still sees.
 */
export function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => (COMMENT_LINE.test(line) ? '' : line))
    .join('\n');
}

export function keyLiteralsIn(source: string): readonly string[] {
  return [...source.matchAll(KEY_LITERAL)].map((match) => match[1] ?? '');
}

export interface CatalogScan {
  readonly extraction: Extraction;
  readonly literals: readonly string[];
}

export async function scanFrameworkCatalogSources(root: string): Promise<CatalogScan> {
  const extractions: Extraction[] = [];
  const literals = new Set<string>();

  for await (const relative of new Bun.Glob(SOURCE_PATTERN).scan({ cwd: root, absolute: false })) {
    const path = relative.split('\\').join('/');
    if (path.startsWith(TEMPLATE_DIR) || TEST_FILE.test(path)) continue;
    const source = stripComments(await Bun.file(`${root}/${path}`).text());
    extractions.push(extractKeys(source, path));
    for (const literal of keyLiteralsIn(source)) literals.add(literal);
  }

  return { extraction: mergeExtractions(...extractions), literals: [...literals].sort() };
}
