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
import { CATALOG_ROOT, i18nIndex } from './templates';

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

/**
 * Re-derives the FULL locale set from `packages/i18n/catalogs/` — never just the locale one
 * invocation asked for — and rewrites the index to match. It bypasses `writeFiles` on purpose:
 * this file is a projection of the catalog directory, never app-authored content a conflict check
 * should protect. An app with no i18n package (deleted, or never scaffolded) is left alone, and
 * that is what `written` reports.
 */
export async function syncI18nIndex(root: string): Promise<boolean> {
  const indexAbsolute = containedPath(root, I18N_INDEX_PATH);
  if (!existsSync(indexAbsolute)) return false;
  await Bun.write(indexAbsolute, i18nIndex(await catalogLocales(root)));
  return true;
}
