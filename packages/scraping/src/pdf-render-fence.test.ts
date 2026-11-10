// The print's request fence: the app's headers reach the route's own origin and nowhere else, and
// every request to another origin — an `<img>` in user content, a redirect off-site, an internal
// host — is failed by the browser before it leaves.

import { describe, expect, test } from 'bun:test';
import { chromePdfRenderer } from './pdf-render';
import type { FakeCall } from './pdf-render-fixture';
import { fakePdfBrowser } from './pdf-render-fixture';

const URL_ = 'https://app.test/invoices/42/print';
const TOKEN = { authorization: 'Bearer print-token' };

const decided = (calls: readonly FakeCall[], requestId: string): FakeCall | undefined =>
  calls.find(
    (call) =>
      (call.method === 'Fetch.continueRequest' || call.method === 'Fetch.failRequest') &&
      call.params?.['requestId'] === requestId,
  );

const headerNames = (call: FakeCall | undefined): string[] => {
  const headers = call?.params?.['headers'];
  return Array.isArray(headers)
    ? headers.map((header: { name?: unknown }) => String(header.name).toLowerCase())
    : [];
};

describe('unit · the pdf request fence', () => {
  test('the fence is up before the page navigates, and no header is set browser-wide', async () => {
    const fake = fakePdfBrowser();
    await chromePdfRenderer({ launch: () => Promise.resolve(fake.browser) }).render({
      url: URL_,
      layout: {},
      headers: TOKEN,
    });
    const methods = fake.calls.map((call) => call.method);
    // Presence first: `indexOf` answers -1 for an absent call, and -1 is less than every index.
    expect(methods).toContain('Fetch.enable');
    expect(methods).toContain('Page.navigate');
    expect(methods.indexOf('Fetch.enable')).toBeLessThan(methods.indexOf('Page.navigate'));
    expect(methods).not.toContain('Network.setExtraHTTPHeaders');
  });

  test('a same-origin request carries the headers; a cross-origin one is blocked without them', async () => {
    const fake = fakePdfBrowser({
      subresources: [
        'https://app.test/assets/logo.png',
        'https://evil.test/x.png',
        'http://169.254.169.254/latest/meta-data',
        'http://app.test/invoices/42/print',
      ],
    });
    await chromePdfRenderer({ launch: () => Promise.resolve(fake.browser) }).render({
      url: URL_,
      layout: {},
      headers: TOKEN,
    });
    // r0 the document, r1 its own asset: continued, with the token.
    for (const id of ['r0', 'r1']) {
      const call = decided(fake.calls, id);
      expect(call?.method).toBe('Fetch.continueRequest');
      expect(headerNames(call)).toContain('authorization');
      expect(headerNames(call)).toContain('accept');
    }
    // r2 another site, r3 the metadata service, r4 the same host on another SCHEME: failed.
    for (const id of ['r2', 'r3', 'r4']) {
      const call = decided(fake.calls, id);
      expect(call?.method).toBe('Fetch.failRequest');
      expect(call?.params?.['errorReason']).toBe('BlockedByClient');
      expect(headerNames(call)).toEqual([]);
    }
  });

  test('with no headers, a same-origin request is continued untouched', async () => {
    const fake = fakePdfBrowser();
    await chromePdfRenderer({ launch: () => Promise.resolve(fake.browser) }).render({
      url: URL_,
      layout: {},
    });
    expect(decided(fake.calls, 'r0')?.params).toEqual({ requestId: 'r0' });
  });
});
