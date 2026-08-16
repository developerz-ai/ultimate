// Projecting the framework's one image pipeline onto the routes `x dev` serves. Three packages
// declare what an image is — `@ultimat3/seo` a variant URL, `@ultimat3/storage` a variant key,
// `@ultimat3/pwa` the icons a web manifest promises — and `@ultimat3/core`'s pipeline owns every
// pixel, so this file picks the two base paths they hang off and decides nothing else. The one
// thing it does NOT decide is who may read a stored object: `/media` borrows that whole answer
// from `dev-storage.ts`, because the same bytes are reachable through both.

// `join` is `node:`-only by necessity: Bun exposes no path-join primitive, and `ICON_SOURCE` is
// app-root-relative, so resolving it against the root is string work no `Bun.file` overload does.
import { join } from 'node:path';
import { probeImage } from '@ultimat3/core';
import type { CacheHint, RequestContext, Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders } from '@ultimat3/http';
import type { IconPlan } from '@ultimat3/pwa';
import { BuiltinImagePipeline, PwaIconMissingError, planIcons } from '@ultimat3/pwa';
import type { ImageQuery, ImageTransformDriver } from '@ultimat3/seo';
import { builtinImageDriver, parseImageQuery } from '@ultimat3/seo';
import type { ImageFormat, ImageTransform, Storage } from '@ultimat3/storage';
import { IMAGE_FORMATS, isTenantScoped, variantKey } from '@ultimat3/storage';
import {
  AUTHORIZED_OBJECT_CACHE,
  assertReadableKey,
  authorizeStorageRead,
  STORAGE_READ_PERMISSION,
} from './dev-storage';

/**
 * The one source image every generated icon derives from. `x new` scaffolds it, `x doctor` checks
 * it and this file reads it — one constant, because a second spelling is an app that passes the
 * diagnostic and still serves no icons. PNG, not SVG: core's pipeline decodes PNG and JPEG only.
 */
export const ICON_SOURCE = 'apps/web/site/icon.png';

/** Where `planIcons` writes, and therefore the paths the generated web manifest names. */
export const ICON_BASE_PATH = '/icons';

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

const isImageFormat = (value: string): value is ImageFormat =>
  (IMAGE_FORMATS as readonly string[]).includes(value);

/**
 * `exactOptionalPropertyTypes` makes an explicit `undefined` a different answer from an absent
 * key, and `variantKey` reads presence — so a spread, never an assignment.
 */
function storageTransform(query: ImageQuery, format: ImageFormat | undefined): ImageTransform {
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
    query.format !== undefined && isImageFormat(query.format) ? query.format : undefined;
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
    width: query.width ?? probeImage(source.bytes).width,
    ...(query.format === undefined ? {} : { format: query.format }),
    ...(query.quality === undefined ? {} : { quality: query.quality }),
  });
  if (cached !== undefined) {
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

/**
 * Rendered once per process, not per request: the fourteen matrix entries are pure functions of
 * one source file, and re-encoding a 512px PNG on every hit would be work no caller can observe.
 */
function iconRenderer(root: string): (plan: IconPlan, path: string) => Promise<Uint8Array> {
  const pipeline = new BuiltinImagePipeline();
  const rendered = new Map<string, Promise<Uint8Array>>();
  const sourceBytes = async (): Promise<Uint8Array> => {
    const file = Bun.file(join(root, ICON_SOURCE));
    if (!(await file.exists())) {
      throw new PwaIconMissingError(
        `${ICON_SOURCE} does not exist, so every icon the web manifest declares is unbacked and ` +
          'the app is not installable',
        // The same edit `x doctor` reports for the same condition, in `@ultimat3/pwa`'s own words.
        // `x new` was here and takes an app name, so it could never run inside the broken app.
        `add a 1024x1024 square PNG at ${ICON_SOURCE}`,
      );
    }
    return file.bytes();
  };
  return async (plan, path) => {
    const entry = plan.entries.find((candidate) => candidate.outputPath === path);
    if (entry === undefined) {
      throw new PwaIconMissingError(
        `${path} is not in the icon matrix, so no transform describes it`,
        `request one of ${plan.entries.map((one) => one.outputPath).join(', ')}`,
      );
    }
    const existing = rendered.get(path);
    if (existing !== undefined) return existing;
    const bytes = sourceBytes().then((source) => pipeline.resize(source, entry.transform));
    rendered.set(path, bytes);
    // A failed render must not be remembered — the next request comes after the source was added.
    bytes.catch(() => rendered.delete(path));
    return bytes;
  };
}

export interface AssetRoutesOptions {
  /** App root. The source icon is resolved against it; storage keys never are. */
  readonly root: string;
  readonly storage: Storage;
  /** Replaces `builtinImageDriver` for `/media/*`. Omitted, core's PNG/JPEG pipeline. */
  readonly images?: ImageTransformDriver;
}

/**
 * The icon routes mount whether or not the source exists, and a missing source is refused on the
 * wire with `X_PWA_ICON_MISSING` and its fix — a route that silently disappears is a 404 whose
 * meaning an agent has to guess. Deliberately NOT a boot finding: `x doctor` already reports this
 * exact condition with this exact code, and a second reporter of one condition is the duplication
 * this package's own rule forbids. `x dev` owns the runtime half, the diagnostic owns the other.
 */
export function assetRoutes(options: AssetRoutesOptions): readonly Route[] {
  const plan = planIcons({ sourceIcon: ICON_SOURCE, outDir: ICON_BASE_PATH });
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

  return routes;
}
