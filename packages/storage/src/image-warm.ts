// Single responsibility: write a stored image's variants AHEAD of the first request, under the exact
// keys the media route looks up, so no visitor pays the decode. The job an upload enqueues calls
// this; the request path then answers `exists` + `get` and never reaches the pipeline.

import {
  assert,
  finiteCount,
  IMAGE_MIME_TYPES,
  isUltimateError,
  probeImage,
  transformImageBytes,
} from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { type VariantFormat, variantKey, variantRevision } from './image';

export interface WarmVariantsInput {
  readonly disk: StorageDriver;
  /** The SOURCE object's key, as the media route is asked for it. */
  readonly key: string;
  /** Whole pixels. Widths above the source's are skipped: the route never stores an upscale. */
  readonly widths: readonly number[];
  /** `avif` is accepted by the type and fails per variant with core's `X_IMAGE_UNSUPPORTED`. */
  readonly formats: readonly VariantFormat[];
}

/** A variant that was not written: its key, and the failure's code and cause. */
export interface WarmFailure {
  readonly key: string;
  /** `X_IMAGE_UNSUPPORTED` for an `avif`, a storage code for a refused `put`. */
  readonly code: string;
  readonly cause: string;
}

export interface WarmVariantsResult {
  /** The variant keys written, in width-then-format order. */
  readonly written: readonly string[];
  /** One entry per variant that could not be made or stored; the others were still written. */
  readonly failed: readonly WarmFailure[];
  /** Widths above the source's intrinsic width: never minted, never stored. */
  readonly skipped: readonly number[];
}

/**
 * Every `widths` x `formats` variant of `key`, keyed as `variantKey(key, { width, format,
 * revision })` with the revision read off THIS read's etag — the one the bytes were made from, so
 * an overwrite racing the warm-up can only leave keys its new etag never names. The transform spec
 * is the builtin image driver's (`width` + `format`, default quality), so a warmed variant is the
 * object the route would have stored itself.
 *
 * The source is READ and PROBED once, and the probe holds it to core's `MAX_IMAGE_PIXELS` before
 * any pixel is decoded; each variant is then one pipeline pass over the bytes already in hand.
 */
export async function warmVariants(input: WarmVariantsInput): Promise<WarmVariantsResult> {
  for (const width of input.widths) finiteCount('warmVariants', 'widths', width, 1);
  const source = await input.disk.get(input.key);
  const revision = variantRevision(source.object.etag);
  assert(
    revision !== undefined,
    `warmVariants('${input.key}'): the source etag "${source.object.etag}" carries no 8-hex revision, so no variant of it has a key the media route would read`,
    `x doctor --json   # the disk driver answers no content etag; variants of ${input.key} are served, never stored`,
  );
  // A header read: past `MAX_IMAGE_PIXELS` it is core's `X_IMAGE_TOO_LARGE` before any decode.
  const info = probeImage(source.bytes);
  const written: string[] = [];
  const failed: WarmFailure[] = [];
  const skipped = input.widths.filter((width) => width > info.width);
  for (const width of input.widths.filter((one) => one <= info.width)) {
    for (const format of input.formats) {
      const key = variantKey(input.key, { width, format, revision });
      try {
        const bytes = await transformImageBytes(source.bytes, { width, format });
        await input.disk.put(key, bytes, {
          contentType: IMAGE_MIME_TYPES[probeImage(bytes).format],
        });
        written.push(key);
      } catch (error) {
        // Coded failures are per-variant answers; anything uncoded is a defect and is not swallowed.
        if (!isUltimateError(error)) throw error;
        failed.push({ key, code: error.code, cause: error.cause });
      }
    }
  }
  return { written, failed, skipped };
}
