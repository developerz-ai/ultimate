// `/favicon.ico`, which every browser requests unprompted and no Ultimate app answered: the
// scaffold wrote no file and neither served surface mounted a route, so a permanent 404 sat in the
// console of every app the framework produces. The app's own file wins; the framework answers when
// there is none, so an app inherits a clean console rather than a file it has to remember to add.

// why: Bun exposes no path-join primitive, and `FAVICON_SOURCE` is app-root-relative, so resolving
// it against the root is string work no `Bun.file` overload does — the same necessity
// `dev-assets.ts` records for `ICON_SOURCE`.
import { join } from 'node:path';
import { createRaster, encodeImage } from '@ultimat3/core';
import type { CacheHint, Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders } from '@ultimat3/http';

/** What a browser asks for with no `<link rel="icon">` to tell it otherwise. */
export const FAVICON_PATH = '/favicon.ico';

/**
 * The one file an app overrides it with — beside `ICON_SOURCE`, in the same directory, because
 * `apps/web/site/` is already where an app's public files live. One path, never a search order: a
 * mechanism that accepted `favicon.png` too would be two ways to do one thing, and an app whose
 * icon is not there would have to be told which of them won.
 */
export const FAVICON_SOURCE = 'apps/web/site/favicon.ico';

/** 32px, which is what a browser tab and a bookmark bar both ask for. */
const DEFAULT_SIZE = 32;

/**
 * Not a colour: one mid-grey LEVEL written to all three channels, exactly as
 * `templates/scaffold-icon.ts` argues — `@ultimat3/ui` owns the colour roles and `cli -> ui` is a
 * boundary error, so a placeholder here must claim no brand colour to begin with.
 */
const MARK_LEVEL = 128;
const OPAQUE = 255;

const FAVICON_CACHE: CacheHint = { mode: 'public', maxAgeSeconds: 3600 };

/**
 * The framework's answer when the app declares none: a solid 32x32 PNG, encoded through
 * `@ultimat3/core`'s own pipeline rather than shipped as an opaque blob — the same encoder
 * `x new`'s icon goes through, so there is no second image format in the tree and no base64
 * constant nobody can verify. Served as `image/png` under an `.ico` URL, which every browser reads
 * by content type; a real ICO container would be a fourth format for one placeholder.
 *
 * Deliberately NOT derived from `ICON_SOURCE`: resizing the app's install icon needs
 * `@ultimat3/pwa`'s pipeline and would make the answer depend on a file that may be missing, which
 * is a third rung under a mechanism that has exactly two.
 */
export function defaultFavicon(): Uint8Array {
  const raster = createRaster(DEFAULT_SIZE, DEFAULT_SIZE, 'favicon');
  const { pixels } = raster;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = MARK_LEVEL;
    pixels[i + 1] = MARK_LEVEL;
    pixels[i + 2] = MARK_LEVEL;
    pixels[i + 3] = OPAQUE;
  }
  return encodeImage(raster, 'png');
}

/** Encoded once per process: the bytes are a pure function of two constants. */
let builtin: Uint8Array | undefined;

const builtinBytes = (): Uint8Array => {
  builtin ??= defaultFavicon();
  return builtin;
};

const iconResponse = (bytes: Uint8Array, contentType: string): Response =>
  applyCacheHeaders(
    // Copied, not passed through: a `Uint8Array<ArrayBufferLike>` may be backed by a
    // `SharedArrayBuffer`, which `Response` does not accept — `dev-assets.ts`'s rule, verbatim.
    new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } }),
    FAVICON_CACHE,
  );

/** What a surface answers with, and what it says the bytes are. */
export interface FaviconBytes {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * Read per REQUEST, never once at boot: `x dev` is a running process an author drops a favicon
 * into, and a route that captured "there was no file" at startup would keep answering the
 * placeholder until the server was restarted — the class of dev/prod difference this package's
 * own header forbids.
 *
 * Its own function because the static export has no process to ask: `prerenderSite` writes these
 * same bytes into the artifact, and a second rule for which favicon a static build carries would
 * be a build whose tab icon differs from the server's.
 */
export async function faviconBytes(root: string): Promise<FaviconBytes> {
  const own = Bun.file(join(root, FAVICON_SOURCE));
  if (await own.exists()) return { bytes: await own.bytes(), contentType: 'image/x-icon' };
  return { bytes: builtinBytes(), contentType: 'image/png' };
}

export async function faviconResponse(root: string): Promise<Response> {
  const favicon = await faviconBytes(root);
  return iconResponse(favicon.bytes, favicon.contentType);
}

/**
 * Mounted through `assetRoutes`, so `x dev`, the container and every test that boots either get it
 * from one place. Public by definition — a browser requests it before anyone has signed in.
 */
export const faviconRoute = (root: string): Route => ({
  method: 'GET',
  path: FAVICON_PATH,
  meta: { name: 'assets.favicon', auth: 'public', cache: FAVICON_CACHE, tags: ['assets'] },
  handler: async (_request: UltimateRequest): Promise<Response> => faviconResponse(root),
});
