// The one source icon `x new` scaffolds. @ultimat3/core's image pipeline decodes PNG and JPEG
// only (`DECODABLE_FORMATS`, packages/core/src/image/pipeline.ts) — an SVG source, which is what
// this used to emit, can never be decoded, so `@ultimat3/pwa`'s `BuiltinImagePipeline` could
// never turn it into the fourteen `ICON_MATRIX` PNGs the generated web manifest declares.

import type { Raster } from '@ultimat3/core';
import { createRaster, encodeImage } from '@ultimat3/core';

/** `@ultimat3/pwa`'s own contract (`requireSourceIcon`'s fix line): square, 1024 or larger. */
const ICON_SIZE = 1024;

/**
 * Mirrors `MASKABLE_PADDING` (`packages/pwa/src/icons.ts`): a maskable icon is cropped to the
 * middle ~80% of the edge, so the mark has to stay inside that fraction or an installed Android
 * icon clips it. Inlined rather than imported — `@ultimat3/pwa` is not a dependency of this
 * package, and a placeholder icon does not need the rest of it.
 */
const MASKABLE_PADDING = 0.1;

/**
 * Neutral grey. This package cannot reach `@ultimat3/ui`'s tokens — both are tier 5 and no
 * `cli -> ui` sideways edge is declared — and a placeholder a user is expected to replace should
 * not invent a brand colour anyway.
 */
const MARK_RGBA: readonly [number, number, number, number] = [113, 113, 122, 255];

/** Fills the maskable-safe inner square, transparent canvas left untouched around it. */
function paintMark(raster: Raster, inset: number): void {
  const { width, height, pixels } = raster;
  const [r, g, b, a] = MARK_RGBA;
  for (let y = inset; y < height - inset; y += 1) {
    for (let x = inset; x < width - inset; x += 1) {
      const i = (y * width + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }
}

/**
 * A 1024x1024 PNG: a solid square mark inside the maskable safe zone, transparent elsewhere —
 * exactly what a placeholder needs to be, not art. Deterministic: no `Date.now()`, no randomness,
 * so `x new` output never depends on run order or the clock.
 */
export function icon(): Uint8Array {
  const raster = createRaster(ICON_SIZE, ICON_SIZE, 'scaffold-icon');
  paintMark(raster, Math.round(ICON_SIZE * MASKABLE_PADDING));
  return encodeImage(raster, 'png');
}
