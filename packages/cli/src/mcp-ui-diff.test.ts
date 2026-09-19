import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { decodeImage, encodeImage } from '@ultimat3/core';
import { decodeCapture, diffShots, hash8, shotPath } from './mcp-ui-diff';
import { DIFF_RED, faded } from './ui-diff';

/** A `width`×`height` 8-bit RGBA PNG of one colour, as `encodeImage` writes it. */
const png = (width: number, height: number, rgba: readonly number[]): Uint8Array => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) pixels.set(rgba, i * 4);
  return encodeImage({ width, height, pixels });
};

// ─── a hand-made RGB (colour type 2) PNG: the shape Chrome writes for an opaque page ───────
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const chunk = (type: string, data: number[]): number[] => {
  const body = [...new TextEncoder().encode(type), ...data];
  return [...u32(data.length), ...body, ...u32(crc32(Uint8Array.from(body)))];
};
const adler32 = (bytes: Uint8Array): number => {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};
/** A 2×1 RGB PNG: left pixel `left`, right pixel `right`, no alpha channel at all. */
const rgbPng = (left: readonly number[], right: readonly number[]): Uint8Array => {
  const raw = Uint8Array.from([0, ...left, ...right]);
  // `Bun.deflateSync` writes RAW deflate whatever `windowBits` says (measured on 1.4.2), so the
  // zlib envelope PNG wants — a 2-byte header and the Adler-32 trailer — is put on by hand.
  const idat = [0x78, 0x01, ...Bun.deflateSync(raw), ...u32(adler32(raw))];
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', [...u32(2), ...u32(1), 8, 2, 0, 0, 0]),
    ...chunk('IDAT', idat),
    ...chunk('IEND', []),
  ]);
};

const root = `${process.env['TMPDIR'] ?? '/tmp'}/ui-diff-${crypto.randomUUID()}`;
const shot = `${root}/.x/shot/dash/1440x900-dark`;

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return 'resolved';
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code';
  }
};

beforeAll(async () => {
  await Bun.$`mkdir -p ${shot} ${root}/secrets`.quiet();
  await Bun.write(`${shot}/a.png`, png(4, 3, [0, 0, 0, 255]));
  const changed = new Uint8ClampedArray(4 * 3 * 4);
  for (let i = 0; i < 12; i += 1) changed.set([0, 0, 0, 255], i * 4);
  changed.set([255, 255, 255, 255], (1 * 4 + 2) * 4);
  await Bun.write(`${shot}/b.png`, encodeImage({ width: 4, height: 3, pixels: changed }));
  await Bun.write(`${shot}/wide.png`, png(5, 3, [0, 0, 0, 255]));
  await Bun.write(`${shot}/rgb.png`, rgbPng([10, 20, 30], [10, 20, 30]));
  await Bun.write(`${shot}/rgb2.png`, rgbPng([10, 20, 30], [250, 20, 30]));
  await Bun.write(`${root}/secrets/leak.png`, png(4, 3, [0, 0, 0, 255]));
  await Bun.$`ln -s ${root}/secrets/leak.png ${shot}/link.png`.quiet();
});

afterAll(async () => {
  await Bun.$`rm -rf ${root}`.quiet();
});

describe('unit · ui.diff compares two captures under .x/shot/ and nothing else', () => {
  test('two captures of one size: count, percent, box, and a diff PNG beside after', async () => {
    const result = await diffShots(
      { root },
      {
        before: '.x/shot/dash/1440x900-dark/a.png',
        after: '.x/shot/dash/1440x900-dark/b.png',
        threshold: 0.1,
      },
    );
    expect(result).toMatchObject({
      ok: true,
      before: '.x/shot/dash/1440x900-dark/a.png',
      after: '.x/shot/dash/1440x900-dark/b.png',
      width: 4,
      height: 3,
      changedPixels: 1,
      changedPercent: 8.33,
      changedBox: { x: 2, y: 1, width: 1, height: 1 },
    });
    expect(result.diff).toBe(`${shot}/diff-${hash8('.x/shot/dash/1440x900-dark/a.png')}.png`);
    const written = decodeImage(await Bun.file(result.diff).bytes());
    expect([written.width, written.height]).toEqual([4, 3]);
    expect(Array.from(written.pixels.subarray((1 * 4 + 2) * 4, (1 * 4 + 2) * 4 + 4))).toEqual([
      ...DIFF_RED,
    ]);
    expect(Array.from(written.pixels.subarray(0, 4))).toEqual([faded(0), faded(0), faded(0), 255]);
  });

  test('identical captures: zero, null box; `out` names the diff, also under .x/shot/', async () => {
    const result = await diffShots(
      { root },
      {
        before: '.x/shot/dash/1440x900-dark/a.png',
        after: '.x/shot/dash/1440x900-dark/a.png',
        threshold: 0.1,
        out: '.x/shot/same.png',
      },
    );
    expect(result.changedPixels).toBe(0);
    expect(result.changedPercent).toBe(0);
    expect(result.changedBox).toBeNull();
    expect(result.diff).toBe(`${root}/.x/shot/same.png`);
    expect(await Bun.file(result.diff).exists()).toBe(true);
  });

  test('a path outside .x/shot/ is refused by name: relative, `..`, absolute, or `out`', async () => {
    const inside = '.x/shot/dash/1440x900-dark/a.png';
    expect(() => shotPath(root, 'secrets/leak.png', 'before')).toThrow(
      expect.objectContaining({ code: 'X_UI_DIFF_PATH_OUTSIDE' }),
    );
    expect(() => shotPath(root, '.x/shot/../../secrets/leak.png', 'before')).toThrow(
      expect.objectContaining({ code: 'X_UI_DIFF_PATH_OUTSIDE' }),
    );
    expect(() => shotPath(root, `${root}/secrets/leak.png`, 'after')).toThrow(
      expect.objectContaining({ code: 'X_UI_DIFF_PATH_OUTSIDE' }),
    );
    // `.x/shotgun/` shares the prefix's characters, not its segments.
    expect(() => shotPath(root, '.x/shotgun/a.png', 'after')).toThrow(
      expect.objectContaining({ code: 'X_UI_DIFF_PATH_OUTSIDE' }),
    );
    expect(
      await codeOf(
        diffShots({ root }, { before: inside, after: inside, threshold: 0.1, out: 'diff.png' }),
      ),
    ).toBe('X_UI_DIFF_PATH_OUTSIDE');
    // Refused before any file is read: the missing `before` never gets a say.
    expect(
      await codeOf(
        diffShots({ root }, { before: '.x/shot/nope.png', after: 'x.png', threshold: 0.1 }),
      ),
    ).toBe('X_UI_DIFF_PATH_OUTSIDE');
  });

  test('a symlink under .x/shot/ that points out of it is refused, not followed', async () => {
    const inside = '.x/shot/dash/1440x900-dark/a.png';
    const link = '.x/shot/dash/1440x900-dark/link.png';
    expect(await codeOf(diffShots({ root }, { before: link, after: inside, threshold: 0.1 }))).toBe(
      'X_UI_DIFF_PATH_OUTSIDE',
    );
  });

  test('a capture that is not on disk is X_UI_DIFF_FILE_MISSING, with the path in the cause', async () => {
    try {
      await diffShots(
        { root },
        {
          before: '.x/shot/dash/1440x900-dark/missing.png',
          after: '.x/shot/dash/1440x900-dark/a.png',
          threshold: 0.1,
        },
      );
      expect.unreachable('should have refused');
    } catch (error) {
      const refusal = error as { code: string; cause: string; fix: string };
      expect(refusal.code).toBe('X_UI_DIFF_FILE_MISSING');
      expect(refusal.cause).toContain('missing.png');
      expect(refusal.fix).toContain('--json');
    }
  });

  test('two sizes are refused naming both, before a pixel is compared', async () => {
    try {
      await diffShots(
        { root },
        {
          before: '.x/shot/dash/1440x900-dark/a.png',
          after: '.x/shot/dash/1440x900-dark/wide.png',
          threshold: 0.1,
        },
      );
      expect.unreachable('should have refused');
    } catch (error) {
      const refusal = error as { code: string; cause: string; meta: unknown };
      expect(refusal.code).toBe('X_UI_DIFF_SIZE_MISMATCH');
      expect(refusal.cause).toContain('4x3');
      expect(refusal.cause).toContain('5x3');
      expect(refusal.meta).toEqual({
        before: { width: 4, height: 3 },
        after: { width: 5, height: 3 },
      });
    }
  });

  test('an RGB PNG (Chrome, opaque page) is normalised through Bun.Image and then compared', async () => {
    // The seam alone refuses colour type 2; the capture path takes the detour.
    expect(() => decodeImage(rgbPng([1, 2, 3], [1, 2, 3]))).toThrow(
      expect.objectContaining({ code: 'X_IMAGE_UNSUPPORTED' }),
    );
    const raster = await decodeCapture(rgbPng([10, 20, 30], [40, 50, 60]));
    expect([raster.width, raster.height]).toEqual([2, 1]);
    expect(Array.from(raster.pixels)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    const result = await diffShots(
      { root },
      {
        before: '.x/shot/dash/1440x900-dark/rgb.png',
        after: '.x/shot/dash/1440x900-dark/rgb2.png',
        threshold: 0.1,
      },
    );
    expect(result.changedPixels).toBe(1);
    expect(result.changedBox).toEqual({ x: 1, y: 0, width: 1, height: 1 });
    expect(result.changedPercent).toBe(50);
  });

  test('hash8 is eight hex digits and differs per path', () => {
    expect(hash8('a')).toMatch(/^[0-9a-f]{8}$/);
    expect(hash8('a')).not.toBe(hash8('b'));
    expect(hash8('a')).toBe(hash8('a'));
  });
});
