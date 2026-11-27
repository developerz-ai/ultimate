// A locale split across files — `catalogs/<locale>/<namespace>.json` — as pure data: the key
// prefix a file's path stands for, the files joined into one catalog with every key held by exactly
// one of them, and a catalog partitioned back into its files. This package never reads a file: the
// CLI hands each one over parsed, with its path.

import { type Catalog, catalogKeys, flattenCatalog, parseNestedCatalog } from './catalog';
import { catalogInvalid, catalogKeyDuplicate } from './errors';

/** One namespace file of a split locale, already parsed. */
export interface CatalogFile {
  /** Where it lives, as the error that names it should print it (root-relative). */
  readonly path: string;
  /** Relative to the locale's directory, `/`-separated: `billing.json`, `site/home.json`. */
  readonly name: string;
  /** The parsed JSON — validated here, so a caller never trusts it. */
  readonly value: unknown;
}

/** `catalog.ts`'s key-segment rule: a directory or a file stem IS a key segment here. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** `site/home.json` → `site.home`: the key prefix every entry of that file is read under. */
export function catalogFilePrefix(name: string): string {
  const segments = name.replace(/\.json$/, '').split('/');
  if (!name.endsWith('.json') || !segments.every((segment) => SEGMENT.test(segment))) {
    throw catalogInvalid(
      name,
      'a namespace file is named by its key segments: each directory and the file stem match /^[A-Za-z0-9_-]+$/',
    );
  }
  return segments.join('.');
}

/** `site.home` → `site/home.json`: the inverse, for a writer that places a new namespace. */
export const catalogFileName = (prefix: string): string => `${prefix.split('.').join('/')}.json`;

/**
 * Every file of one locale as the one catalog it ships. A key two files define is
 * `X_CATALOG_KEY_DUPLICATE`, naming both — and so is a leaf one file defines that another file
 * nests under (`site.home` in `site.json`, `site/home.json` beside it): the app's index merges the
 * files into one object, so either way one wording would vanish without a word.
 *
 * Files are joined in name order, so which file an error names first never depends on how the
 * directory happened to list.
 */
export function joinCatalogFiles(files: readonly CatalogFile[]): Catalog {
  const joined = Object.create(null) as Record<string, string>;
  const owner = new Map<string, string>();
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const file of ordered) {
    const prefix = catalogFilePrefix(file.name);
    const catalog = flattenCatalog(parseNestedCatalog(file.value, prefix), prefix);
    for (const [key, value] of Object.entries(catalog)) {
      const prior = owner.get(key);
      if (prior !== undefined) throw catalogKeyDuplicate(key, [prior, file.path]);
      owner.set(key, file.path);
      joined[key] = value;
    }
  }
  for (const [key, path] of owner) {
    const segments = key.split('.');
    for (let length = 1; length < segments.length; length += 1) {
      const leafAt = owner.get(segments.slice(0, length).join('.'));
      if (leafAt !== undefined) {
        throw catalogKeyDuplicate(segments.slice(0, length).join('.'), [leafAt, path]);
      }
    }
  }
  return joined;
}

/**
 * `catalog` as the files a split locale holds it in, keyed by file name, each with its keys
 * relative to the file's prefix. A key goes to the file of its LONGEST prefix among `names` — so
 * `site.home.title` lands in `site/home.json` when that file exists — else to its namespace's own
 * file, `billing.plans.pro` to `billing.json`, which the writer then creates. A top-level leaf has
 * no namespace to live in, and is refused: a split catalog is namespaces all the way down.
 */
export function partitionCatalog(
  catalog: Catalog,
  names: readonly string[] = [],
): ReadonlyMap<string, Catalog> {
  const prefixes = names.map(catalogFilePrefix).sort((a, b) => b.length - a.length);
  const parts = new Map<string, Record<string, string>>();
  for (const key of catalogKeys(catalog)) {
    const value = catalog[key];
    if (value === undefined) continue;
    const prefix =
      prefixes.find((candidate) => key.startsWith(`${candidate}.`)) ?? namespaceOf(key);
    const name = catalogFileName(prefix);
    const part = parts.get(name) ?? (Object.create(null) as Record<string, string>);
    part[key.slice(prefix.length + 1)] = value;
    parts.set(name, part);
  }
  return parts;
}

function namespaceOf(key: string): string {
  const dot = key.indexOf('.');
  if (dot === -1) {
    throw catalogInvalid(
      key,
      `a split catalog keeps every key under a namespace, and "${key}" has none — nest it under one (common.${key}) and rename its t() calls`,
    );
  }
  return key.slice(0, dot);
}
