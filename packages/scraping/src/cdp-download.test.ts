// The browser driver's `download()` over the CDP fake: bytes off the Response-stage pause, the name
// off `Browser.downloadWillBegin`, a `blob:` read through the page, and nothing written to a disk.
// The protocol sequence the fake replays was measured on Chrome 157 (`cdp-download.ts`'s header).

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { downloadCandidate, MAX_HELD_DOWNLOADS } from './cdp-download';
import { type FakeCdpPageInit, fakeCdpBrowser } from './cdp-fake-fixture';
import { cdpTarget } from './cdp-target';

const URL_A = 'https://shop.test/orders';

const open = async (init: Partial<FakeCdpPageInit> = {}) => {
  const browser = fakeCdpBrowser({ url: URL_A, html: '<p>orders</p>', ...init });
  const target = await cdpTarget({
    browser,
    page: await browser.newPage(),
    rules: { allowHosts: ['shop.test'] },
    clock: frozenClock(),
  });
  return { browser, target };
};

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · download() takes the file off the wire', () => {
  test('an attachment: its bytes and the name Chrome chose, and Chrome writes no copy', async () => {
    const { browser, target } = await open();
    expect(browser.browserFetch.responseStage).toBe(true);
    expect(browser.browserFetch.downloadBehavior).toEqual({
      behavior: 'deny',
      eventsEnabled: true,
    });
    await browser.emitDownload({
      url: 'https://shop.test/export.csv',
      filename: 'orders.csv',
      body: 'id,total\n1,900',
      contentType: 'text/csv',
      disposition: 'attachment; filename="orders.csv"',
    });
    const file = await target.download({ timeoutMs: 1_000 });
    expect([file.filename, text(file.bytes)]).toEqual(['orders.csv', 'id,total\n1,900']);
    // Released after the read: a paused response nobody continues is a page that never loads.
    expect(browser.browserFetch.continued).toContain('https://shop.test/export.csv');
  });

  test('a <a download> link sends no Content-Disposition, and is still caught', async () => {
    const { browser, target } = await open();
    await browser.emitDownload({
      url: 'https://shop.test/notes.txt',
      filename: 'notes.txt',
      body: 'plain-bytes',
      contentType: 'text/plain',
    });
    expect(text((await target.download({ timeoutMs: 1_000 })).bytes)).toBe('plain-bytes');
  });

  test('a script-made blob: download is read through the page that minted it', async () => {
    const blobUrl = 'blob:https://shop.test/5f0c';
    const { browser, target } = await open({ blobs: { [blobUrl]: 'made-in-page' } });
    await browser.emitDownload({ url: blobUrl, filename: 'report.txt', body: '' });
    const file = await target.download({ timeoutMs: 1_000 });
    expect([file.filename, text(file.bytes)]).toEqual(['report.txt', 'made-in-page']);
  });

  test('two downloads are handed out in the order they began', async () => {
    const { browser, target } = await open();
    for (const name of ['a.csv', 'b.csv']) {
      await browser.emitDownload({
        url: `https://shop.test/${name}`,
        filename: name,
        body: name,
        disposition: 'attachment',
      });
    }
    expect((await target.download({ timeoutMs: 1_000 })).filename).toBe('a.csv');
    expect((await target.download({ timeoutMs: 1_000 })).filename).toBe('b.csv');
  });

  test('nothing triggered is X_SCRAPE_DOWNLOAD_TIMEOUT, and it REJECTS', async () => {
    const { target } = await open();
    let caught: unknown;
    await target.download({ timeoutMs: 200 }).catch((thrown: unknown) => {
      caught = thrown;
    });
    expect((caught as { code?: string } | undefined)?.code).toBe('X_SCRAPE_DOWNLOAD_TIMEOUT');
  });

  test('an HTML page is never captured — an ordinary navigation pays nothing', async () => {
    const { browser, target } = await open();
    await browser.emitDownload({
      url: 'https://shop.test/page.html',
      filename: 'page.html',
      body: '<p>x</p>',
      contentType: 'text/html; charset=utf-8',
    });
    expect(await codeOf(target.download({ timeoutMs: 100 }))).toBe('X_SCRAPE_DOWNLOAD_TIMEOUT');
    expect(browser.browserFetch.continued).toContain('https://shop.test/page.html');
  });
});

describe('unit · which responses are read', () => {
  const header = (name: string, value: string) => [{ name, value }];

  test('an attachment always; a non-page type always; a page or a redirect never', () => {
    expect(downloadCandidate(200, header('Content-Disposition', 'attachment'))).toBe(true);
    expect(downloadCandidate(200, header('content-type', 'application/pdf'))).toBe(true);
    expect(downloadCandidate(200, header('Content-Type', 'text/html'))).toBe(false);
    expect(downloadCandidate(200, header('Content-Type', 'application/xhtml+xml'))).toBe(false);
    expect(downloadCandidate(302, header('Content-Disposition', 'attachment'))).toBe(false);
  });

  test('the held files are bounded: the oldest is dropped, never the worker', async () => {
    const { browser, target } = await open();
    for (let index = 0; index <= MAX_HELD_DOWNLOADS; index += 1) {
      await browser.emitDownload({
        url: `https://shop.test/${String(index)}.bin`,
        filename: `${String(index)}.bin`,
        body: String(index),
        disposition: 'attachment',
      });
    }
    expect((await target.download({ timeoutMs: 1_000 })).filename).toBe('1.bin');
  });
});
