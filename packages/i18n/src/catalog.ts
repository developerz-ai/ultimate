/**
 * Catalog shape only: nested authoring (`{ nav: { home: 'Home' } }`) → flat dot-key
 * lookup (`nav.home`), plus merging framework strings under app strings.
 */

import { catalogInvalid } from './errors';

/** What authors write, and what `catalogs/<locale>.json` contains. */
export type NestedCatalog = { readonly [key: string]: string | NestedCatalog };

/** What the translator consumes: flat dot-keys → template strings. */
export type Catalog = Readonly<Record<string, string>>;

const KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Depth-first flatten. Throws `X_CATALOG_INVALID` on a non-string leaf (arrays and
 * numbers are the two mistakes translators actually make) or a duplicate flat key.
 */
export function flattenCatalog(source: NestedCatalog, prefix = ''): Catalog {
  const flat: Record<string, string> = {};
  walk(source, prefix, flat);
  return flat;
}

/** Validate an untrusted value (a parsed JSON file) as a nested catalog. */
export function parseNestedCatalog(value: unknown, path = ''): NestedCatalog {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw catalogInvalid(path || '<root>', `expected an object, got ${describe(value)}`);
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (!KEY_SEGMENT.test(key)) {
      throw catalogInvalid(childPath, 'key segments must match /^[A-Za-z0-9_-]+$/');
    }
    if (typeof child === 'string') continue;
    parseNestedCatalog(child, childPath);
  }
  return value as NestedCatalog;
}

/** Parse + flatten in one step — the loader every catalog file goes through. */
export function loadCatalog(value: unknown, prefix = ''): Catalog {
  return flattenCatalog(parseNestedCatalog(value), prefix);
}

/**
 * Later catalogs win. Call order is framework strings first, app strings last, so an
 * app can override `errors.notFound.title` without forking the framework catalog.
 */
export function mergeCatalogs(...catalogs: readonly Catalog[]): Catalog {
  const merged: Record<string, string> = {};
  for (const catalog of catalogs) {
    for (const key of Object.keys(catalog)) {
      const value = catalog[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

export function catalogKeys(catalog: Catalog): string[] {
  return Object.keys(catalog).sort();
}

/** Keys present in `base` but absent from `target` — the extractor's diff primitive. */
export function missingFrom(base: Catalog, target: Catalog): string[] {
  return catalogKeys(base).filter((key) => !Object.hasOwn(target, key));
}

function walk(node: NestedCatalog, prefix: string, out: Record<string, string>): void {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') {
      if (Object.hasOwn(out, path)) {
        throw catalogInvalid(path, 'duplicate key — a nested branch and a dotted key collide');
      }
      out[path] = value;
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw catalogInvalid(path, `expected a string or an object, got ${describe(value)}`);
    }
    walk(value, path, out);
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
