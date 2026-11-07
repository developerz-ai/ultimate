// The variants of a public site image, served: `responsiveImage({ src: asset('assets/hero.png') })`
// mints `?w=&f=` candidates, and `/assets` answered every one with the full original. This wraps the
// plain route with exactly the variants the markup can mint for that source, decoded once per
// content hash through the pipeline `/media` uses — and refuses every other query before a decode.

import { finiteCount, probeImage, sniffImageFormat } from '@ultimat3/core';
import type { Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders, jsonResponse } from '@ultimat3/http';
import type { ImageQuery, ImageTransformDriver } from '@ultimat3/seo';
import {
  builtinImageDriver,
  DEFAULT_FORMATS,
  DEFAULT_WIDTHS,
  parseImageQuery,
  usableWidths,
} from '@ultimat3/seo';
import { variantLru } from './runtime-assets-site-cache';
import { SITE_ASSET_CACHE, siteAssetRoutes } from './site-asset-routes';
import type { SiteAsset, SiteAssetTable } from './site-assets';
import { parseHashedAssetUrl } from './site-assets';

/** What one process holds of decoded variants. Bounded: an edited asset in `x dev` adds entries. */
export const SITE_VARIANT_CACHE_BYTES = 64 * 1024 * 1024;

/** The sources core's pipeline decodes. An SVG, an icon or a film has no width to resize to. */
const RASTERS: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp', 'gif']);

export interface SiteVariantOptions {
  /** `assetRoutes`' `images`: one driver for `/media` and `/assets`. Omitted, core's pipeline. */
  readonly images?: ImageTransformDriver | undefined;
  /** Bytes of variants kept in memory, least recently used evicted. */
  readonly cacheBytes?: number;
}

type Answer =
  | { readonly bytes: Uint8Array; readonly contentType: string }
  | { readonly refused: string; readonly widths: readonly number[] };

const undeclared = (asset: SiteAsset, cause: string, widths: readonly number[]): Response =>
  jsonResponse(
    {
      ok: false,
      error: {
        code: 'X_ASSET_VARIANT_UNDECLARED',
        cause: `${asset.url}: ${cause} — /assets answers only the variants responsiveImage() mints, so a public URL is never a resize service`,
        fix: `responsiveImage({ src: asset('${asset.path}'), width, height, alt })   # declared here: ?w=${widths.join('|') || 'none'} with ?f=${DEFAULT_FORMATS.join('|')} or no f; an upload under /media answers any width`,
        meta: { url: asset.url, widths: [...widths], formats: [...DEFAULT_FORMATS] },
      },
    },
    { status: 404 },
  );

/**
 * Why a query names no declared variant, or `undefined` when it names one. Widths are the srcset's
 * own (`usableWidths` over `DEFAULT_WIDTHS`, asked rather than restated), formats `DEFAULT_FORMATS`
 * or the source's own, and never a quality: `responsiveImage` writes none.
 */
function undeclaredBy(query: ImageQuery, widths: readonly number[]): string | undefined {
  if (query.quality !== undefined) return `?q=${String(query.quality)} is a quality`;
  if (query.format !== undefined && !(DEFAULT_FORMATS as readonly string[]).includes(query.format))
    return `?f=${query.format} is not an offered format`;
  if (query.width !== undefined && !widths.includes(query.width))
    return `?w=${String(query.width)} is not a srcset width of this source`;
  return undefined;
}

/** The current asset a pathname names, or `undefined` for whatever the plain route answers. */
function currentAsset(table: SiteAssetTable, pathname: string): SiteAsset | undefined {
  const named = parseHashedAssetUrl(pathname);
  if (named === undefined) return undefined;
  try {
    const asset = table.resolve(named.path);
    return asset.hash === named.hash ? asset : undefined;
  } catch {
    // The plain route answers a missing file with its own code; this one only stands aside.
    return undefined;
  }
}

/**
 * `/assets/*file`, the plain route for every request without a transform query — and for a URL
 * that names no current asset, so a stale hash keeps its one answer — and a declared variant else.
 */
export function siteAssetVariantRoutes(
  table: SiteAssetTable,
  options: SiteVariantOptions = {},
): readonly Route[] {
  const cache = variantLru<Answer>(
    finiteCount(
      'siteAssetVariantRoutes',
      'cacheBytes',
      options.cacheBytes ?? SITE_VARIANT_CACHE_BYTES,
    ),
    (answer) => ('bytes' in answer ? answer.bytes.byteLength : undefined),
  );
  return siteAssetRoutes(table).map((plain) => ({
    ...plain,
    handler: async (request: UltimateRequest, ctx): Promise<Response> => {
      const query = parseImageQuery(request.url.searchParams);
      const asset = query === null ? undefined : currentAsset(table, request.pathname);
      if (query === null || asset === undefined) return plain.handler(request, ctx);

      const key = `${asset.hash}:${String(query.width ?? 'own')}:${query.format ?? 'own'}:${String(query.quality ?? '')}`;
      const answer = await cache.get(key, async (): Promise<Answer> => {
        const source = await Bun.file(asset.file).bytes();
        const format = sniffImageFormat(source);
        if (format === null || !RASTERS.has(format)) {
          return { refused: 'the file is not a raster image', widths: [] };
        }
        // A header read: past `MAX_IMAGE_PIXELS` it is core's `X_IMAGE_TOO_LARGE`, before a decode.
        const intrinsic = probeImage(source).width;
        const widths = usableWidths(intrinsic, DEFAULT_WIDTHS);
        const why = undeclaredBy(query, widths);
        if (why !== undefined) return { refused: why, widths };
        const driver = options.images ?? builtinImageDriver({ read: async () => source });
        const made = await driver.transform({
          src: asset.url,
          width: query.width ?? intrinsic,
          ...(query.format === undefined ? {} : { format: query.format }),
        });
        return { bytes: made.bytes, contentType: made.contentType };
      });
      if ('refused' in answer) return undeclared(asset, answer.refused, answer.widths);
      return applyCacheHeaders(
        // Copied: a `Uint8Array` may sit on a `SharedArrayBuffer`, which `Response` refuses.
        new Response(new Uint8Array(answer.bytes), {
          headers: {
            'content-type': answer.contentType,
            'content-length': String(answer.bytes.byteLength),
          },
        }),
        SITE_ASSET_CACHE,
      );
    },
  }));
}
