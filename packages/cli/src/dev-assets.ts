// Projecting the framework's one image pipeline onto the routes `x dev` serves. Three packages
// declare what an image is — `@ultimat3/seo` a variant URL, `@ultimat3/storage` a variant key,
// `@ultimat3/pwa` the icons a web manifest promises — and `@ultimat3/core`'s pipeline owns every
// pixel, so this file picks the two base paths they hang off and decides nothing else.

// `join` is `node:`-only by necessity: Bun exposes no path-join primitive, and `ICON_SOURCE` is
// app-root-relative, so resolving it against the root is string work no `Bun.file` overload does.
import { join } from 'node:path';
import { probeImage } from '@ultimat3/core';
import type { Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders } from '@ultimat3/http';
import type { IconPlan } from '@ultimat3/pwa';
import { BuiltinImagePipeline, PwaIconMissingError, planIcons } from '@ultimat3/pwa';
import type { ImageQuery } from '@ultimat3/seo';
import { builtinImageDriver, parseImageQuery } from '@ultimat3/seo';
import type { ImageFormat, ImageTransform, Storage } from '@ultimat3/storage';
import { IMAGE_FORMATS, variantKey } from '@ultimat3/storage';

/**
 * The one source image every generated icon derives from. `x new` scaffolds it, `x doctor` checks
 * it and this file reads it — one constant, because a second spelling is an app that passes the
 * diagnostic and still serves no icons. PNG, not SVG: core's pipeline decodes PNG and JPEG only.
 */
export const ICON_SOURCE = 'apps/web/site/icon.png';

/** Where `planIcons` writes, and therefore the paths the generated web manifest names. */
export const ICON_BASE_PATH = '/icons';

/** Storage-backed images. `responsiveImage({ src: '/media/<key>' })` mints its variants under it. */
export const MEDIA_BASE_PATH = '/media';

/**
 * Variants are content-addressed by `variantKey`, so a URL that answers once answers forever with
 * the same bytes — the immutable hint is a fact about the key, not an optimism about the source.
 */
const imageResponse = (bytes: Uint8Array, contentType: string): Response =>
  applyCacheHeaders(
    // Copied, not passed through: a `Uint8Array<ArrayBufferLike>` may be backed by a
    // `SharedArrayBuffer`, which `Response` does not accept, and copying is what makes that true
    // by construction rather than by a cast that would only silence it.
    new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } }),
    { mode: 'immutable' },
  );

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
): Promise<Response> {
  const disk = storage.disk();
  // A format storage cannot name has no variant key, so it cannot be cached. The driver refuses
  // it with core's `X_IMAGE_UNSUPPORTED`; refusing it here too would give one bad URL two codes.
  const format =
    query.format !== undefined && isImageFormat(query.format) ? query.format : undefined;
  const cacheable = query.format === undefined || format !== undefined;
  const cached = cacheable ? variantKey(key, storageTransform(query, format)) : undefined;
  if (cached !== undefined && (await disk.exists(cached))) {
    const hit = await disk.get(cached);
    return imageResponse(hit.bytes, hit.object.contentType);
  }

  const source = await disk.get(key);
  const variant = await builtinImageDriver({ read: async () => source.bytes }).transform({
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
  return imageResponse(variant.bytes, variant.contentType);
}

async function mediaResponse(request: UltimateRequest, storage: Storage): Promise<Response> {
  const key = request.params['key'] ?? '';
  const query = parseImageQuery(request.url.searchParams);
  if (query !== null) return transformedVariant(storage, key, query);
  // No transform asked for: the object itself, still under the storage key's own safety checks.
  const read = await storage.disk().get(key);
  return imageResponse(read.bytes, read.object.contentType);
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
      imageResponse(await render(plan, request.pathname), 'image/png'),
  }));
  routes.push({
    method: 'GET',
    path: `${MEDIA_BASE_PATH}/*key`,
    meta: { name: 'assets.media', auth: 'public', tags: ['assets'] },
    handler: async (request: UltimateRequest): Promise<Response> =>
      mediaResponse(request, options.storage),
  });

  return routes;
}
