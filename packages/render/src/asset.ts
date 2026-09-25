/**
 * `asset('assets/hero.avif')` — the one way a page names a public file of its own: the path under
 * `apps/web/site/assets/` in, its content-hashed URL out. Typed so a path outside that tree or with
 * an extension nothing serves is a compile error, and resolved while the page RENDERS so a file
 * that is not there fails `x build --target static` with `X_ASSET_MISSING`, exactly as a bad
 * `island({ src })` does. The table is the CLI's (`site-assets.ts`); this file holds only the seam.
 */

import { AssetMissingError } from './errors';

/**
 * What the asset surface serves, by extension. A list and not a pattern: each one has a content
 * type the server answers with, and an extension outside it would be a file the export copies and
 * the container serves as `application/octet-stream`.
 */
export const ASSET_EXTENSIONS = [
  'avif',
  'webp',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'ico',
  'woff2',
  'mp4',
  'webm',
  'vtt',
] as const;

export type AssetExtension = (typeof ASSET_EXTENSIONS)[number];

/** Relative to the site surface, always under `assets/`: `assets/brand/logo.svg`. */
export type AssetPath = `assets/${string}.${AssetExtension}`;

/** Maps a declared path to the URL a browser fetches. Throws `X_ASSET_MISSING` on a miss. */
export type AssetResolver = (path: AssetPath) => string;

/** The directory every asset path starts with, and the URL prefix every hashed URL starts with. */
export const ASSET_DIR = 'assets';

const EXTENSIONS: ReadonlySet<string> = new Set(ASSET_EXTENSIONS);

/**
 * Why `path` can never name a servable asset, or `undefined` when it can. Shared with the CLI's
 * table and route, so the page, the build and the server refuse one set of paths — a `..` segment
 * the type admits (`assets/../app.config.ts` is a `string`, and so an `AssetPath` suffix) is
 * refused here, before any disk is asked.
 */
export function assetPathProblem(path: string): string | undefined {
  if (path.includes('\\')) return `"${path}" contains a backslash`;
  const segments = path.split('/');
  if (segments[0] !== ASSET_DIR || segments.length < 2) {
    return `"${path}" is not under ${ASSET_DIR}/`;
  }
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `"${path}" has an empty, "." or ".." segment`;
  }
  const name = segments[segments.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
  if (!EXTENSIONS.has(extension)) {
    return `"${path}" has an extension the asset surface does not serve (one of ${ASSET_EXTENSIONS.join(', ')})`;
  }
  return undefined;
}

/**
 * Registered globally, like the island brand, so two copies of this module — the app's and the
 * CLI's, resolved through different `node_modules` — read the table one boot installed.
 */
const RESOLVER_SLOT: unique symbol = Symbol.for('ultimate.render.assetResolver') as never;

interface ResolverHolder {
  [RESOLVER_SLOT]?: AssetResolver | undefined;
}

const holder = globalThis as unknown as ResolverHolder;

/**
 * Installed by the process that renders: `loadApp` does it for `x dev`, the container and the
 * static build alike. `undefined` uninstalls — a test that installed one hands the slot back.
 */
export function setAssetResolver(resolver: AssetResolver | undefined): void {
  holder[RESOLVER_SLOT] = resolver;
}

/**
 * The hashed URL of one site asset, e.g. `/assets/hero.3f2a1b9c.avif`, served
 * `public, max-age=31536000, immutable`. Call it in a page or a server component and hand the URL
 * to an island as a prop: a browser has no asset table, and an island calling this throws.
 */
export function asset(path: AssetPath): string {
  const problem = assetPathProblem(path);
  if (problem !== undefined) {
    throw new AssetMissingError(
      `asset(${JSON.stringify(path)}): ${problem}`,
      `name a file under apps/web/site/${ASSET_DIR}/ with one of: ${ASSET_EXTENSIONS.join(', ')}`,
    );
  }
  const resolver = holder[RESOLVER_SLOT];
  if (resolver === undefined) {
    throw new AssetMissingError(
      `asset(${JSON.stringify(path)}) ran with no site asset table installed — in a browser (an island), or in a test that never loaded the app`,
      'call asset() in the page and pass the URL to the island as a prop; a unit test installs a table with setAssetResolver((path) => "/" + path)',
    );
  }
  return resolver(path);
}
