// Single responsibility: social cards as FILES in a static export. While it renders, `og.capture`
// is answered as `/_og/<path>.png` at 1200 x 630 and recorded; after it, each card an exported
// document names is photographed from its exported page over the CLI's own CDP driver. Under
// `--no-capture` (the gate's build) the tags are stamped and no PNG is written.

// why: Bun exposes no path-join primitive, and every card path is relative to the export root.
import { join } from 'node:path';
import { probeImage, transformImageBytes } from '@ultimat3/core';
import type { OpenGraphImage } from '@ultimat3/seo';
import type { ShotDriver } from './browser-launcher-port';
import { DEFAULT_PAGE_TIMEOUT_MS, systemShotClock } from './cdp-shot-clock';
import { CardBrowserMissingError, CardRouteUnknownError } from './static-capture-errors';
import { serveExport } from './static-cards-serve';

/** The size every platform crops a link preview from. */
export const CARD_SIZE = Object.freeze({ width: 1200, height: 630 });

export const STATIC_CARD_DIR = '_og';

/** `/og/post/hello` → `/_og/og/post/hello.png`; `/` → `/_og/index.png`. */
export function cardUrl(capturePath: string): string {
  const trimmed = capturePath.replace(/\/+$/, '');
  return `/${STATIC_CARD_DIR}${trimmed === '' ? '/index' : trimmed}.png`;
}

export interface CardCaptureOptions {
  /** `false` under `--no-capture`: the tags are stamped, no browser is asked, no PNG is written. */
  readonly capture: boolean;
  /** The browser, asked only when a card has to be taken. `undefined` means none is available. */
  readonly browser: () => Promise<ShotDriver | undefined>;
}

export interface StaticCards {
  /** The `og:image` the seo seam stamps for one `og.capture`. Never throws. */
  cardImage(capturePath: string): OpenGraphImage;
  /**
   * The cards exported documents name: each capture path must be an exported page
   * (`X_SEO_CARD_ROUTE_UNKNOWN`), then each is photographed unless capture is off. Answers the
   * PNG site paths written.
   */
  write(
    out: string,
    documents: readonly string[],
    exportedPaths: ReadonlySet<string>,
    options: CardCaptureOptions,
  ): Promise<readonly string[]>;
}

/** Exactly 1200 x 630 on disk, whatever the device pixel ratio did: the stamped size is a promise. */
async function sized(png: Uint8Array): Promise<Uint8Array> {
  const info = probeImage(png);
  if (info.width === CARD_SIZE.width && info.height === CARD_SIZE.height) return png;
  return transformImageBytes(png, { ...CARD_SIZE, fit: 'cover', format: 'png' });
}

export function staticCards(): StaticCards {
  const captures = new Map<string, string>();
  return {
    cardImage(capturePath) {
      const url = cardUrl(capturePath);
      captures.set(url, capturePath);
      return { url, ...CARD_SIZE, type: 'image/png' };
    },
    async write(out, documents, exportedPaths, options) {
      const named = [...captures].filter(([url]) => documents.some((html) => html.includes(url)));
      const unknown = named.map(([, path]) => path).filter((path) => !exportedPaths.has(path));
      if (unknown.length > 0) throw new CardRouteUnknownError(unknown);
      if (!options.capture || named.length === 0) return [];
      const driver = await options.browser();
      if (driver === undefined) throw new CardBrowserMissingError(named.map(([, path]) => path));
      const served = serveExport(out);
      const session = await driver.open({
        name: 'x build cards',
        rules: { allowHosts: ['127.0.0.1'] },
        clock: systemShotClock,
        timeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
        viewport: CARD_SIZE,
      });
      try {
        const written: string[] = [];
        for (const [url, path] of named) {
          await session.page.goto(new URL(path, served.origin).href);
          await Bun.write(join(out, url.slice(1)), await sized(await session.page.screenshot({})));
          written.push(url);
        }
        return written;
      } finally {
        await session.close();
        served.stop();
      }
    },
  };
}
