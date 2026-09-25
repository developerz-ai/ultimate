// Serving `apps/web/site/assets/**` at the hashed URLs `asset()` mints. Mounted by `assetRoutes`,
// which both `x dev` and the container compose, so a picture that paints on a laptop paints in the
// image. Byte ranges are answered because Safari will not play an `<video>` from a server that
// ignores `Range`, and a film that plays everywhere but an iPhone is not a film that ships.

import { isUltimateError } from '@ultimat3/core';
import type { CacheHint, Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders, json } from '@ultimat3/http';
import type { SiteAsset, SiteAssetTable } from './site-assets';
import { parseHashedAssetUrl, SITE_ASSET_BASE_PATH } from './site-assets';

/** The URL is the content, so the answer is `public, max-age=31536000, immutable`. */
export const SITE_ASSET_CACHE: CacheHint = { mode: 'immutable' };

const notFound = (code: string, cause: string, fix: string): Response =>
  json({ ok: false, error: { code, cause, fix } }, { status: 404 });

/** One `bytes=` range, resolved against the file's size; `null` when it cannot be satisfied. */
export function byteRange(
  header: string | null,
  size: number,
): { readonly start: number; readonly end: number } | null | undefined {
  if (header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // A multi-range or a unit we do not speak: RFC 9110 lets a server ignore Range and send it all.
  if (match === null) return undefined;
  const [, from = '', to = ''] = match;
  if (from === '' && to === '') return null;
  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || end < start) return null;
  return { start, end };
}

function assetResponse(asset: SiteAsset, range: string | null): Response {
  const file = Bun.file(asset.file);
  const headers: Record<string, string> = {
    'content-type': asset.contentType,
    'accept-ranges': 'bytes',
  };
  const wanted = byteRange(range, asset.bytes);
  if (wanted === null) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${String(asset.bytes)}` },
    });
  }
  if (wanted === undefined) {
    return applyCacheHeaders(new Response(file, { headers }), SITE_ASSET_CACHE);
  }
  return applyCacheHeaders(
    new Response(file.slice(wanted.start, wanted.end + 1), {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${String(wanted.start)}-${String(wanted.end)}/${String(asset.bytes)}`,
      },
    }),
    SITE_ASSET_CACHE,
  );
}

/**
 * Only the HASHED name is served, and only while the bytes still hash to it: an immutable answer
 * under a URL whose bytes changed would be cached for a year by every CDN that saw it. A stale
 * hash is a document from an earlier build, and says so.
 */
export function siteAssetRoutes(table: SiteAssetTable): readonly Route[] {
  return [
    {
      method: 'GET',
      path: `${SITE_ASSET_BASE_PATH}/*file`,
      meta: { name: 'assets.site', auth: 'public', tags: ['assets'] },
      handler: (request: UltimateRequest): Response => {
        const named = parseHashedAssetUrl(request.pathname);
        if (named === undefined) {
          return notFound(
            'X_ROUTE_NOT_FOUND',
            `${request.pathname} is not a hashed site asset URL`,
            "name the file with asset('assets/…') in the page, which returns the URL this route serves",
          );
        }
        let asset: SiteAsset;
        try {
          asset = table.resolve(named.path);
        } catch (error) {
          if (!isUltimateError(error)) throw error;
          return notFound(error.code, error.cause, error.fix);
        }
        if (asset.hash !== named.hash) {
          return notFound(
            'X_ROUTE_NOT_FOUND',
            `${named.path} is at ${asset.url} now — the document asking for ${request.pathname} was rendered against earlier bytes`,
            'reload the page; it names the current URL',
          );
        }
        return assetResponse(asset, request.headers.get('range'));
      },
    },
  ];
}
