// Where an app's catalogs live, per locale: one flat `catalogs/<locale>.json`, or a directory
// `catalogs/<locale>/` of namespace files (`billing.json`, `site/home.json`) joined by a generated
// `index.ts`. Every CLI reader and writer of an app's catalogs asks this module, so the two forms
// are one answer: read, loaded, named in a finding, and written back in the form they came in.

// why: `node:` and not Bun: `Bun.file().exists()` answers false for a directory and Bun has no
// directory listing, and both are how a split locale is told from a flat one; Bun has no path API
// at all, so `join` builds what `Bun.file` reads.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderThrowable } from '@ultimat3/core';
import type { Catalog, Locale } from '@ultimat3/i18n';
import {
  catalogFilePrefix,
  catalogInvalid,
  catalogLayoutMixed,
  joinCatalogFiles,
  loadCatalog,
  partitionCatalog,
} from '@ultimat3/i18n';
import { catalogBarrel } from './templates/catalog-barrel';
import { catalogJson } from './templates/catalog-json';
import { CATALOG_BARREL, CATALOG_ROOT, catalogDir, catalogPath } from './templates/locales';

/** `mixed` is a locale with both — refused on every read, repaired by `x i18n split`. */
export type CatalogForm = 'flat' | 'split' | 'mixed';

export interface LocaleLayout {
  readonly form: CatalogForm;
  /** Split and mixed: every namespace file, relative to the directory, sorted. Flat: none. */
  readonly files: readonly string[];
}

/** Locale → its layout, for every locale with a catalog on disk. */
export type CatalogLayout = Readonly<Record<Locale, LocaleLayout>>;

/** The namespace files of a locale directory, `/`-separated whatever the host's separator. */
async function namespaceFiles(root: string, locale: string): Promise<readonly string[]> {
  const files: string[] = [];
  const cwd = join(root, catalogDir(locale));
  for await (const entry of new Bun.Glob('**/*.json').scan({ cwd, absolute: false })) {
    files.push(entry.replaceAll('\\', '/'));
  }
  return files.sort();
}

/** Every locale on disk and its form. No `catalogs/` directory yet is no locale at all. */
export async function readCatalogLayout(root: string): Promise<CatalogLayout> {
  const dir = join(root, CATALOG_ROOT);
  if (!existsSync(dir)) return {};
  const layout: Record<string, LocaleLayout> = {};
  const entries = readdirSync(dir, { withFileTypes: true });
  const flat = new Set(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length)),
  );
  for (const locale of flat) layout[locale] = { form: 'flat', files: [] };
  for (const entry of entries.filter((one) => one.isDirectory())) {
    const files = await namespaceFiles(root, entry.name);
    layout[entry.name] = { form: flat.has(entry.name) ? 'mixed' : 'split', files };
  }
  return Object.fromEntries(Object.entries(layout).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Where a finding points for `locale`: the flat file, or the directory a split locale is. */
export const catalogLocation = (layout: CatalogLayout | undefined, locale: Locale): string =>
  layout !== undefined && Object.hasOwn(layout, locale) && layout[locale]?.form === 'split'
    ? `${catalogDir(locale)}/`
    : catalogPath(locale);

/**
 * The one file that holds `key` in `locale`: a split locale's namespace file of the key's longest
 * prefix, so a finding about `billing.plans.pro` sends its reader to `en/billing.json` rather than
 * to a directory of forty files. A flat locale, or a key no file prefixes, is `catalogLocation`.
 */
export function catalogFileOf(
  layout: CatalogLayout | undefined,
  locale: Locale,
  key: string,
): string {
  const entry = layout !== undefined && Object.hasOwn(layout, locale) ? layout[locale] : undefined;
  if (entry?.form !== 'split') return catalogLocation(layout, locale);
  const owner = entry.files
    .filter((name) => key.startsWith(`${catalogFilePrefix(name)}.`))
    .sort((a, b) => b.length - a.length)[0];
  return owner === undefined ? `${catalogDir(locale)}/` : `${catalogDir(locale)}/${owner}`;
}

/**
 * A `JSON.parse` failure is still a catalog problem, not a bare-Error crash through the command —
 * reported through the same factory a structural violation uses.
 */
function parseCatalogJson(path: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw catalogInvalid(path, renderThrowable(error));
  }
}

const readJson = async (root: string, path: string): Promise<unknown> =>
  parseCatalogJson(path, await Bun.file(join(root, path)).text());

/** The flat file's catalog: the one `x i18n split` folds into a directory. */
export async function loadFlatCatalog(root: string, locale: Locale): Promise<Catalog> {
  return loadCatalog(await readJson(root, catalogPath(locale)));
}

/** A split locale's directory as one catalog — `X_CATALOG_KEY_DUPLICATE` for a key two files hold. */
export async function loadSplitCatalog(
  root: string,
  locale: Locale,
  files: readonly string[],
): Promise<Catalog> {
  const parts = [];
  for (const name of files) {
    const path = `${catalogDir(locale)}/${name}`;
    parts.push({ path, name, value: await readJson(root, path) });
  }
  return joinCatalogFiles(parts);
}

/**
 * Every locale's catalog, parsed and flattened — never a bare `JSON.parse`: `loadCatalog` is the
 * seam that fails a malformed entry loud (`X_CATALOG_INVALID`) instead of auditing it as empty.
 * A mixed locale is `X_CATALOG_LAYOUT_MIXED`: which half ships is the question it cannot answer.
 */
export async function loadLayoutCatalogs(
  root: string,
  layout: CatalogLayout,
): Promise<Readonly<Record<Locale, Catalog>>> {
  const catalogs: Record<string, Catalog> = {};
  for (const [locale, { form, files }] of Object.entries(layout)) {
    if (form === 'mixed') throw catalogLayoutMixed(locale);
    catalogs[locale] =
      form === 'flat'
        ? await loadFlatCatalog(root, locale)
        : await loadSplitCatalog(root, locale, files);
  }
  return catalogs;
}

/** One file a catalog write lands, root-relative. */
export interface CatalogWrite {
  readonly path: string;
  readonly contents: string;
}

/**
 * The files `catalog` is written as for `locale`, in `form` — each nested and sorted, the bytes
 * `serializeCatalog` writes (`nestCatalog` walks the keys sorted): the one flat file, or one file per
 * namespace — a key going to the existing file of its longest prefix (`files`), else to its
 * namespace's own, created — plus the barrel over every file the directory then holds.
 */
export function catalogWrites(
  locale: Locale,
  catalog: Catalog,
  form: CatalogForm,
  files: readonly string[] = [],
): readonly CatalogWrite[] {
  if (form === 'flat') return [{ path: catalogPath(locale), contents: catalogJson(catalog) }];
  const parts = partitionCatalog(catalog, files);
  const dir = catalogDir(locale);
  // A file `catalog` leaves no key in is written empty, never left behind: the barrel imports it.
  const names = [...new Set([...files, ...parts.keys()])].sort();
  const writes = names.map((name) => ({
    path: `${dir}/${name}`,
    contents: catalogJson(parts.get(name) ?? {}),
  }));
  const barrel = catalogBarrel(names);
  return [...writes, { path: `${dir}/${CATALOG_BARREL}`, contents: barrel }];
}

/**
 * `catalogWrites`, landed: only the files whose bytes change, so a sync that adds one key to
 * `billing` leaves every other namespace file untouched. Answers the paths it wrote.
 */
export async function writeLocaleCatalog(
  root: string,
  locale: Locale,
  catalog: Catalog,
  layout: LocaleLayout | undefined,
): Promise<readonly string[]> {
  const form = layout?.form === 'split' ? 'split' : 'flat';
  const written: string[] = [];
  for (const write of catalogWrites(locale, catalog, form, layout?.files)) {
    const file = Bun.file(join(root, write.path));
    if ((await file.exists()) && (await file.text()) === write.contents) continue;
    await Bun.write(file, write.contents);
    written.push(write.path);
  }
  return written;
}
