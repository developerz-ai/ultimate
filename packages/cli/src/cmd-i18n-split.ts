// `x i18n split [<locale>]`: every flat catalog, or the one named, moved into a directory of
// namespace files — `catalogs/<locale>/<namespace>.json` — with the barrel that joins them, the
// app's index importing it and `.gitattributes` merging it. Lossless: the files join back to the
// exact catalog that was split. Idempotent: a split locale is re-derived in place, nothing moves.

// why: Bun has no path API, so `join` builds the absolute path `Bun.file` reads and deletes.
import { join } from 'node:path';
import type { Catalog } from '@ultimat3/i18n';
import { catalogKeyDuplicate } from '@ultimat3/i18n';
import type { CatalogLayout, LocaleLayout } from './catalog-layout';
import {
  catalogFileOf,
  loadFlatCatalog,
  loadSplitCatalog,
  readCatalogLayout,
  writeLocaleCatalog,
} from './catalog-layout';
import { BadFlagError } from './errors';
import { syncI18nIndex } from './i18n-index';
import { msg } from './messages';
import type { CommandResult } from './output';
import { quoteArg } from './shell-quote';
import { catalogPath } from './templates/locales';
import {
  FLAT_CATALOG_ATTRIBUTE,
  MERGE_ATTRIBUTES,
  ROOT_GITATTRIBUTES_PATH,
} from './templates/scaffold-gitattributes';

/** What one locale's split did. */
interface LocaleSplit {
  readonly locale: string;
  /** The form it was in before this run. */
  readonly from: LocaleLayout['form'];
  readonly keys: number;
  readonly files: number;
}

/**
 * A mixed locale's two halves as one catalog. A key both define is refused naming the flat file
 * and the namespace file — never resolved by picking one: which wording ships is a decision.
 */
async function mixedCatalog(root: string, locale: string, layout: CatalogLayout): Promise<Catalog> {
  const flat = await loadFlatCatalog(root, locale);
  const split = await loadSplitCatalog(root, locale, layout[locale]?.files ?? []);
  for (const key of Object.keys(flat)) {
    if (Object.hasOwn(split, key)) {
      throw catalogKeyDuplicate(key, [catalogPath(locale), catalogFileOf(layout, locale, key)]);
    }
  }
  return { ...split, ...flat };
}

async function splitLocale(
  root: string,
  locale: string,
  layout: CatalogLayout,
): Promise<{
  readonly result: LocaleSplit;
  readonly written: readonly string[];
  readonly removed?: string;
}> {
  const entry = layout[locale];
  if (entry === undefined) {
    throw new BadFlagError({
      flag: 'locale',
      command: 'i18n',
      reason: `no catalog for "${locale}" at ${catalogPath(locale)}`,
      fix: `x i18n add ${quoteArg(locale)}`,
    });
  }
  let catalog: Catalog;
  if (entry.form === 'flat') catalog = await loadFlatCatalog(root, locale);
  else if (entry.form === 'mixed') catalog = await mixedCatalog(root, locale, layout);
  else catalog = await loadSplitCatalog(root, locale, entry.files);
  // Every namespace file first, the flat file deleted only after: a run that dies half-way leaves
  // a mixed locale, which every read refuses and this command repairs — never a lost key.
  const target = { form: 'split' as const, files: entry.files };
  const written = await writeLocaleCatalog(root, locale, catalog, target);
  if (entry.form !== 'split') await Bun.file(join(root, catalogPath(locale))).delete();
  const files = (await readCatalogLayout(root))[locale]?.files.length ?? 0;
  const result = { locale, from: entry.form, keys: Object.keys(catalog).length, files };
  return entry.form === 'split'
    ? { result, written }
    : { result, written, removed: catalogPath(locale) };
}

/**
 * `.gitattributes`' flat-only catalog rule, widened to the split layout — the line `x new` wrote
 * before split catalogs existed. A file without that line (no merge rules, or rules written by
 * hand) is left alone: `bunx x upgrade`'s `merge-drivers` codemod is what writes them.
 */
async function widenAttributes(root: string): Promise<readonly string[]> {
  const file = Bun.file(join(root, ROOT_GITATTRIBUTES_PATH));
  if (!(await file.exists())) return [];
  const held = await file.text();
  if (!held.split('\n').includes(FLAT_CATALOG_ATTRIBUTE)) return [];
  const rules = MERGE_ATTRIBUTES.split('\n').filter((line) => line.startsWith('packages/i18n/'));
  await Bun.write(file, held.replace(FLAT_CATALOG_ATTRIBUTE, rules.join('\n')));
  return [ROOT_GITATTRIBUTES_PATH];
}

/** `locale` is the positional, already validated by the caller; absent means every locale. */
export async function runSplit(root: string, locale: string | undefined): Promise<CommandResult> {
  const layout = await readCatalogLayout(root);
  const locales = locale === undefined ? Object.keys(layout) : [locale];
  const results: LocaleSplit[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  for (const one of locales) {
    const split = await splitLocale(root, one, layout);
    results.push(split.result);
    written.push(...split.written);
    if (split.removed !== undefined) removed.push(split.removed);
  }
  // The index imports each locale in the form it is now in, and each barrel is current.
  const index = await syncI18nIndex(root);
  written.push(...(index.edited ?? []), ...(await widenAttributes(root)));
  const touched = [...new Set(written)].sort();
  const moved = results.filter((one) => one.from !== 'split').length;
  return {
    ok: index.findings.length === 0,
    command: 'i18n',
    summary: msg('cli.i18n.split', {
      locales: results.length,
      files: results.reduce((sum, one) => sum + one.files, 0),
      moved,
    }),
    lines: [...touched.map((path) => `  ${path}`), ...removed.map((path) => `  ${path} (removed)`)],
    findings: index.findings,
    data: { locales: results.map((one) => ({ ...one })), written: touched, removed },
  };
}
