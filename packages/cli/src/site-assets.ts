// The site asset table: every file under `apps/web/site/assets/`, named by a content-hashed URL.
// One table per app root answers all three questions — the URL `asset()` returns while a page
// renders, the file `/assets/*` serves, and the copy `x build --target static` writes — so the
// page, the container and the CDN can never name one file three ways.

// why: `asset()` is called from a synchronous render, so the table answers synchronously — and Bun
// ships no sync stat or sync read; `join`/`relative` because Bun ships no path API either.
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path'; // why: Bun ships no path API.
import type { AssetExtension, AssetPath } from '@ultimat3/render';
import { ASSET_DIR, AssetMissingError, assetPathProblem } from '@ultimat3/render';

/** App-root-relative, beside `favicon.ico`: `apps/web/site/` is where an app's public files live. */
export const SITE_ASSETS_SOURCE = `apps/web/site/${ASSET_DIR}`;

/** The URL prefix every hashed asset is served under, and the export directory it is copied to. */
export const SITE_ASSET_BASE_PATH = `/${ASSET_DIR}`;

/** What each served extension IS. `vtt` carries a charset: captions are text a player decodes. */
export const ASSET_CONTENT_TYPES: Readonly<Record<AssetExtension, string>> = {
  avif: 'image/avif',
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  mp4: 'video/mp4',
  webm: 'video/webm',
  vtt: 'text/vtt; charset=utf-8',
};

export interface SiteAsset {
  /** As `asset()` names it: `assets/brand/logo.svg`. */
  readonly path: AssetPath;
  /** Absolute path on disk. */
  readonly file: string;
  /** xxHash32 of the bytes, 8 hex characters — the algorithm `contentHash` uses for CSS. */
  readonly hash: string;
  /** `/assets/brand/logo.<hash>.svg`. */
  readonly url: string;
  readonly contentType: string;
  readonly bytes: number;
}

const splitExtension = (path: string): { readonly stem: string; readonly extension: string } => {
  const dot = path.lastIndexOf('.');
  return { stem: path.slice(0, dot), extension: path.slice(dot + 1) };
};

/** The hash goes before the extension, so a static host still infers the type from the name. */
export function hashedAssetUrl(path: AssetPath, hash: string): string {
  const { stem, extension } = splitExtension(path);
  return `/${stem}.${hash}.${extension}`;
}

const HASHED = /^\/(assets\/.+)\.([0-9a-f]{8})\.([a-z0-9]+)$/i;

/** The inverse of `hashedAssetUrl`: which asset a request names, and at which content. */
export function parseHashedAssetUrl(
  pathname: string,
): { readonly path: AssetPath; readonly hash: string } | undefined {
  const match = HASHED.exec(pathname);
  if (match === null) return undefined;
  const path = `${match[1] ?? ''}.${match[3] ?? ''}`;
  if (assetPathProblem(path) !== undefined) return undefined;
  return { path: path as AssetPath, hash: match[2] ?? '' };
}

const hashBytes = (bytes: Uint8Array): string =>
  Bun.hash.xxHash32(bytes).toString(16).padStart(8, '0');

export interface SiteAssetTable {
  /** The asset `asset()` named, hashed as the bytes are NOW. Throws `X_ASSET_MISSING`. */
  resolve(path: AssetPath): SiteAsset;
  /** Every servable file under the source directory, sorted by path. */
  all(): readonly SiteAsset[];
}

const missing = (path: string, cause: string): AssetMissingError =>
  new AssetMissingError(
    `asset(${JSON.stringify(path)}): ${cause}`,
    `add the file at ${SITE_ASSETS_SOURCE}/${path.slice(ASSET_DIR.length + 1)}, or correct the path passed to asset(), then x build --target static --json`,
  );

/**
 * A stat per call, a read only when the file changed: `x dev` sees an edited image under a new URL
 * on the next render with no watcher, and the container — whose files never change — pays one
 * `stat` per `asset()` call and nothing else. One behaviour in both, never a dev-only rescan.
 */
export function createSiteAssetTable(root: string): SiteAssetTable {
  const source = join(root, SITE_ASSETS_SOURCE);
  const cache = new Map<string, { readonly stamp: string; readonly asset: SiteAsset }>();

  const resolve = (path: AssetPath): SiteAsset => {
    const problem = assetPathProblem(path);
    if (problem !== undefined) throw missing(path, problem);
    const file = join(source, path.slice(ASSET_DIR.length + 1));
    let stamp: string;
    try {
      const stat = statSync(file);
      if (!stat.isFile()) throw missing(path, `${file} is not a file`);
      stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`;
    } catch (error) {
      if (error instanceof AssetMissingError) throw error;
      throw missing(path, `no file at ${SITE_ASSETS_SOURCE}/${path.slice(ASSET_DIR.length + 1)}`);
    }
    const cached = cache.get(path);
    if (cached !== undefined && cached.stamp === stamp) return cached.asset;
    const bytes = readFileSync(file);
    const hash = hashBytes(bytes);
    // `assetPathProblem` already refused an unknown extension; the guard keeps `constructor` from
    // ever answering an `Object` member if that check is loosened.
    const extension = splitExtension(path).extension.toLowerCase();
    const asset: SiteAsset = {
      path,
      file,
      hash,
      url: hashedAssetUrl(path, hash),
      contentType: Object.hasOwn(ASSET_CONTENT_TYPES, extension)
        ? ASSET_CONTENT_TYPES[extension as AssetExtension]
        : 'application/octet-stream',
      bytes: bytes.byteLength,
    };
    cache.set(path, { stamp, asset });
    return asset;
  };

  const all = (): readonly SiteAsset[] => {
    const found: SiteAsset[] = [];
    let files: string[];
    try {
      files = [...new Bun.Glob('**/*').scanSync({ cwd: source, onlyFiles: true })];
    } catch {
      // No `assets/` directory is an app with no assets, not an error.
      return [];
    }
    for (const relativePath of files.sort()) {
      const path = `${ASSET_DIR}/${relativePath.split('\\').join('/')}`;
      // A source file beside its renditions (a `.psd`, a `README.md`) is not a served asset.
      if (assetPathProblem(path) !== undefined) continue;
      found.push(resolve(path as AssetPath));
    }
    return found;
  };

  return { resolve, all };
}

/** One table per root, so the renderer and the route read the same cache. */
const tables = new Map<string, SiteAssetTable>();

export function siteAssetTable(root: string): SiteAssetTable {
  let table = tables.get(root);
  if (table === undefined) {
    table = createSiteAssetTable(root);
    tables.set(root, table);
  }
  return table;
}

/**
 * Every asset, copied into the static export under its hashed URL — a static host serves with no
 * process behind it, so the artifact carries every byte a document names. Returns the URLs written.
 */
export function writeSiteAssets(root: string, out: string): readonly string[] {
  const written: string[] = [];
  for (const asset of siteAssetTable(root).all()) {
    const target = join(out, asset.url.slice(1));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(asset.file, target);
    written.push(asset.url);
  }
  return written;
}
