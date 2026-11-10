// The raw-CDP printer over a FAKE connection: the calls it makes in order, the bytes it decodes,
// the error page it refuses, and the browser it always closes — no Chrome needed.

import { describe, expect, test } from 'bun:test';
import { chromePdfRenderer } from './pdf-render';
import { fakePdfBrowser } from './pdf-render-fixture';

const fakeBrowser = fakePdfBrowser;

const URL_ = 'http://app.test/invoices/42/print';

describe('unit · chromePdfRenderer', () => {
  test('prints the loaded page and answers the decoded bytes', async () => {
    const fake = fakeBrowser();
    const renderer = chromePdfRenderer({ launch: () => Promise.resolve(fake.browser) });
    const bytes = await renderer.render({ url: URL_, layout: { format: 'a4' } });
    expect(new TextDecoder().decode(bytes)).toBe('%PDF-1.7 fake');
    expect(fake.calls.map((call) => call.method)).toEqual([
      'Target.createTarget',
      'Target.attachToTarget',
      'Page.enable',
      'Fetch.enable',
      'Page.navigate',
      'Fetch.continueRequest',
      'Runtime.evaluate',
      'Page.printToPDF',
      'Target.closeTarget',
    ]);
    const print = fake.calls.find((call) => call.method === 'Page.printToPDF');
    expect(print?.params).toMatchObject({ transferMode: 'ReturnAsBase64' });
    expect(print?.params?.['paperWidth']).toBeCloseTo(210 / 25.4, 5);
    expect(fake.closed()).toBe(true);
  });

  test('an error page is refused, never printed, and the browser still closes', async () => {
    const fake = fakeBrowser({ status: 404 });
    const renderer = chromePdfRenderer({ launch: () => Promise.resolve(fake.browser) });
    const refused = renderer.render({ url: URL_, layout: {} });
    await expect(refused).rejects.toMatchObject({
      code: 'X_SCRAPE_PDF_ROUTE_FAILED',
      retry: 'terminal',
    });
    expect(fake.calls.some((call) => call.method === 'Page.printToPDF')).toBe(false);
    expect(fake.closed()).toBe(true);
  });

  test('a 503 is retryable — the moment, not the page', async () => {
    const fake = fakeBrowser({ status: 503 });
    const renderer = chromePdfRenderer({ launch: () => Promise.resolve(fake.browser) });
    await expect(renderer.render({ url: URL_, layout: {} })).rejects.toMatchObject({
      code: 'X_SCRAPE_PDF_ROUTE_FAILED',
      retry: 'retryable',
    });
  });

  test('a page that never loads is X_CDP_TIMEOUT', async () => {
    const fake = fakeBrowser({ loads: false });
    const renderer = chromePdfRenderer({ launch: () => Promise.resolve(fake.browser) });
    await expect(renderer.render({ url: URL_, layout: {} })).rejects.toMatchObject({
      code: 'X_CDP_TIMEOUT',
    });
    expect(fake.closed()).toBe(true);
  });

  test('a refused navigation is X_CDP_CALL_FAILED', async () => {
    const fake = fakeBrowser({ navigateError: 'net::ERR_CONNECTION_REFUSED', loads: false });
    const renderer = chromePdfRenderer({ launch: () => Promise.resolve(fake.browser) });
    await expect(renderer.render({ url: URL_, layout: {} })).rejects.toMatchObject({
      code: 'X_CDP_CALL_FAILED',
    });
  });
});
