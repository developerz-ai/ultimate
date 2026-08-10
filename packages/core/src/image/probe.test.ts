// Single responsibility: prove the probe reads the intrinsic box of every format the framework
// serves, from independently produced bytes, and that a header it cannot trust fails with a
// coded error instead of a 0x0 that would silently un-reserve the layout box.

import { describe, expect, test } from 'bun:test';
import {
  AVIF_12X16,
  fixtureBytes,
  GIF_5X7,
  type ImageFixture,
  JPEG_420_ODD_33X17,
  JPEG_444_16X16,
  JPEG_GRAY_16X16,
  JPEG_PROGRESSIVE_16X16,
  PNG_GRADIENT_32X24,
  PNG_RGBA_4X4,
  SVG_120X45,
  WEBP_9X11,
} from './fixtures';
import {
  IMAGE_FORMATS,
  IMAGE_MIME_TYPES,
  type ImageFormat,
  probeImage,
  sniffImageFormat,
} from './probe';

interface ThrownError {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
}

/**
 * Duck-typed so the assertion needs no import beyond the module under test, and total so that
 * a call that fails to throw fails the assertion instead of skipping it.
 */
function thrown(run: () => unknown): ThrownError {
  try {
    run();
  } catch (error) {
    const raised = error as { readonly code?: unknown; cause?: unknown; readonly fix?: unknown };
    return { code: String(raised.code), cause: String(raised.cause), fix: String(raised.fix) };
  }
  return { code: 'nothing was thrown', cause: '', fix: '' };
}

const thrownCode = (run: () => unknown): string => thrown(run).code;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A signature + IHDR with whatever dimensions we want to claim; no CRC — the probe never reads it. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

/** A minimal RIFF/WEBP container around one chunk — the fixture only covers lossy `VP8 `. */
function webpContainer(chunkId: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(20 + payload.length);
  const view = new DataView(bytes.buffer);
  bytes.set(encode('RIFF'), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(encode('WEBP'), 8);
  bytes.set(encode(chunkId), 12);
  view.setUint32(16, payload.length, true);
  bytes.set(payload, 20);
  return bytes;
}

function losslessWebp(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(5);
  payload[0] = 0x2f;
  new DataView(payload.buffer).setUint32(1, (width - 1) | ((height - 1) << 14), true);
  return webpContainer('VP8L', payload);
}

function extendedWebp(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(10);
  payload[0] = 0x10;
  for (let i = 0; i < 3; i += 1) {
    payload[4 + i] = ((width - 1) >>> (8 * i)) & 0xff;
    payload[7 + i] = ((height - 1) >>> (8 * i)) & 0xff;
  }
  return webpContainer('VP8X', payload);
}

const CASES: readonly (readonly [string, ImageFixture, ImageFormat])[] = [
  ['PNG RGBA', PNG_RGBA_4X4, 'png'],
  ['PNG gradient', PNG_GRADIENT_32X24, 'png'],
  ['JPEG 4:4:4', JPEG_444_16X16, 'jpeg'],
  ['JPEG 4:2:0 odd', JPEG_420_ODD_33X17, 'jpeg'],
  ['JPEG greyscale', JPEG_GRAY_16X16, 'jpeg'],
  ['JPEG progressive', JPEG_PROGRESSIVE_16X16, 'jpeg'],
  ['GIF', GIF_5X7, 'gif'],
  ['WebP lossy', WEBP_9X11, 'webp'],
  ['AVIF', AVIF_12X16, 'avif'],
  ['SVG', SVG_120X45, 'svg'],
];

describe('sniffImageFormat', () => {
  for (const [name, fixture, format] of CASES) {
    test(`identifies ${name} as ${format}`, () => {
      expect(sniffImageFormat(fixtureBytes(fixture))).toBe(format);
    });
  }

  test('returns null rather than guessing, for anything it does not recognise', () => {
    expect(sniffImageFormat(new Uint8Array(0))).toBeNull();
    expect(sniffImageFormat(Uint8Array.from([1, 2, 3]))).toBeNull();
    expect(sniffImageFormat(encode('just a text file, honest\n'))).toBeNull();
  });

  test('does not read past the end of a one-byte buffer', () => {
    expect(sniffImageFormat(Uint8Array.from([0xff]))).toBeNull();
    expect(sniffImageFormat(Uint8Array.from([0x89]))).toBeNull();
    expect(sniffImageFormat(encode('RIFF'))).toBeNull();
    expect(sniffImageFormat(encode('<'))).toBeNull();
  });

  test('an SVG behind an XML declaration and a comment still sniffs', () => {
    const svg = `\n<?xml version="1.0"?>\n<!-- a > inside a comment -->\n<svg width="4" height="2"/>`;
    expect(sniffImageFormat(encode(svg))).toBe('svg');
  });
});

describe('probeImage', () => {
  for (const [name, fixture, format] of CASES) {
    test(`reads ${name} as ${fixture.width}x${fixture.height}`, () => {
      expect(probeImage(fixtureBytes(fixture))).toEqual({
        format,
        width: fixture.width,
        height: fixture.height,
        mimeType: IMAGE_MIME_TYPES[format],
      });
    });
  }

  test('refuses bytes that match no format, naming the six it knows', () => {
    expect(thrownCode(() => probeImage(encode('not an image')))).toBe('X_IMAGE_UNSUPPORTED');
    expect(thrownCode(() => probeImage(new Uint8Array(0)))).toBe('X_IMAGE_UNSUPPORTED');
    const { code, fix } = thrown(() => probeImage(Uint8Array.from([1, 2, 3])));
    expect(code).toBe('X_IMAGE_UNSUPPORTED');
    for (const format of IMAGE_FORMATS) expect(fix).toContain(format);
  });

  // A caller slicing one image out of a multipart body hands over a view, not a fresh buffer:
  // reading through `bytes.buffer` without its `byteOffset` would silently measure the padding.
  test('reads a view into a larger buffer, not the buffer behind it', () => {
    for (const [, fixture, format] of CASES) {
      const source = fixtureBytes(fixture);
      const padded = new Uint8Array(source.length + 7);
      padded.set(source, 7);
      const view = padded.subarray(7);
      expect([format, probeImage(view).width, probeImage(view).height]).toEqual([
        format,
        fixture.width,
        fixture.height,
      ]);
    }
  });
});

describe('probeImage / truncation', () => {
  test('a PNG cut off inside IHDR fails rather than reporting 0x0', () => {
    const code = thrownCode(() => probeImage(fixtureBytes(PNG_RGBA_4X4).subarray(0, 20)));
    expect(code).toBe('X_IMAGE_DECODE_FAILED');
  });

  test('a JPEG cut off mid marker walk fails', () => {
    const code = thrownCode(() => probeImage(fixtureBytes(JPEG_444_16X16).subarray(0, 30)));
    expect(code).toBe('X_IMAGE_DECODE_FAILED');
  });

  test('a GIF with only its 6-byte signature fails', () => {
    const code = thrownCode(() => probeImage(fixtureBytes(GIF_5X7).subarray(0, 6)));
    expect(code).toBe('X_IMAGE_DECODE_FAILED');
  });

  test('a WebP with a RIFF header and nothing else fails', () => {
    const code = thrownCode(() => probeImage(fixtureBytes(WEBP_9X11).subarray(0, 16)));
    expect(code).toBe('X_IMAGE_DECODE_FAILED');
  });

  // Every cut is a coded error, never a bare RangeError from a DataView read past the end —
  // and the byte after the dimensions is the exact point where the probe starts succeeding.
  test('a WebP cut anywhere inside its VP8 dimensions fails with a code', () => {
    const bytes = fixtureBytes(WEBP_9X11);
    const complete = 30;
    for (let cut = 20; cut < complete; cut += 1) {
      expect(thrownCode(() => probeImage(bytes.subarray(0, cut)))).toBe('X_IMAGE_DECODE_FAILED');
    }
    for (let cut = complete; cut <= bytes.length; cut += 1) {
      expect(probeImage(bytes.subarray(0, cut))).toMatchObject({ width: 9, height: 11 });
    }
  });

  test('an ISO-BMFF file with no ispe box fails', () => {
    const ftyp = new Uint8Array(24);
    new DataView(ftyp.buffer).setUint32(0, 24);
    ftyp.set(encode('ftypavif'), 4);
    expect(thrownCode(() => probeImage(ftyp))).toBe('X_IMAGE_DECODE_FAILED');
  });

  // The whole contract in one sweep: a caller who hands over half a file gets either one of
  // the three image codes or the true size — never a bare RangeError, never a 0x0 or a NaN.
  test('no prefix of any fixture escapes as an uncoded error or a wrong size', () => {
    const codes = new Set(['X_IMAGE_DECODE_FAILED', 'X_IMAGE_UNSUPPORTED', 'X_IMAGE_TOO_LARGE']);
    const offenders: string[] = [];
    for (const [name, fixture] of CASES) {
      const bytes = fixtureBytes(fixture);
      for (let cut = 0; cut <= bytes.length; cut += 1) {
        let width = Number.NaN;
        let height = Number.NaN;
        const { code } = thrown(() => {
          const info = probeImage(bytes.subarray(0, cut));
          width = info.width;
          height = info.height;
        });
        if (code === 'nothing was thrown') {
          if (width !== fixture.width || height !== fixture.height) {
            offenders.push(`${name} cut to ${cut} reported ${width}x${height}`);
          }
        } else if (!codes.has(code)) {
          offenders.push(`${name} cut to ${cut} raised ${code}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the decode-failure cause names the format and what was missing', () => {
    const { cause } = thrown(() => probeImage(fixtureBytes(PNG_RGBA_4X4).subarray(0, 20)));
    expect(cause).toContain('PNG');
    expect(cause).toContain('IHDR');
  });
});

describe('probeImage / pixel budget', () => {
  test('a header claiming 30000x30000 is refused before anything is allocated', () => {
    expect(thrownCode(() => probeImage(pngHeader(30_000, 30_000)))).toBe('X_IMAGE_TOO_LARGE');
  });

  test('a header claiming zero pixels is refused too', () => {
    expect(thrownCode(() => probeImage(pngHeader(0, 0)))).toBe('X_IMAGE_TOO_LARGE');
  });

  test('a large but legal header still passes', () => {
    expect(probeImage(pngHeader(8000, 8000)).width).toBe(8000);
  });
});

describe('probeImage / webp variants', () => {
  test('lossless VP8L dimensions are the packed 14-bit values plus one', () => {
    expect(probeImage(losslessWebp(33, 21))).toMatchObject({
      format: 'webp',
      width: 33,
      height: 21,
    });
  });

  test('extended VP8X dimensions come from the 24-bit canvas size', () => {
    expect(probeImage(extendedWebp(640, 480))).toMatchObject({
      format: 'webp',
      width: 640,
      height: 480,
    });
  });

  test('an unknown first chunk fails instead of guessing', () => {
    const code = thrownCode(() => probeImage(webpContainer('ANIM', new Uint8Array(8))));
    expect(code).toBe('X_IMAGE_DECODE_FAILED');
  });
});

describe('probeImage / svg', () => {
  const probeSvgText = (svg: string): { width: number; height: number } => {
    const info = probeImage(encode(svg));
    return { width: info.width, height: info.height };
  };

  test('a px suffix is still a pixel size', () => {
    expect(probeSvgText('<svg width="10px" height="20px"></svg>')).toEqual({
      width: 10,
      height: 20,
    });
  });

  test('a percentage is not a pixel size, so the viewBox wins', () => {
    const svg = '<svg width="50%" viewBox="0 0 300 150"></svg>';
    expect(probeSvgText(svg)).toEqual({ width: 300, height: 150 });
  });

  test('a fractional size rounds to the nearest whole pixel', () => {
    expect(probeSvgText("<svg width='12.4' height='7.5'></svg>")).toEqual({ width: 12, height: 8 });
  });

  test('neither a pixel size nor a viewBox is a decode failure the author can fix', () => {
    const code = thrownCode(() => probeImage(encode('<svg xmlns="http://x"></svg>')));
    expect(code).toBe('X_IMAGE_DECODE_FAILED');
  });

  test('the failure tells the author what to add', () => {
    const { cause } = thrown(() => probeImage(encode('<svg></svg>')));
    expect(cause).toContain('width');
    expect(cause).toContain('height');
    expect(cause).toContain('viewBox');
  });
});

describe('IMAGE_MIME_TYPES', () => {
  test('carries exactly one entry per format, so the two lists cannot drift', () => {
    expect(Object.keys(IMAGE_MIME_TYPES).sort()).toEqual([...IMAGE_FORMATS].sort());
    for (const format of IMAGE_FORMATS) {
      expect(IMAGE_MIME_TYPES[format]).toMatch(/^image\//);
    }
  });
});
