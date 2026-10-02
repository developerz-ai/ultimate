// Single responsibility: which PGlite bundle a Postgres extension name resolves to, and which
// names resolve to none. PGlite links an extension only when it is handed over at boot, so every
// embedded boot — `x dev`'s database and the schema dump's scratch replay — asks this one linker,
// and a caller that must choose another engine asks it what is `missing`.

import { PGLITE_PACKAGE } from './pglite-package';

export type PgliteExtensionLoader = (specifier: string) => Promise<unknown>;

export interface LinkedExtensions {
  /** Keyed by the bundle's own export name — what PGlite's `extensions` option takes. */
  readonly linked: Readonly<Record<string, unknown>>;
  /** Postgres names no installed bundle answers for, sorted. */
  readonly missing: readonly string[];
}

/**
 * The name reaches a module specifier, and it is DATA — it is read out of an app's migration
 * text. Lowercase letters, digits, `_` and `-` only, so no name can leave the package.
 */
const EXTENSION_NAME = /^[a-z][a-z0-9_-]*$/;

/** `uuid-ossp` ships as `contrib/uuid_ossp`, exporting `uuid_ossp`. */
export const pgliteExtensionExport = (name: string): string | undefined =>
  EXTENSION_NAME.test(name) ? name.replaceAll('-', '_') : undefined;

/** Compiled into every Postgres: `create extension plpgsql` needs no bundle and is never missing. */
const BUILT_IN: ReadonlySet<string> = new Set(['plpgsql']);

/**
 * Entry points of the package that are not Postgres extensions. Only the second specifier below
 * could reach one, and `live` exports an object PGlite would accept as a plugin.
 */
const NOT_EXTENSIONS: ReadonlySet<string> = new Set([
  'template',
  'live',
  'worker',
  'nodefs',
  'opfs_ahp',
  'basefs',
]);

/**
 * `contrib/<name>` is where 0.5 ships every extension it has. `<name>` at the package root is
 * where earlier and later lines ship the ones that are not contrib (`vector`); asked second, so
 * an install that has it is linked without this file learning a version table.
 */
const specifiersFor = (exported: string): readonly string[] =>
  NOT_EXTENSIONS.has(exported)
    ? [`${PGLITE_PACKAGE}/contrib/${exported}`]
    : [`${PGLITE_PACKAGE}/contrib/${exported}`, `${PGLITE_PACKAGE}/${exported}`];

const importBundle: PgliteExtensionLoader = (specifier) => import(specifier);

async function bundleFor(exported: string, load: PgliteExtensionLoader): Promise<unknown> {
  for (const specifier of specifiersFor(exported)) {
    try {
      const bundle: unknown = await load(specifier);
      const extension = (bundle as Readonly<Record<string, unknown>> | null | undefined)?.[
        exported
      ];
      if (extension !== undefined) return extension;
    } catch {
      // Not at this specifier. Deliberately not an error: the answer is `missing`, and the caller
      // decides what an extension the embedded database cannot link means.
    }
  }
  return undefined;
}

/**
 * Resolve every name. Never throws and never boots anything: a bundle is a small module beside a
 * tarball PGlite reads only when `create extension` runs.
 */
export async function linkPgliteExtensions(
  names: readonly string[],
  load: PgliteExtensionLoader = importBundle,
): Promise<LinkedExtensions> {
  const linked: Record<string, unknown> = {};
  const missing = new Set<string>();
  for (const name of names) {
    if (BUILT_IN.has(name)) continue;
    const exported = pgliteExtensionExport(name);
    const extension = exported === undefined ? undefined : await bundleFor(exported, load);
    if (exported === undefined || extension === undefined) missing.add(name);
    else linked[exported] = extension;
  }
  return { linked, missing: [...missing].sort() };
}
