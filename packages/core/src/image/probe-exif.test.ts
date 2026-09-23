// Single responsibility: the probe answers the DISPLAYED box of a JPEG carrying an EXIF
// orientation — the box `Bun.Image` decodes to — for every orientation and both TIFF byte orders.

import { describe, expect, test } from 'bun:test';
import { exifOrientation } from './exif-orientation';
import { encodeImage } from './png-pixels';
import { probeImage } from './probe';

/** An APP1 "Exif" segment whose IFD0 holds exactly one entry: Orientation, SHORT, `value`. */
function app1(orientation: number, little: boolean): Uint8Array {
  const tiff = new Uint8Array(26);
  const view = new DataView(tiff.buffer);
  tiff.set(little ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, 1, little);
  view.setUint16(10, 0x0112, little);
  view.setUint16(12, 3, little);
  view.setUint32(14, 1, little);
  view.setUint16(18, orientation, little);
  const segment = new Uint8Array(4 + 6 + tiff.length);
  segment.set([0xff, 0xe1], 0);
  new DataView(segment.buffer).setUint16(2, segment.length - 2);
  segment.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  segment.set(tiff, 10);
  return segment;
}

/** A real 40x20 JPEG from the encoder, with the APP1 segment spliced in right after SOI. */
async function orientedJpeg(orientation: number, little: boolean): Promise<Uint8Array> {
  const png = encodeImage({
    width: 40,
    height: 20,
    pixels: new Uint8ClampedArray(40 * 20 * 4).fill(200),
  });
  const jpeg = await new Bun.Image(png).jpeg().bytes();
  const segment = app1(orientation, little);
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

describe('probeImage honours EXIF orientation', () => {
  test('a 40x20 JPEG with Orientation=6 probes as 20x40', async () => {
    const bytes = await orientedJpeg(6, true);
    expect(probeImage(bytes)).toMatchObject({ format: 'jpeg', width: 20, height: 40 });
  });

  for (const little of [true, false]) {
    test.each([1, 2, 3, 4, 5, 6, 7, 8])(
      `orientation %p (${little ? 'II' : 'MM'}) matches what Bun.Image decodes`,
      async (orientation) => {
        const bytes = await orientedJpeg(orientation, little);
        const decoded = await new Bun.Image(bytes).metadata();
        const probed = probeImage(bytes);
        expect({ width: probed.width, height: probed.height }).toEqual({
          width: decoded.width,
          height: decoded.height,
        });
      },
    );
  }
});

describe('exifOrientation never throws', () => {
  test.each([
    ['empty', new Uint8Array()],
    ['not Exif', new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0')],
    ['bad byte order', new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2, 0, 42, 0, 0, 0, 8])],
    [
      'IFD past the end',
      new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 9, 9]),
    ],
  ])('%s reads as 1', (_label, payload) => {
    expect(exifOrientation(payload)).toBe(1);
  });
});
