// Single responsibility: install `@ultimat3/seo`'s static seam for one export, and after the render
// loop write the files the exported documents promised — image variants (`static-images.ts`) and
// social cards (`static-cards.ts`). The prerenderer's one touch point for both.

// why: Bun exposes no path-join primitive, and every page file is relative to the export root.
import { join } from 'node:path';
import { setStaticExport } from '@ultimat3/seo';
import type { ShotDriver } from './browser-launcher-port';
import { BUILD_CAPTURE_ENV } from './build-capture-env';
import { CARD_SIZE, staticCards } from './static-cards';
import { staticImages } from './static-images';

export interface StaticCaptureFiles {
  readonly images: readonly string[];
  readonly cards: readonly string[];
}

export interface StaticCapture {
  /** Uninstalls the seam. Idempotent; runs in the render loop's `finally`. */
  close(): void;
  write(
    pages: readonly { readonly path: string; readonly file: string }[],
  ): Promise<StaticCaptureFiles>;
}

/** The CLI's own CDP driver, or `undefined` when nothing can be launched or attached to. */
async function cardBrowser(): Promise<ShotDriver | undefined> {
  const { appBrowser, cdpUrlFrom, executablePathFrom } = await import('./browser-launcher');
  const cdpUrl = cdpUrlFrom(undefined, Bun.env);
  const executablePath = executablePathFrom(undefined, Bun.env);
  if (cdpUrl === undefined && executablePath === undefined) return undefined;
  return appBrowser({ cdpUrl, executablePath, viewport: CARD_SIZE });
}

export async function staticCapture(
  out: string,
  capture: boolean = Bun.env[BUILD_CAPTURE_ENV] !== 'off',
  browser: () => Promise<ShotDriver | undefined> = cardBrowser,
): Promise<StaticCapture> {
  const images = await staticImages(out);
  const cards = staticCards();
  setStaticExport({ imageUrl: images.imageUrl, cardImage: cards.cardImage });
  return {
    close: () => setStaticExport(undefined),
    async write(pages) {
      const documents = await Promise.all(
        pages.map((page) => Bun.file(join(out, page.file)).text()),
      );
      const exported = new Set(pages.map((page) => page.path));
      return {
        images: await images.write(documents),
        cards: await cards.write(out, documents, exported, { capture, browser }),
      };
    },
  };
}
