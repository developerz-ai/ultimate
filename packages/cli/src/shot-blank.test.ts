// The blank-picture verdict, on real PNG bytes: a small honest component passes however few
// bytes it took, and a crop of one colour, of nothing opaque, or of no image at all is refused.

import { describe, expect, test } from 'bun:test';
import { encodeImage } from '@ultimat3/core';
import { BLANK_CHANNEL_SPREAD, blankShotReason } from './shot-blank';

type Rgba = readonly [number, number, number, number];

const png = (size: number, paint: (x: number, y: number) => Rgba): Uint8Array => {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) pixels.set(paint(x, y), (y * size + x) * 4);
  }
  return encodeImage({ width: size, height: size, pixels });
};

const PAGE: Rgba = [250, 250, 250, 255];
const BORDER: Rgba = [120, 120, 130, 255];

/** A 36 px flat button with an 8 px page margin: a one-pixel border and a glyph in the middle. */
const flatButton = (): Uint8Array =>
  png(52, (x, y) => {
    const inside = x >= 8 && x < 44 && y >= 8 && y < 44;
    const edge = inside && (x === 8 || x === 43 || y === 8 || y === 43);
    const glyph = x >= 22 && x < 30 && y >= 22 && y < 30;
    return edge || glyph ? BORDER : PAGE;
  });

describe('unit · a picture is judged by its pixels, not its bytes', () => {
  test('a small flat component under the old 512-byte floor is a picture', async () => {
    const bytes = flatButton();
    expect(bytes.byteLength).toBeLessThan(512);
    expect(await blankShotReason(bytes)).toBeUndefined();
  });

  test('a crop of one colour is blank, however large', async () => {
    const verdict = await blankShotReason(png(200, () => PAGE));
    expect(verdict?.undecodable).toBe(false);
    expect(verdict?.reason).toContain('one colour');
  });

  test('compositor dither within the spread is still one colour; past it is content', async () => {
    const dithered = png(40, (x) => [250 - (x % (BLANK_CHANNEL_SPREAD + 1)), 250, 250, 255]);
    expect((await blankShotReason(dithered))?.reason).toContain('one colour');
    const hairline = png(40, (x) =>
      x === 20 ? [250 - BLANK_CHANNEL_SPREAD - 1, 250, 250, 255] : PAGE,
    );
    expect(await blankShotReason(hairline)).toBeUndefined();
  });

  test('a crop with no opaque pixel is blank', async () => {
    const verdict = await blankShotReason(png(36, (x) => [x, 0, 0, 0]));
    expect(verdict?.reason).toContain('fully transparent');
  });

  test('bytes no decoder reads are not an image, and say so', async () => {
    const verdict = await blankShotReason(new Uint8Array(400).fill(7));
    expect(verdict?.undecodable).toBe(true);
    expect(verdict?.reason).toContain('not an image');
  });
});
