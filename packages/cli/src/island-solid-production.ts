// Every `solid-js` import in an island chunk resolves to Solid's PRODUCTION browser build.
// `Bun.build({ target: 'browser' })` always adds the `development` export condition and offers no
// option that removes it — `conditions`, `production`, `env` and `define` were each measured under
// Bun 1.4 and none of them does — so without this seam an island ships the dev bundle silently.

// `node:path` by necessity: Bun ships no path API, and this file resolves a package entry back
// to the directory its `exports` map is relative to.
import { dirname, join } from 'node:path';
import type { BunPlugin } from 'bun';
import { IslandBuildFailedError } from './errors';

/**
 * The conditions an island's `solid-js` subpath is resolved under. `development` is the one NOT in
 * the set, which is the whole point of the file; `production` is in it because an island chunk is
 * only ever built to be shipped — `x dev` serves the same chunk the container does, so a second
 * answer here would be a bundle the byte budget never measured.
 */
const ISLAND_CONDITIONS: ReadonlySet<string> = new Set([
  'production',
  'browser',
  'module',
  'import',
  'default',
]);

/** `solid-js` and its subpaths, and nothing else: Solid is the runtime an island is compiled for. */
const SOLID_SPECIFIER = /^solid-js(?:\/|$)/;

/**
 * Node's conditional-exports walk, restricted to what this file needs: the first key of the object
 * that the build's condition set contains, depth-first, with an array as an ordered fallback list.
 * Written out rather than delegated to `Bun.resolveSync` because the ONE thing it has to do
 * differently from Bun's resolver is refuse `development` — and `types` with it, which would
 * otherwise win on Solid's map and hand the bundler a `.d.ts`.
 */
export function selectCondition(node: unknown, conditions: ReadonlySet<string>): string | null {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    for (const alternative of node as readonly unknown[]) {
      const picked = selectCondition(alternative, conditions);
      if (picked !== null) return picked;
    }
    return null;
  }
  if (typeof node !== 'object' || node === null) return null;
  for (const [condition, value] of Object.entries(node)) {
    if (!conditions.has(condition)) continue;
    const picked = selectCondition(value, conditions);
    if (picked !== null) return picked;
  }
  return null;
}

/** One parse per manifest: an island imports Solid from several files, and every file asks again. */
const exportsCache = new Map<string, unknown>();

async function exportsOf(manifest: string): Promise<unknown> {
  const hit = exportsCache.get(manifest);
  if (hit !== undefined || exportsCache.has(manifest)) return hit;
  const parsed: unknown = JSON.parse(await Bun.file(manifest).text());
  const field =
    typeof parsed === 'object' && parsed !== null && 'exports' in parsed
      ? (parsed as { readonly exports?: unknown }).exports
      : undefined;
  exportsCache.set(manifest, field);
  return field;
}

/** Test seam: the cache is process-global because `x dev` rebuilds in one process. */
export function clearSolidExportsCache(): void {
  exportsCache.clear();
}

/**
 * The absolute file `specifier` must resolve to, or `null` for "Bun's own answer is already the
 * right one" — which is every subpath Solid declares as a plain string or a pattern, since a
 * declaration with no conditions on it cannot select the development build.
 */
export async function solidProductionEntry(
  specifier: string,
  resolveDir: string,
  importer: string,
): Promise<string | null> {
  let manifest: string;
  try {
    // `solid-js/package.json` is an `exports` entry of Solid's own map, so this reaches the exact
    // copy the island would have imported — not a hoisted sibling at a different version.
    manifest = Bun.resolveSync('solid-js/package.json', resolveDir);
  } catch {
    // Solid is not installed here. Bun's resolver says so, in its own words, naming the importer.
    return null;
  }
  const field = await exportsOf(manifest);
  const subpath = specifier === 'solid-js' ? '.' : `.${specifier.slice('solid-js'.length)}`;
  if (typeof field !== 'object' || field === null || !(subpath in field)) return null;

  const entry = selectCondition((field as Record<string, unknown>)[subpath], ISLAND_CONDITIONS);
  const file = entry === null ? null : join(dirname(manifest), entry);
  if (file === null || !(await Bun.file(file).exists())) {
    throw new IslandBuildFailedError({
      file: importer.length > 0 ? importer : specifier,
      logs:
        `${specifier} has no production browser entry: ${manifest} answers ` +
        `${entry === null ? 'nothing' : JSON.stringify(entry)} under ` +
        `[${[...ISLAND_CONDITIONS].join(', ')}], and an island may not ship Solid's ` +
        'development build',
    });
  }
  return file;
}

/**
 * The plugin `island-bundle.ts` hands `Bun.build`, beside `solidJsxPlugin`. Stateless apart from
 * the manifest cache, so one frozen descriptor serves every concurrent island build.
 *
 * The absolute path it answers with no longer matches `SOLID_SPECIFIER`, so Solid's own internal
 * `import … from 'solid-js'` is the only re-entry — and that one is wanted: it is how `web.js`
 * reaches `solid.js` rather than `dev.js`.
 */
export const solidProductionPlugin: BunPlugin = {
  name: 'ultimate-island-solid-production',
  setup(build): void {
    build.onResolve({ filter: SOLID_SPECIFIER }, async ({ path, importer, resolveDir }) => {
      const from = resolveDir.length > 0 ? resolveDir : dirname(importer);
      const entry = await solidProductionEntry(path, from, importer);
      return entry === null ? undefined : { path: entry };
    });
  },
};
