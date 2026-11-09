// `page.pdf(layout)`: the layout reaches the port in the library's words, a request naming two
// sizes is refused before any driver, and the offline driver answers different bytes per layout.

import { describe, expect, test } from 'bun:test';
import { fakeBrowserTarget } from './cdp-fake-target-fixture';
import type { CdpPageLike, CdpPdfOptions } from './cdp-port';
import { cdpTarget } from './cdp-target';
import { testScrapeClock } from './clock';
import { fakePage } from './driver-fake';
import type { ScrapePage } from './page';
import { pageOverTarget } from './page-over-target';
import { printOptionsOf } from './pdf-print';
import type { PdfRequest } from './pdf-request';

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

/** A CDP page that keeps what `pdf()` was handed, through the real `cdpTarget`. */
async function cdpPage(): Promise<{ readonly page: ScrapePage; readonly asked: CdpPdfOptions[] }> {
  const asked: CdpPdfOptions[] = [];
  const page: CdpPageLike = {
    url: () => 'https://app.test/invoice/1',
    goto: () => Promise.resolve(undefined),
    content: () => Promise.resolve(''),
    evaluate: () => Promise.resolve(undefined),
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    select: () => Promise.resolve([]),
    screenshot: () => Promise.resolve(new Uint8Array()),
    pdf: (options) => {
      asked.push({ ...options });
      return Promise.resolve(new Uint8Array([0x25]));
    },
    setRequestInterception: () => Promise.resolve(),
    on: () => undefined,
    frames: () => [],
    close: () => Promise.resolve(),
  };
  const target = await cdpTarget({
    page,
    browser: {
      newPage: () => Promise.resolve(page),
      target: () => fakeBrowserTarget().target,
      setCookie: () => Promise.resolve(),
      close: () => Promise.resolve(),
      process: () => null,
    },
    rules: { allowHosts: ['app.test'] },
    clock: testScrapeClock(),
  });
  return {
    page: pageOverTarget(target, {
      clock: testScrapeClock(),
      allowHosts: ['app.test'],
      defaultTimeoutMs: 100,
    }),
    asked,
  };
}

describe('unit · page.pdf() layout reaches the port', () => {
  test('format, margins, background and a header band arrive in the library spelling', async () => {
    const { page, asked } = await cdpPage();
    await page.pdf({
      format: 'a4',
      marginMm: { top: 12, bottom: 18 },
      printBackground: true,
      headerHtml: '<span class="title"></span>',
    });
    expect(asked).toEqual([
      {
        format: 'A4',
        margin: { top: '12mm', bottom: '18mm' },
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<span class="title"></span>',
        // Blank, never absent: Chrome prints its own date and URL into a missing template.
        footerTemplate: '<span></span>',
      },
    ]);
  });

  test('a custom size is sent as two CSS lengths, and no layout sends no option at all', async () => {
    const { page, asked } = await cdpPage();
    await page.pdf({ widthMm: 100, heightMm: 150 });
    await page.pdf();
    expect(asked).toEqual([{ width: '100mm', height: '150mm' }, {}]);
  });

  test('preferCssPageSize alone is forwarded under the library name', () => {
    expect(printOptionsOf({ preferCssPageSize: true })).toEqual({ preferCSSPageSize: true });
  });
});

describe('unit · a layout no engine honours is refused before any driver', () => {
  const refused: ReadonlyArray<readonly [string, PdfRequest]> = [
    ['two sizes', { format: 'a4', widthMm: 210, heightMm: 297 }],
    ['half a size', { widthMm: 210 }],
    ['a size beside the CSS page size', { format: 'letter', preferCssPageSize: true }],
    ['a NaN width', { widthMm: Number.NaN, heightMm: 10 }],
    ['a negative margin', { marginMm: { left: -1 } }],
    ['an unknown format', { format: 'b5' as PdfRequest['format'] }],
  ];
  for (const [name, request] of refused) {
    test(`${name} is X_SCRAPE_PDF_OPTIONS_INVALID and never reaches the port`, async () => {
      const { page, asked } = await cdpPage();
      expect(await codeOf(page.pdf(request))).toBe('X_SCRAPE_PDF_OPTIONS_INVALID');
      expect(asked).toEqual([]);
    });
  }

  test('a clip on a PDF keeps its own refusal', async () => {
    const { page } = await cdpPage();
    const clip = { x: 0, y: 0, width: 10, height: 10 };
    expect(await codeOf(page.pdf({ clip, format: 'a4' }))).toBe('X_SCRAPE_CAPTURE_INVALID');
  });
});

describe('unit · the offline driver answers different bytes per layout', () => {
  const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

  test('no layout is the old constant; a4 and letter are two documents', async () => {
    const page = fakePage('<p>invoice</p>', { clock: testScrapeClock(), timeoutMs: 100 });
    expect(text(await page.pdf())).toBe('%PDF-1.4 offline');
    const a4 = text(await page.pdf({ format: 'a4', marginMm: { top: 10 } }));
    const letter = text(await page.pdf({ format: 'letter' }));
    expect(a4).toBe('%PDF-1.4 offline format=a4 marginMm=10/undefined/undefined/undefined');
    expect(letter).toBe('%PDF-1.4 offline format=letter');
  });
});
