// Projecting the framework's one image pipeline onto the routes `x dev` serves. Three packages
// declare what an image is — `@ultimat3/seo` a variant URL, `@ultimat3/storage` a variant key,
// `@ultimat3/pwa` the icons a web manifest promises — and `@ultimat3/core`'s pipeline owns every
// pixel, so this file picks the two base paths they hang off and decides nothing else. The one
// thing it does NOT decide is who may read a stored object: `/media` borrows that whole answer
// from `runtime-storage.ts`, because the same bytes are reachable through both.

import { probeImage } from '@ultimat3/core';
import type { ObjectSource, RequestContext, Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders, notModified, objectResponse } from '@ultimat3/http';
import type { ImageQuery, ImageTransformDriver } from '@ultimat3/seo';
import { builtinImageDriver, DEFAULT_WIDTHS, parseImageQuery, usableWidths } from '@ultimat3/seo';
import type { ImageTransform, Storage, StorageObject, VariantFormat } from '@ultimat3/storage';
import {
  DEFAULT_QUALITY,
  isVariantFormat,
  objectNotFound,
  variantFormatOf,
  variantKey,
  variantRevision,
} from '@ultimat3/storage';
import { assetRouteMeta } from './asset-route-meta';
import { faviconRoute } from './favicon';
// The icon matrix's source, its base path and its renderer live in their own module so that
// `pwa-artifacts.ts` — which this file imports for the manifest route — can reach them without
// importing this one back. A cycle between the two would be the manifest and the icons it names
// resolving through each other.
import { iconPlan, iconRenderer } from './icon-assets';
import type { PwaArtifacts } from './pwa-artifacts';
import { pwaManifestRoute } from './pwa-artifacts';
import { revalidatedResponse } from './revalidated-response';
import { siteAssetVariantRoutes } from './runtime-assets-site';
import {
  AUTHORIZED_OBJECT_CACHE,
  assertReadableKey,
  assertVariantCurrent,
  authorizeStorageRead,
  readStorageObject,
  STORAGE_READ_PERMISSION,
} from './runtime-storage';
import { siteAssetTable } from './site-assets';

/**
 * Storage-backed images. `responsiveImage({ src: '/media/<key>' })` mints its variants under it.
 * Guarded exactly as `/_storage` is — an object reachable through two URLs must not be reachable
 * on two different terms — so a `src` under this path needs a signed-in reader holding
 * `storage:read`. A genuinely public image belongs in `apps/web/site/assets/`, named with
 * `asset('assets/…')`: served below at a content-hashed `/assets/*` URL, copied into the static
 * export under the same name (`site-assets.ts`), and never touching a disk that holds another
 * tenant's uploads.
 */
export const MEDIA_BASE_PATH = '/media';

/**
 * Whether a variant is one the framework itself can MINT, and therefore one worth storing.
 *
 * The cache key is built entirely from caller-supplied query values, and a signed-in reader
 * holding `storage:read` may ask for any of them on their own objects — so `?w=1`, `?w=2`, … each
 * wrote a new object to the app's only disk. `@ultimat3/seo`'s `MAX_IMAGE_WIDTH` (8192) bounds the
 * blast radius and does not close it: 8192 stored objects per source, per format, is amplification
 * a tenant drives with a `for` loop.
 *
 * The set is `usableWidths(intrinsic, DEFAULT_WIDTHS)` — the function that writes the `srcset`,
 * asked rather than restated. A restatement (`DEFAULT_WIDTHS` plus the intrinsic width) disagreed
 * with it for a source wider than `MAX_IMAGE_WIDTH`, whose widest candidate is the ceiling: that
 * URL, minted by the framework itself, was decoded on every request and never stored.
 * Anything outside it is still SERVED: this decides what is written, not what is answered, so no
 * caller gains a new 4xx and the disk stops growing on a stranger's key.
 */
const isMintableWidth = (width: number | undefined, intrinsic: number): boolean =>
  width === undefined || usableWidths(intrinsic, DEFAULT_WIDTHS).includes(width);

/**
 * The same question for `?q=`. `@ultimat3/seo` never writes a quality into a variant URL, so the
 * framework mints exactly one — the default — and `variantKey` already spells the default and an
 * absent one as the same key. Every other value from 1 to 100 was its own stored object per
 * minted width per format: a hundred writes a caller drives with a loop. Served, never stored.
 */
const isMintableQuality = (quality: number | undefined): boolean =>
  quality === undefined || quality === DEFAULT_QUALITY;

/**
 * Bytes already in hand, as `objectResponse` asks for them. Copied, not passed through: a
 * `Uint8Array<ArrayBufferLike>` may be backed by a `SharedArrayBuffer`, which `Response` does not
 * accept, and copying is what makes that true by construction rather than by a cast.
 */
const heldBytes = (bytes: Uint8Array): ObjectSource['open'] => {
  const body = new Uint8Array(bytes);
  return (range) => (range === undefined ? body : body.subarray(range.start, range.end + 1));
};

/**
 * `exactOptionalPropertyTypes` makes an explicit `undefined` a different answer from an absent
 * key, and `variantKey` reads presence — so a spread, never an assignment.
 */
function storageTransform(
  query: ImageQuery,
  format: VariantFormat,
  revision: string,
): ImageTransform {
  return {
    ...(query.width === undefined ? {} : { width: query.width }),
    format,
    ...(query.quality === undefined ? {} : { quality: query.quality }),
    revision,
  };
}

/**
 * The validator of one transform of one revision of a source. Built only from the source's own
 * etag and values this route parsed, so a `?f=` no format names never reaches a header: `undefined`
 * there, and the driver refuses that URL. An unknowable source etag is `undefined` too.
 */
function variantEtag(
  source: StorageObject,
  query: ImageQuery,
  format: VariantFormat | undefined,
): string | undefined {
  const bare = source.etag.replace(/^(W\/)?"|"$/g, '');
  if (bare === '') return undefined;
  if (format === undefined && query.format !== undefined) return undefined;
  const transform = [
    query.width === undefined ? 'intrinsic' : `w${query.width}`,
    format ?? 'source',
    ...(query.quality === undefined ? [] : [`q${query.quality}`]),
  ];
  return `"${bare}-${transform.join('-')}"`;
}

/**
 * The source is STATED first, so a deleted one is `X_STORAGE_NOT_FOUND` on every disk before any
 * variant is consulted, and its etag decides the key: a variant is looked up under the revision and
 * the format it would be made in, so an overwrite misses it and `?w=` cannot share a key with
 * `?w=&f=webp`. A key no one can state honestly (a `gif`, an unknowable etag) is served, never
 * stored. A revalidation costs one `stat`, a hit one `exists` and one `get`, a miss a decode.
 */
async function transformedVariant(
  storage: Storage,
  request: UltimateRequest,
  key: string,
  query: ImageQuery,
  images: ImageTransformDriver | undefined,
): Promise<Response> {
  const disk = storage.disk();
  await assertVariantCurrent(disk, storage.defaultDisk, key);
  const object = await disk.stat(key);
  if (object === undefined) throw objectNotFound(storage.defaultDisk, key);

  // A format storage cannot name has no variant key, so it cannot be cached. The driver refuses
  // it with core's `X_IMAGE_UNSUPPORTED`; refusing it here too would give one bad URL two codes.
  const named = query.format;
  const format =
    named === undefined
      ? variantFormatOf(object.contentType)
      : isVariantFormat(named)
        ? named
        : undefined;
  const revision = variantRevision(object.etag);
  const cached =
    format === undefined || revision === undefined
      ? undefined
      : variantKey(key, storageTransform(query, format, revision));

  const etag = variantEtag(object, query, format);
  // Before anything is read: this is the request a revalidating browser makes for every image.
  const fresh = etag === undefined ? undefined : notModified(request, etag);
  if (fresh !== undefined) return applyCacheHeaders(fresh, AUTHORIZED_OBJECT_CACHE);
  const answer = (contentType: string, bytes: Uint8Array): Promise<Response> =>
    objectResponse(
      request,
      {
        object: { contentType, size: bytes.byteLength, etag },
        open: heldBytes(bytes),
      },
      { cache: AUTHORIZED_OBJECT_CACHE },
    );

  if (cached !== undefined && (await disk.exists(cached))) {
    const hit = await disk.get(cached);
    return answer(hit.object.contentType, hit.bytes);
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
  if (
    cached !== undefined &&
    // The bytes just decoded are the revision the key names, or an overwrite landed in between and
    // this variant would answer for bytes it was not made from.
    source.object.etag === object.etag &&
    isMintableWidth(query.width, intrinsic) &&
    isMintableQuality(query.quality)
  ) {
    await disk.put(cached, variant.bytes, { contentType: variant.contentType });
  }
  return answer(variant.contentType, variant.bytes);
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
  const key = assertReadableKey(storage, storage.defaultDisk, requested, ctx.actor);
  const query = parseImageQuery(request.url.searchParams);
  if (query !== null) return transformedVariant(storage, request, key, query, images);
  // No transform asked for: the object itself, read and answered exactly as `/_storage` answers it.
  const served = await readStorageObject(storage, { disk: storage.defaultDisk, key }, ctx.actor);
  return objectResponse(request, served, { cache: AUTHORIZED_OBJECT_CACHE });
}

export interface AssetRoutesOptions {
  /** App root. The source icon is resolved against it; storage keys never are. */
  readonly root: string;
  readonly storage: Storage;
  /** Replaces `builtinImageDriver` for `/media/*` and `/assets/*`. Omitted, core's pipeline. */
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
    meta: assetRouteMeta({ name: `assets.icon.${entry.spec.filename}`, auth: 'public' }),
    // Revalidated, never `immutable` (22.3.2): the file name is the icon's SIZE, so a new
    // `icon.png` shipped under the same URLs and every client that had seen the old one kept it for
    // a year. The manifest and the apple-touch links name these paths, so a hashed URL would move
    // every document and the manifest with it; a 304 is the cheaper fix.
    handler: async (request: UltimateRequest): Promise<Response> =>
      revalidatedResponse(request, await render(plan, request.pathname), 'image/png'),
  }));
  // The icons above are genuinely public — they are rendered from a file committed in the app, and
  // an install prompt fetches them before anyone has signed in. `/media` is the opposite: it serves
  // whatever is on the app's only disk, which is every tenant's uploads, so it takes `/_storage`'s
  // declaration verbatim. `enforcedBy: 'handler'` for the reason that route gives — the `authz`
  // stage resolves a policy from `@ultimat3/render`'s page table, which this route is not in.
  // No key's bytes are fixed and every answer is authorized for one actor, so one posture for all.
  routes.push({
    method: 'GET',
    path: `${MEDIA_BASE_PATH}/*key`,
    // Tagged `assets` (the retained-build lookup reads the tag) but NOT on the `assets` bucket: an
    // authenticated storage read per request is not a content-hashed chunk, so it stays `default`.
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
  // And every other public file of the site: `apps/web/site/assets/**` at the hashed URLs
  // `asset()` mints, immutable. The same table `loadApp` installed for the renderer, so the URL a
  // document names and the URL this answers are one computation. A raster also answers the
  // `?w=&f=` variants a served `responsiveImage` mints for it, through the same driver as `/media`.
  routes.push(...siteAssetVariantRoutes(siteAssetTable(options.root), { images: options.images }));
  // Same rule one asset further along: the icons above are the ones this manifest NAMES, so the
  // two belong to one surface and cannot be mounted from two places without drifting apart.
  if (options.pwa !== undefined) routes.push(pwaManifestRoute(options.pwa));

  return routes;
}
