// The one writer of `packages/i18n/src/index.ts` and of each split locale's barrel
// (`catalogs/<locale>/index.ts`), shared by `x g` and `x i18n add|sync|split`.
//
// A catalog file existing on disk and the app being able to SELECT that locale are two different
// facts, and only this closes the gap: the index hardcodes `locales: { en }`, so a locale whose
// catalog nothing registered renders `⟦key⟧` — which the gate's `i18n` step refuses outright
// (`X_CATALOG_UNREGISTERED`). `x i18n add fr` wrote the file, touched nothing else, and left
// `x verify` red with a fix line that named an edit nobody could perform (#F4).

import { stripComments } from '@ultimat3/core';
import { APP_CATALOGS_PATH } from '@ultimat3/i18n/app-catalogs';
import type { CatalogLayout, LocaleLayout } from './catalog-layout';
import { readCatalogLayout } from './catalog-layout';
import type { GenerateDisk } from './generate-disk';
import { appDisk } from './generate-disk';
import type { Finding } from './output';
import { CATALOG_ROOT, i18nIndex, localeEntry, localeImport } from './templates';
import { catalogBarrel } from './templates/catalog-barrel';
import { CATALOG_BARREL, catalogDir } from './templates/locales';

/** Every locale with a catalog on disk, sorted — flat file stems and split directories alike. */
export async function catalogLocales(root: string): Promise<readonly string[]> {
  return Object.keys(await readCatalogLayout(root));
}

/** What a sync did: whether every catalog on disk is now selectable, and why not when it is not. */
export interface IndexSync {
  /** False for an app with no i18n package, or an index this writer refused to edit. */
  readonly registered: boolean;
  readonly findings: readonly Finding[];
  /** The index, when this changed its bytes — a run's file list names every file it touched. */
  readonly edited?: readonly string[];
}

/** Both spellings `localeImport` writes: `import en from '../catalogs/en.json'` (flat) and
 * `import { catalog as en } from '../catalogs/en'` (a split locale's barrel). */
const CATALOG_IMPORT =
  /^import (?:(\w+)|\{ catalog as (\w+) \}) from '\.\.\/catalogs\/([^'/]+?)(\.json)?';$/gm;
const LOCALES_OBJECT = /(locales:\s*\{)([^{}]*)(\})/;

interface ImportedLocale {
  readonly locale: string;
  readonly split: boolean;
  readonly line: string;
  readonly binding: string;
}

/** The tags the index imports a catalog for, in file order, each with the form it imports. */
const importedLocales = (source: string): readonly ImportedLocale[] =>
  [...source.matchAll(CATALOG_IMPORT)].map((match) => ({
    locale: match[3] ?? '',
    split: match[4] === undefined,
    line: match[0],
    binding: match[1] ?? match[2] ?? '',
  }));

/**
 * Every import whose form no longer matches the disk, rewritten in place under its own binding —
 * `x i18n split` turned `en.json` into `en/`, and nothing else in the index has to move.
 */
function withForms(source: string, split: readonly string[]): string {
  let next = source;
  for (const imported of importedLocales(source)) {
    const wanted = split.includes(imported.locale);
    if (wanted === imported.split) continue;
    const line = wanted
      ? `import { catalog as ${imported.binding} } from '../catalogs/${imported.locale}';`
      : `import ${imported.binding} from '../catalogs/${imported.locale}.json';`;
    next = next.replace(imported.line, line);
  }
  return next;
}

/** Each split locale's barrel, re-derived from its files (and the ones a dry run plans). */
async function syncBarrels(
  layout: CatalogLayout,
  disk: GenerateDisk,
  plannedFiles: readonly string[],
): Promise<readonly string[]> {
  const edited: string[] = [];
  for (const [locale, { form, files }] of Object.entries(layout)) {
    if (form !== 'split') continue;
    const prefix = `${catalogDir(locale)}/`;
    const planned = plannedFiles
      .filter((path) => path.startsWith(prefix) && path.endsWith('.json'))
      .map((path) => path.slice(prefix.length));
    const barrel = catalogBarrel([...files, ...planned]);
    const path = `${prefix}${CATALOG_BARREL}`;
    if ((await disk.read(path)) === barrel) continue;
    await disk.write(path, barrel);
    edited.push(path);
  }
  return edited;
}

/** The layout on disk, with the split locales a dry run's planned files would create. */
function plannedLayout(layout: CatalogLayout, plannedFiles: readonly string[]): CatalogLayout {
  const next: Record<string, LocaleLayout> = { ...layout };
  for (const path of plannedFiles) {
    const stem = path.startsWith(`${CATALOG_ROOT}/`) ? path.slice(CATALOG_ROOT.length + 1) : '';
    const slash = stem.indexOf('/');
    if (slash <= 0 || !stem.endsWith('.json')) continue;
    const locale = stem.slice(0, slash);
    next[locale] ??= { form: 'split', files: [] };
  }
  return next;
}

/**
 * Makes every catalog on disk selectable, and touches the index no more than that takes.
 *
 * An index that IS the template's output (for the locales it imports) is the framework's file and
 * is re-derived whole. Anything else is the author's: each missing locale gets its import and its
 * `locales: { … }` entry and nothing else moves — the declared `default`, and any code beside it,
 * stay. A shape with no `locales: { … }` object to add to is refused with the edit named, never
 * overwritten: it was, on every `x g`, with a template hard-coding `default: 'en'`.
 */
export async function syncI18nIndex(
  root: string,
  disk: GenerateDisk = appDisk(root),
  /** Locales whose catalog a dry run PLANS: on the real disk only once the run has written. */
  planned: readonly string[] = [],
  /** Catalog files a dry run plans, so a split locale's barrel names a namespace not yet written. */
  plannedFiles: readonly string[] = [],
): Promise<IndexSync> {
  const layout = plannedLayout(await readCatalogLayout(root), plannedFiles);
  const barrels = await syncBarrels(layout, disk, plannedFiles);
  const touching = (paths: readonly string[]) => (paths.length > 0 ? { edited: paths } : {});
  const current = await disk.read(APP_CATALOGS_PATH);
  if (current === undefined) return { registered: false, findings: [], ...touching(barrels) };
  const onDisk = [...new Set([...Object.keys(layout), ...planned])].sort();
  const split = onDisk.filter((locale) => layout[locale]?.form === 'split');
  const imported = importedLocales(current);
  const write = async (next: string): Promise<IndexSync> => {
    const touched = next === current ? barrels : [...barrels, APP_CATALOGS_PATH];
    if (next !== current) await disk.write(APP_CATALOGS_PATH, next);
    return { registered: true, findings: [], ...touching(touched) };
  };
  const importedTags = imported.map((entry) => entry.locale);
  const importedSplit = imported.filter((entry) => entry.split).map((entry) => entry.locale);
  if (current === i18nIndex(importedTags, importedSplit)) return write(i18nIndex(onDisk, split));
  const reformed = withForms(current, split);
  const missing = onDisk.filter((locale) => !importedTags.includes(locale));
  if (missing.length === 0) return write(reformed);
  const edited = withLocales(reformed, missing, split);
  if (edited === undefined) {
    return { registered: false, findings: [refusal(missing, split)], ...touching(barrels) };
  }
  return write(edited);
}

/** Each import after the last catalog import (or at the top), each entry at the object's end. */
function withLocales(
  source: string,
  locales: readonly string[],
  split: readonly string[],
): string | undefined {
  // Found on the comment-stripped text (same offsets): a `locales: { … }` in a comment above the
  // call is prose, and it was the one this edited.
  const object = LOCALES_OBJECT.exec(stripComments(source));
  if (object === null) return undefined;
  const [whole, head = '', inner = ''] = object;
  // A comment INSIDE the object cannot be carried through a one-line rewrite: refused, with the
  // edit named, rather than dropped.
  if (source.slice(object.index, object.index + whole.length) !== whole) return undefined;
  const body = inner.trim().replace(/,$/, '');
  const entries = [body, ...locales.map(localeEntry)].filter((part) => part !== '').join(', ');
  const withEntries = `${source.slice(0, object.index)}${head} ${entries} }${source.slice(object.index + whole.length)}`;
  const imports = locales.map((locale) => localeImport(locale, split.includes(locale))).join('\n');
  const lastImport = [...withEntries.matchAll(CATALOG_IMPORT)].at(-1);
  if (lastImport === undefined) return `${imports}\n${withEntries}`;
  const at = lastImport.index + lastImport[0].length;
  return `${withEntries.slice(0, at)}\n${imports}${withEntries.slice(at)}`;
}

const refusal = (locales: readonly string[], split: readonly string[]): Finding => ({
  code: 'X_CATALOG_UNREGISTERED',
  cause: `${APP_CATALOGS_PATH} is hand-written in a shape this writer cannot add ${locales.join(', ')} to, so those catalogs are on disk and not selectable`,
  fix: `defineCatalogs({ default, locales: { …, ${locales.map(localeEntry).join(', ')} } })   // in ${APP_CATALOGS_PATH}, below ${locales.map((locale) => localeImport(locale, split.includes(locale))).join(' ')}`,
  at: APP_CATALOGS_PATH,
});
