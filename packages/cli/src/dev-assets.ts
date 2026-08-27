// Projecting the framework's one image pipeline onto the routes `x dev` serves. Three packages
// declare what an image is — `@ultimat3/seo` a variant URL, `@ultimat3/storage` a variant key,
// `@ultimat3/pwa` the icons a web manifest promises — and `@ultimat3/core`'s pipeline owns every
// pixel, so this file picks the two base paths they hang off and decides nothing else. The one
// thing it does NOT decide is who may read a stored object: `/media` borrows that whole answer
// from `dev-storage.ts`, because the same bytes are reachable through both.

import { probeImage } from '@ultimat3/core';
import type { CacheHint, RequestContext, Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders } from '@ultimat3/http';
import type { ImageQuery, ImageTransformDriver } from '@ultimat3/seo';
import { builtinImageDriver, DEFAULT_WIDTHS, parseImageQuery } from '@ultimat3/seo';
import type { ImageTransform, Storage, VariantFormat } from '@ultimat3/storage';
import { isTenantScoped, isVariantFormat, variantKey } from '@ultimat3/storage';
import {
  AUTHORIZED_OBJECT_CACHE,
  assertReadableKey,
  authorizeStorageRead,
  STORAGE_READ_PERMISSION,
} from './dev-storage';
import { faviconRoute } from './favicon';
// The icon matrix's source, its base path and its renderer live in their own module so that
// `pwa-artifacts.ts` — which this file imports for the manifest route — can reach them without
// importing this one back. A cycle between the two would be the manifest and the icons it names
// resolving through each other.
import { iconPlan, iconRenderer } from './icon-assets';
import type { PwaArtifacts } from './pwa-artifacts';
import { pwaManifestRoute } from './pwa-artifacts';

/**
 * Storage-backed images. `responsiveImage({ src: '/media/<key>' })` mints its variants under it.
 * Guarded exactly as `/_storage` is — an object reachable through two URLs must not be reachable
 * on two different terms — so a `src` under this path needs a signed-in reader holding
 * `storage:read`. A genuinely public image belongs in `apps/web/site/`, which is served as a
 * static asset and never touches a disk holding another tenant's uploads.
 */
export const MEDIA_BASE_PATH = '/media';

/**
 * A generated icon and a content-addressed variant answer forever with the same bytes, so the
 * immutable hint is a fact about the key. It is NOT a fact about this route — see `mediaCache`.
 */
const IMMUTABLE_IMAGE: CacheHint = { mode: 'immutable' };

/**
 * Whether a variant is one the framework itself can MINT, and therefore one worth storing.
 *
 * The cache key is built entirely from caller-supplied query values, and a signed-in reader
 * holding `storage:read` may ask for any of them on their own objects — so `?w=1`, `?w=2`, … each
 * wrote a new object to the app's only disk. `@ultimat3/seo`'s `MAX_IMAGE_WIDTH` (8192) bounds the
 * blast radius and does not close it: 8192 stored objects per source, per format, is amplification
 * a tenant drives with a `for` loop.
 *
 * The set is `DEFAULT_WIDTHS` **plus the source's intrinsic width**, which is exactly what
 * `usableWidths` puts in a `srcset` — clamping to the constant alone would refuse the widest entry
 * of every image whose intrinsic width is not one of the eight, a URL the framework mints itself.
 * Anything outside it is still SERVED: this decides what is written, not what is answered, so no
 * caller gains a new 4xx and the disk stops growing on a stranger's key.
 */
const isMintableWidth = (width: number | undefined, intrinsic: number): boolean =>
  width === undefined || width === intrinsic || DEFAULT_WIDTHS.includes(width);

const imageResponse = (bytes: Uint8Array, contentType: string, cache: CacheHint): Response =>
  applyCacheHeaders(
    // Copied, not passed through: a `Uint8Array<ArrayBufferLike>` may be backed by a
    // `SharedArrayBuffer`, which `Response` does not accept, and copying is what makes that true
    // by construction rather than by a cast that would only silence it.
    new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } }),
    cache,
  );

/**
 * Immutable is a claim about the KEY, and a tenant-scoped key names one org's private object: a
 * CDN or shared proxy that stores it under a public URL for a year hands it to every other tenant,
 * which is the cross-tenant read one hop removed. `/media` declared `public, max-age=31536000,
 * immutable` for exactly those keys until this branch. Applied in the handler rather than declared
 * in `meta.cache` because the posture is decided by the key, which no route declaration can see —
 * the pipeline's `cache-headers` stage only fills a `cache-control` a handler did not set.
 */
const mediaCache = (key: string): CacheHint =>
  isTenantScoped(key) ? AUTHORIZED_OBJECT_CACHE : IMMUTABLE_IMAGE;

/**
 * `exactOptionalPropertyTypes` makes an explicit `undefined` a different answer from an absent
 * key, and `variantKey` reads presence — so a spread, never an assignment.
 */
function storageTransform(query: ImageQuery, format: VariantFormat | undefined): ImageTransform {
  return {
    ...(query.width === undefined ? {} : { width: query.width }),
    ...(format === undefined ? {} : { format }),
    ...(query.quality === undefined ? {} : { quality: query.quality }),
  };
}

/**
 * A cache hit costs one `exists` and one `get`; a miss costs a decode. The source is read once
 * either way and handed to the driver rather than fetched again — `read` exists so seo never has
 * to guess whether a `src` is a path, a key or a URL, and here it is unambiguously a storage key.
 */
async function transformedVariant(
  storage: Storage,
  key: string,
  query: ImageQuery,
  images: ImageTransformDriver | undefined,
): Promise<Response> {
  const disk = storage.disk();
  // A format storage cannot name has no variant key, so it cannot be cached. The driver refuses
  // it with core's `X_IMAGE_UNSUPPORTED`; refusing it here too would give one bad URL two codes.
  const format =
    query.format !== undefined && isVariantFormat(query.format) ? query.format : undefined;
  const cacheable = query.format === undefined || format !== undefined;
  const cached = cacheable ? variantKey(key, storageTransform(query, format)) : undefined;
  // The SOURCE key decides the posture, not the variant's: `variantKey` keeps the source's prefix,
  // so a variant of `org/<id>/…` is one org's object too, and reading the hint off the derived key
  // would be a second answer to a question the source already settled.
  const cache = mediaCache(key);
  if (cached !== undefined && (await disk.exists(cached))) {
    const hit = await disk.get(cached);
    return imageResponse(hit.bytes, hit.object.contentType, cache);
  }

  const source = await disk.get(key);
  const intrinsic = probeImage(source.bytes).width;
  // The seam is WHICH driver transforms, not who resolves the bytes: `TransformRequest.width` is
  // required, and a request with no `?w=` gets its width from the source's own header — so the
  // read happens either way and a supplied driver is handed the same resolved request the builtin
  // one gets. Constructed inline before this, with no seam at all, so a deployment that routes
  // transforms through a CDN had to fork the route to do it.
  const driver = images ?? builtinImageDriver({ read: async () => source.bytes });
  const variant = await driver.transform({
    src: key,
    // A header read, not a decode: `?f=webp` alone still needs a width, and the source's own is
    // the only one that does not resize an image the caller never asked to resize.
    width: query.width ?? intrinsic,
    ...(query.format === undefined ? {} : { format: query.format }),
    ...(query.quality === undefined ? {} : { quality: query.quality }),
  });
  if (cached !== undefined && isMintableWidth(query.width, intrinsic)) {
    await disk.put(cached, variant.bytes, { contentType: variant.contentType });
  }
  return imageResponse(variant.bytes, variant.contentType, cache);
}

/**
 * Authorized before a key is parsed and before a disk is touched — the same two calls, in the same
 * order, that `/_storage` makes. This route made NEITHER: it was `auth: 'public'` with no policy
 * and handed the raw client-supplied key to `disk().get`, so every object on the app's only disk
 * was one unauthenticated URL away, and `?w=` made it an unauthenticated `put` besides.
 */
async function mediaResponse(
  request: UltimateRequest,
  ctx: RequestContext,
  storage: Storage,
  images: ImageTransformDriver | undefined,
): Promise<Response> {
  const requested = request.params['key'] ?? '';
  authorizeStorageRead({ disk: storage.defaultDisk, key: requested }, ctx);
  const key = assertReadableKey(requested, ctx.actor);
  const query = parseImageQuery(request.url.searchParams);
  if (query !== null) return transformedVariant(storage, key, query, images);
  // No transform asked for: the object itself, still under the storage key's own safety checks.
  const read = await storage.disk().get(key);
  return imageResponse(read.bytes, read.object.contentType, mediaCache(key));
}

export interface AssetRoutesOptions {
  /** App root. The source icon is resolved against it; storage keys never are. */
  readonly root: string;
  readonly storage: Storage;
  /** Replaces `builtinImageDriver` for `/media/*`. Omitted, core's PNG/JPEG pipeline. */
  readonly images?: ImageTransformDriver;
  /**
   * `manifest.webmanifest`, resolved at boot by `pwa-artifacts.ts`. Absent when the app declares
   * `pwa.enabled: false` — and then no route is mounted at all, rather than one answering an empty
   * document: a manifest a browser can fetch is a promise the app is installable.
   */
  readonly pwa?: PwaArtifacts;
}

/**
 * The icon routes mount whether or not the source exists, and a missing source is refused on the
 * wire with `X_PWA_ICON_MISSING` and its fix — a route that silently disappears is a 404 whose
 * meaning an agent has to guess. Deliberately NOT a boot finding: `x doctor` already reports this
 * exact condition with this exact code, and a second reporter of one condition is the duplication
 * this package's own rule forbids. `x dev` owns the runtime half, the diagnostic owns the other.
 */
export function assetRoutes(options: AssetRoutesOptions): readonly Route[] {
  // `iconPlan()`, never a second `planIcons` call: the icons this mounts and the icons
  // `manifest.webmanifest` names are one list, or the manifest promises a size nothing mints.
  const plan = iconPlan();
  const render = iconRenderer(options.root);

  const routes: Route[] = plan.entries.map((entry) => ({
    method: 'GET',
    path: entry.outputPath,
    meta: { name: `assets.icon.${entry.spec.filename}`, auth: 'public', tags: ['assets'] },
    handler: async (request: UltimateRequest): Promise<Response> =>
      imageResponse(await render(plan, request.pathname), 'image/png', IMMUTABLE_IMAGE),
  }));
  // The icons above are genuinely public — they are rendered from a file committed in the app, and
  // an install prompt fetches them before anyone has signed in. `/media` is the opposite: it serves
  // whatever is on the app's only disk, which is every tenant's uploads, so it takes `/_storage`'s
  // declaration verbatim. `enforcedBy: 'handler'` for the reason that route gives — the `authz`
  // stage resolves a policy from `@ultimat3/render`'s page table, which this route is not in.
  // `cache` declares the conservative posture; `mediaCache` narrows or widens it per key.
  routes.push({
    method: 'GET',
    path: `${MEDIA_BASE_PATH}/*key`,
    meta: {
      name: 'assets.media',
      auth: 'required',
      policy: STORAGE_READ_PERMISSION,
      enforcedBy: 'handler',
      cache: AUTHORIZED_OBJECT_CACHE,
      tags: ['assets'],
    },
    handler: async (request: UltimateRequest, ctx: RequestContext): Promise<Response> =>
      mediaResponse(request, ctx, options.storage, options.images),
  });
  // Mounted here rather than in `serve.ts` and `cmd-dev.ts` separately: this is the one route set
  // both served surfaces already compose, and a favicon that answers on a laptop and 404s in the
  // container is the dev/prod difference this package's own rule forbids. `favicon.ts` owns what
  // the answer IS — this file only says the app's asset surface is where it hangs.
  routes.push(faviconRoute(options.root));
  // Same rule one asset further along: the icons above are the ones this manifest NAMES, so the
  // two belong to one surface and cannot be mounted from two places without drifting apart.
  if (options.pwa !== undefined) routes.push(pwaManifestRoute(options.pwa));

  return routes;
}
