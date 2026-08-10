// Single responsibility: the ONE in-memory image every codec agrees on — 8-bit RGBA,
// row-major, non-premultiplied. A single representation is why a decoder and an encoder
// never negotiate, and why resize/composite has exactly one code path to be correct in.

import { imageDecodeFailed, imageTooLarge } from './errors';

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major. Length is always `width * height * 4`. */
  readonly pixels: Uint8ClampedArray;
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The decompression-bomb ceiling. 64 megapixels is four times a 24MP camera frame and
 * 256MB of RGBA — past it a header is far more likely hostile than a real photograph.
 */
export const MAX_IMAGE_PIXELS = 64_000_000;

/** Checked from the header before a single byte is allocated. */
export function assertPixelBudget(width: number, height: number, source: string): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw imageTooLarge(`${source} declares a ${width}x${height} image, which is not a size`, {
      width,
      height,
      source,
    });
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw imageTooLarge(
      `${source} declares ${width}x${height} = ${width * height} pixels, over the ` +
        `${MAX_IMAGE_PIXELS} ceiling`,
      { width, height, pixels: width * height, ceiling: MAX_IMAGE_PIXELS, source },
    );
  }
}

/** A transparent canvas of the given size, budget already checked. */
export function createRaster(width: number, height: number, source = 'raster'): Raster {
  assertPixelBudget(width, height, source);
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
}

/**
 * Wraps an existing buffer, refusing a length that disagrees with the declared size. A mismatch is
 * a decode or a scaler bug — inconsistent bytes, not too many of them — so it is classified as one.
 */
export function rasterFrom(width: number, height: number, pixels: Uint8ClampedArray): Raster {
  assertPixelBudget(width, height, 'raster');
  if (pixels.length !== width * height * 4) {
    throw imageDecodeFailed(
      `raster buffer is ${pixels.length} bytes but ${width}x${height} needs ${width * height * 4}`,
      { width, height, length: pixels.length },
    );
  }
  return { width, height, pixels };
}

/** Whether any pixel is not fully opaque — decides PNG vs JPEG when nobody asked. */
export function hasAlpha(raster: Raster): boolean {
  const { pixels } = raster;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 255) return true;
  }
  return false;
}
