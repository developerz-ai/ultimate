// The translator stand-in for `scaffold-smoke`'s generator sweep: every `⟦<default value>⟧` the
// sweep's generators wrote into a non-default catalog becomes `<locale>: <default value>`.
//
// Why it exists only here: the sweep is synthetic, twenty generators no person reads. In a real
// app that placeholder IS the instruction to translate (`generate-catalog-locales.ts`), and the
// `i18n` step stays red until a person does. A placeholder present before the sweep — one a shape
// authored — is never touched, and a single-locale app has nothing to stand in for.

import type { Catalog } from '@ultimat3/i18n';
import { loadCatalog } from '@ultimat3/i18n';
import { resolveDefaultLocale, serializeCatalog } from '../../packages/cli/src/i18n-audit';
import { loudMiss } from '../../packages/cli/src/i18n-registration';

/** Every catalog of one app, by locale, flattened. */
export type CatalogSet = Readonly<Record<string, Catalog>>;

export interface StandIn {
  /** Placeholders replaced, across every locale. */
  readonly translated: number;
  /** Each locale that changed, whole: what is written back. */
  readonly catalogs: CatalogSet;
}

/** The stand-ins for `after`, against the `before` snapshot taken ahead of the sweep. */
export function standIn(before: CatalogSet, after: CatalogSet, fallback: string): StandIn {
  const source = after[fallback] ?? {};
  let translated = 0;
  const catalogs: Record<string, Catalog> = {};
  // The default locale skips itself: no value is the marker of itself.
  for (const [locale, catalog] of Object.entries(after)) {
    const next: Record<string, string> = { ...catalog };
    let changed = false;
    for (const [key, value] of Object.entries(catalog)) {
      const original = source[key];
      // Exactly the marker `localiseCatalogs` writes — `⟦<default value>⟧` — and new since the snapshot.
      if (original === undefined || value !== loudMiss(original)) continue;
      if (before[locale]?.[key] === value) continue;
      next[key] = `${locale}: ${original}`;
      translated += 1;
      changed = true;
    }
    if (changed) catalogs[locale] = next;
  }
  return { translated, catalogs };
}

const CATALOG_DIR = 'packages/i18n/catalogs';

const isMissingDir = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

/** The catalog file names under `root`; none when the app ships no catalog directory. */
async function catalogFiles(root: string): Promise<readonly string[]> {
  try {
    return await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: root }));
  } catch (error) {
    if (isMissingDir(error)) return [];
    throw error;
  }
}

/** The app's catalogs on disk, by locale, flattened. */
export async function readCatalogs(dir: string): Promise<CatalogSet> {
  const root = `${dir}/${CATALOG_DIR}`;
  const entries = await Promise.all(
    (await catalogFiles(root)).map(async (name) => {
      const parsed: unknown = await Bun.file(`${root}/${name}`).json();
      return [name.slice(0, -'.json'.length), loadCatalog(parsed)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Writes each changed locale back, in the layout the generators write it; answers how many. The
 * default is `x i18n add`'s own rule over the files (`en` when present, the only one otherwise): a
 * scaffold always ships `en`, and the generators seeded every other locale from it.
 */
export async function translateSweep(dir: string, before: CatalogSet): Promise<number> {
  const after = await readCatalogs(dir);
  const fallback = resolveDefaultLocale(undefined, after);
  if (fallback === undefined) return 0;
  const result = standIn(before, after, fallback);
  for (const [locale, catalog] of Object.entries(result.catalogs)) {
    await Bun.write(`${dir}/${CATALOG_DIR}/${locale}.json`, serializeCatalog(catalog));
  }
  return result.translated;
}

/** The sweep's own line for the pass: how many placeholders stood in, or that none needed to. */
export const translatedLine = (translated: number): string =>
  translated === 0
    ? '  ✓ translator stand-in: no generator placeholder in a non-default catalog'
    : `  ✓ translator stand-in: ${translated} generator placeholder(s) → "<locale>: <default value>"`;
