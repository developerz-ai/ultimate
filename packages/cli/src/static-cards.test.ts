// `og.capture` in a static export: the tags are stamped at render time, the card page must be an
// exported page, the picture is 1200 x 630 on disk, and `--no-capture` never asks for a browser.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { blankRaster, encodeImage, isUltimateError, probeImage } from '@ultimat3/core';
import { renderMeta } from '@ultimat3/seo';
import { fakeShotDriver } from './browser-launcher-fake-fixture';
import type { ShotDriver } from './browser-launcher-port';
import { staticCapture } from './static-capture';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PAGES = [
  { path: '/', file: 'index.html' },
  { path: '/og/home', file: 'og/home/index.html' },
];

/** A fake browser whose picture is a real, half-size PNG — so the writer's resize is under test. */
function browser(seen: string[]): () => Promise<ShotDriver> {
  const half = encodeImage(blankRaster(600, 315), 'png');
  const fake = fakeShotDriver([]);
  return async () => ({
    name: 'fake',
    async open(init) {
      expect(init.viewport).toEqual({ width: 1200, height: 630 });
      const session = await fake.open(init);
      return {
        close: () => session.close(),
        page: {
          ...session.page,
          goto: async (url: string) => {
            seen.push(new URL(url).pathname);
          },
          screenshot: async () => half,
        },
      };
    },
  });
}

/** Render the home page's head under the seam, then export both pages and run the writer. */
async function exportCards(capturePath: string, capture: boolean, seen: string[] = []) {
  const out = mkdtempSync(join(tmpdir(), 'x-static-cards-'));
  dirs.push(out);
  const run = await staticCapture(out, capture, browser(seen));
  const head = renderMeta(
    { title: 'Home', description: 'd', og: { capture: capturePath } },
    { baseUrl: 'https://site.test' },
  );
  run.close();
  const tags = head.map((tag) => `<meta ${JSON.stringify(tag.attrs)}>`).join('');
  await Bun.write(join(out, 'index.html'), `<html><head>${tags}</head></html>`);
  await Bun.write(join(out, 'og/home/index.html'), '<html><body>card</body></html>');
  return { out, head, files: await run.write(PAGES) };
}

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'uncoded';
  }
  return 'resolved';
};

describe('unit · static social cards', () => {
  test('the card page is photographed into /_og/<path>.png at exactly 1200 x 630', async () => {
    const seen: string[] = [];
    const { out, head, files } = await exportCards('/og/home', true, seen);
    expect(head).toContainEqual({
      tag: 'meta',
      attrs: { property: 'og:image', content: 'https://site.test/_og/og/home.png' },
    });
    expect(seen).toEqual(['/og/home']);
    expect(files.cards).toEqual(['/_og/og/home.png']);
    const info = probeImage(await Bun.file(join(out, '_og/og/home.png')).bytes());
    expect([info.width, info.height]).toEqual([1200, 630]);
  });

  test('--no-capture stamps the same tags and writes no picture, with no browser asked', async () => {
    const seen: string[] = [];
    const { out, head, files } = await exportCards('/og/home', false, seen);
    expect(head.some((tag) => tag.attrs['property'] === 'og:image:width')).toBe(true);
    expect(files.cards).toEqual([]);
    expect(seen).toEqual([]);
    expect(await Bun.file(join(out, '_og/og/home.png')).exists()).toBe(false);
  });

  test('a capture path no exported page answers is X_SEO_CARD_ROUTE_UNKNOWN, even with no capture', async () => {
    expect(await codeOf(() => exportCards('/og/nowhere', false))).toBe('X_SEO_CARD_ROUTE_UNKNOWN');
  });

  test('a card to take and no browser is X_SEO_CARD_BROWSER_MISSING', async () => {
    const out = mkdtempSync(join(tmpdir(), 'x-static-cards-'));
    dirs.push(out);
    const run = await staticCapture(out, true, async () => undefined);
    renderMeta({ og: { capture: '/og/home' } });
    run.close();
    await Bun.write(join(out, 'index.html'), '<meta content="/_og/og/home.png">');
    await Bun.write(join(out, 'og/home/index.html'), 'card');
    expect(await codeOf(() => run.write(PAGES))).toBe('X_SEO_CARD_BROWSER_MISSING');
  });
});
