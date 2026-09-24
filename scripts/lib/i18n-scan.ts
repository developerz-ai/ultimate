// The impure half of `scripts/i18n-catalog.ts`: which framework files count as "source that
// renders a string", and what a scan of them yields. Split out so the rule stays a pure function
// over fixtures and the glob stays the only thing that touches disk.

import type { Extraction } from '@ultimat3/i18n';
import { extractKeys, mergeExtractions } from '@ultimat3/i18n';
import { corpus } from './corpus';

/**
 * `packages/*​/src` only. `packages/cli/src/templates/**` is excluded because those files are the
 * source of a GENERATED app — their `t('app.dashboard.title')` is a debt the scaffolded app's own
 * catalog owes (`scaffold-i18n.ts` writes it), not one this catalog does. Test files are excluded
 * for the reason `packages/cli/src/i18n-audit.ts` states: a fixture's `t('fixture.key')` is not a
 * gap a shipped catalog answers.
 */
const TEMPLATE_DIR = 'packages/cli/src/templates/';

/** A key: at least two dot-separated segments, the shape every catalog key in this repo has. */
const KEY_LITERAL = /['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g;

export function keyLiteralsIn(source: string): readonly string[] {
  return [...source.matchAll(KEY_LITERAL)].map((match) => match[1] ?? '');
}

export interface CatalogScan {
  readonly extraction: Extraction;
  readonly literals: readonly string[];
}

/**
 * The corpus `shipped` scope minus the templates, each file with its comments blanked
 * (`CorpusFile.stripped`, the one string-aware stripper): `extractKeys` is a regex scan with no
 * lexer, so the JSDoc reading "`t('items', { count })` is how plural selection is called" would
 * otherwise extract `items` as a used key and demand it of the catalog.
 */
export async function scanFrameworkCatalogSources(root: string): Promise<CatalogScan> {
  const extractions: Extraction[] = [];
  const literals = new Set<string>();
  for (const file of await corpus(root, 'shipped')) {
    if (file.path.startsWith(TEMPLATE_DIR)) continue;
    extractions.push(extractKeys(file.stripped, file.path));
    for (const literal of keyLiteralsIn(file.stripped)) literals.add(literal);
  }
  return { extraction: mergeExtractions(...extractions), literals: [...literals].sort() };
}
