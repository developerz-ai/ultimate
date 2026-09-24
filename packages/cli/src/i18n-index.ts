// The one writer of `packages/i18n/src/index.ts`, shared by `x g` and `x i18n add|sync`.
//
// A catalog file existing on disk and the app being able to SELECT that locale are two different
// facts, and only this closes the gap: the index hardcodes `locales: { en }`, so a locale whose
// catalog nothing registered renders `⟦key⟧` — which the gate's `i18n` step refuses outright
// (`X_CATALOG_UNREGISTERED`). `x i18n add fr` wrote the file, touched nothing else, and left
// `x verify` red with a fix line that named an edit nobody could perform (#F4).

// why: Bun has no synchronous existence check — `Bun.file(p).exists()` is async, and this decides
// whether to write at all, before any await the caller could interleave with.
import { existsSync } from 'node:fs';
import { containedPath } from './generate-write';
import type { Finding } from './output';
import { CATALOG_ROOT, i18nIndex, localeEntry, localeImport } from './templates';

export const I18N_INDEX_PATH = 'packages/i18n/src/index.ts';

/** Every locale with a catalog on disk, sorted — the file names are the tags. */
export async function catalogLocales(root: string): Promise<readonly string[]> {
  const catalogDir = containedPath(root, CATALOG_ROOT);
  if (!existsSync(catalogDir)) return [];
  const locales: string[] = [];
  for await (const entry of new Bun.Glob('*.json').scan({ cwd: catalogDir, absolute: false })) {
    locales.push(entry.replace(/\.json$/, ''));
  }
  return locales.sort();
}

/** What a sync did: whether every catalog on disk is now selectable, and why not when it is not. */
export interface IndexSync {
  /** False for an app with no i18n package, or an index this writer refused to edit. */
  readonly registered: boolean;
  readonly findings: readonly Finding[];
}

const CATALOG_IMPORT = /^import (\w+) from '\.\.\/catalogs\/([^']+)\.json';$/gm;
const LOCALES_OBJECT = /(locales:\s*\{)([^{}]*)(\})/;

/** The tags the index imports a catalog for, in file order. */
const importedLocales = (source: string): readonly string[] =>
  [...source.matchAll(CATALOG_IMPORT)].map((match) => match[2] ?? '');

/**
 * Makes every catalog on disk selectable, and touches the index no more than that takes.
 *
 * An index that IS the template's output (for the locales it imports) is the framework's file and
 * is re-derived whole. Anything else is the author's: each missing locale gets its import and its
 * `locales: { … }` entry and nothing else moves — the declared `default`, and any code beside it,
 * stay. A shape with no `locales: { … }` object to add to is refused with the edit named, never
 * overwritten: it was, on every `x g`, with a template hard-coding `default: 'en'`.
 */
export async function syncI18nIndex(root: string): Promise<IndexSync> {
  const indexAbsolute = containedPath(root, I18N_INDEX_PATH);
  if (!existsSync(indexAbsolute)) return { registered: false, findings: [] };
  const current = await Bun.file(indexAbsolute).text();
  const onDisk = await catalogLocales(root);
  const imported = importedLocales(current);
  if (current === i18nIndex(imported)) {
    await Bun.write(indexAbsolute, i18nIndex(onDisk));
    return { registered: true, findings: [] };
  }
  const missing = onDisk.filter((locale) => !imported.includes(locale));
  if (missing.length === 0) return { registered: true, findings: [] };
  const edited = withLocales(current, missing);
  if (edited === undefined) return { registered: false, findings: [refusal(missing)] };
  await Bun.write(indexAbsolute, edited);
  return { registered: true, findings: [] };
}

/** Each import after the last catalog import (or at the top), each entry at the object's end. */
function withLocales(source: string, locales: readonly string[]): string | undefined {
  const object = LOCALES_OBJECT.exec(source);
  if (object === null) return undefined;
  const body = (object[2] ?? '').trim().replace(/,$/, '');
  const entries = [body, ...locales.map(localeEntry)].filter((part) => part !== '').join(', ');
  const withEntries = source.replace(LOCALES_OBJECT, `$1 ${entries} $3`);
  const imports = locales.map(localeImport).join('\n');
  const lastImport = [...withEntries.matchAll(CATALOG_IMPORT)].at(-1);
  if (lastImport === undefined) return `${imports}\n${withEntries}`;
  const at = lastImport.index + lastImport[0].length;
  return `${withEntries.slice(0, at)}\n${imports}${withEntries.slice(at)}`;
}

const refusal = (locales: readonly string[]): Finding => ({
  code: 'X_CATALOG_UNREGISTERED',
  cause: `${I18N_INDEX_PATH} is hand-written in a shape this writer cannot add ${locales.join(', ')} to, so those catalogs are on disk and not selectable`,
  fix: `edit ${I18N_INDEX_PATH} — add ${locales.map(localeImport).join(' ')} and ${locales.map(localeEntry).join(', ')} to the locales passed to defineCatalogs`,
  at: I18N_INDEX_PATH,
});
