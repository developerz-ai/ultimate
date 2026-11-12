// A static export's `<picture>`: every `srcset` candidate an exported document names is a FILE,
// of the type its `<source>` promises and the width its descriptor states — what a dumb file
// server needs to answer `image/webp` for a webp. Before this, every candidate was `?w=&f=`, which
// a CDN ignores, so the full PNG went out under `<source type="image/webp">`.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import {
  blankRaster,
  encodeImage,
  frameworkVersion,
  isUltimateError,
  probeImage,
} from '@ultimat3/core';
import { type ModernFormat, renderPicture, responsiveImage } from '@ultimat3/seo';
import { staticCapture } from './static-capture';
import { imageEncoderIdentity, staticImages } from './static-images';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An export that already holds one 64x32 PNG, as `writeSiteAssets` leaves it. */
async function exportWithAsset(): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), 'x-static-images-'));
  dirs.push(out);
  const raster = blankRaster(64, 32);
  raster.pixels.fill(200);
  await Bun.write(join(out, 'assets/hero.1a2b3c4d.png'), encodeImage(raster, 'png'));
  return out;
}

const HERO = { src: '/assets/hero.1a2b3c4d.png', width: 64, height: 32, alt: '' };

/** Render one page under the seam, write it where the export would, and run the writer. */
async function exportPage(
  out: string,
  src: string,
  formats?: readonly ModernFormat[],
): Promise<{ readonly html: string; readonly written: readonly string[] }> {
  const capture = await staticCapture(out, false);
  let html: string;
  try {
    const image = responsiveImage(
      { ...HERO, src },
      { widths: [32], ...(formats === undefined ? {} : { formats }) },
    );
    html = `<html><body>${renderPicture(image)}</body></html>`;
  } finally {
    capture.close();
  }
  await Bun.write(join(out, 'index.html'), html);
  const files = await capture.write([{ path: '/', file: 'index.html' }]);
  return { html, written: files.images };
}

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'uncoded';
  }
  return 'resolved';
};

describe('unit · static image variants', () => {
  test('every srcset candidate is a real file with the promised type and width', async () => {
    const out = await exportWithAsset();
    const { html, written } = await exportPage(out, HERO.src);
    const img = /<img src="([^"]+)" srcset="([^"]+)"/.exec(html);
    const candidates: (readonly [string | undefined, string | undefined])[] = [
      ...[...html.matchAll(/<source type="([^"]+)" srcset="([^"]+)"/g)].map(
        ([, type, srcset]) => [type, srcset] as const,
      ),
      // The fallback is the source's own encoding: the PNG this export holds.
      ['image/png', img?.[2]],
    ];
    expect(candidates.map(([type]) => type)).toEqual(['image/webp', 'image/png']);
    expect(img?.[1]?.startsWith('/_img/')).toBe(true);
    for (const [type, srcset] of candidates) {
      for (const candidate of (srcset ?? '').split(', ')) {
        const [url, descriptor] = candidate.split(' ');
        expect(url?.startsWith('/_img/')).toBe(true);
        const info = probeImage(await Bun.file(join(out, url?.slice(1) ?? '')).bytes());
        expect(`${String(info.width)}w`).toBe(descriptor ?? '');
        expect(`image/${info.format}`).toBe(type ?? '');
      }
    }
    // 32 and the intrinsic 64 (usableWidths caps the list there), in webp and the source PNG.
    expect(written).toHaveLength(4);
    expect(html).not.toContain('?w=');
  });

  test('a src the export does not hold is X_IMAGE_SOURCE_UNREADABLE', async () => {
    const out = await exportWithAsset();
    expect(await codeOf(() => exportPage(out, '/media/photos/hero.png'))).toBe(
      'X_IMAGE_SOURCE_UNREADABLE',
    );
  });

  test('an avif candidate is X_IMAGE_UNSUPPORTED at build, never a dead <source>', async () => {
    const out = await exportWithAsset();
    expect(await codeOf(() => exportPage(out, HERO.src, ['avif', 'webp']))).toBe(
      'X_IMAGE_UNSUPPORTED',
    );
  });

  test('a URL no exported document names is never written', async () => {
    const out = await exportWithAsset();
    const capture = await staticCapture(out, false);
    // Rendered only to weigh (an app/ page), never exported: its unreadable src is not the build's.
    responsiveImage({ ...HERO, src: '/media/x.png' }, { widths: [32] });
    capture.close();
    await Bun.write(join(out, 'index.html'), '<html></html>');
    expect(await capture.write([{ path: '/', file: 'index.html' }])).toEqual({
      images: [],
      cards: [],
    });
  });
});

// #1075's class: an immutable name is a promise about BYTES. A variant's bytes are a function of
// the source, the width, the format AND the encoder, so a name of the first three alone kept its
// URL across a framework or Bun upgrade that re-encoded it, and a CDN served the old file.
describe('unit · a variant is named by everything its bytes depend on', () => {
  const urlUnder = async (out: string, encoder: string): Promise<string> =>
    (await staticImages(out, encoder)).imageUrl({ src: HERO.src, width: 32, format: 'webp' });

  test('one source, one encoder: one URL, build after build', async () => {
    const out = await exportWithAsset();
    expect(await urlUnder(out, 'core@1+bun@1')).toBe(await urlUnder(out, 'core@1+bun@1'));
  });

  test('another encoder renames the variant', async () => {
    const out = await exportWithAsset();
    expect(await urlUnder(out, 'core@2+bun@1')).not.toBe(await urlUnder(out, 'core@1+bun@1'));
  });

  test('the default encoder is this framework and this Bun', () => {
    expect(imageEncoderIdentity()).toBe(`${frameworkVersion()}+bun${Bun.version}`);
  });
});
