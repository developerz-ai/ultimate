// A static export's social card, photographed by a real Chrome: the card page is served from the
// export on loopback, the PNG on disk is 1200 x 630, and the `og:image` the home page carries
// names that file's path in the export. Skips with no Chrome; refuses to skip under
// `E2E_BROWSER_REQUIRED=1`.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { probeImage } from '@ultimat3/core';
import { findChrome } from '@ultimat3/scraping/cdp';
import { renderMeta } from '@ultimat3/seo';
import { E2E_BROWSER_OPEN_MS } from '@ultimat3/testing';
import { cdpShotDriver } from '../src/cdp-shot-driver';
import { staticCapture } from '../src/static-capture';
import { CARD_SIZE } from '../src/static-cards';

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const out = mkdtempSync(join(tmpdir(), 'x-static-cards-e2e-'));

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe.skipIf(chrome === undefined && !required)('static social cards, in a real Chrome', () => {
  test(
    'the card is a 1200 x 630 PNG, and og:image resolves to it',
    async () => {
      if (chrome === undefined)
        expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
      const capture = await staticCapture(out, true, async () =>
        cdpShotDriver({ executablePath: chrome, viewport: CARD_SIZE }),
      );
      const head = renderMeta({ title: 'Home', description: 'd', og: { capture: '/og/home' } });
      capture.close();
      const image = head.find((tag) => tag.attrs['property'] === 'og:image')?.attrs['content'];
      await Bun.write(join(out, 'index.html'), `<meta property="og:image" content="${image}">`);
      await Bun.write(
        join(out, 'og/home/index.html'),
        '<!doctype html><html><body style="margin:0"><h1>Card</h1></body></html>',
      );
      const files = await capture.write([
        { path: '/', file: 'index.html' },
        { path: '/og/home', file: 'og/home/index.html' },
      ]);
      expect(files.cards).toEqual(['/_og/og/home.png']);

      // The path og:image names is the file a dumb file server answers it with.
      expect(image).toBe('/_og/og/home.png');
      const info = probeImage(await Bun.file(join(out, (image ?? '').slice(1))).bytes());
      expect([info.width, info.height]).toEqual([1200, 630]);
    },
    E2E_BROWSER_OPEN_MS + 60_000,
  );
});
