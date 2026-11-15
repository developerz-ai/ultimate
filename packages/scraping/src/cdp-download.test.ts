// The browser driver's `download()` over the CDP fake: bytes off the Response-stage pause, the name
// off `Browser.downloadWillBegin`, a `blob:` read through the page, and nothing written to a disk.
// The protocol sequence the fake replays was measured on Chrome 157 (`cdp-download.ts`'s header).

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { downloadCandidate, downloadCatcher, MAX_HELD_DOWNLOADS } from './cdp-download';
import { type FakeCdpPageInit, fakeCdpBrowser } from './cdp-fake-fixture';
import type { CdpPageLike } from './cdp-port';
import { cdpTarget } from './cdp-target';

const URL_A = 'https://shop.test/orders';

const open = async (init: Partial<FakeCdpPageInit> = {}, maxDownloadBytes?: number) => {
  const browser = fakeCdpBrowser({ url: URL_A, html: '<p>orders</p>', ...init });
  const target = await cdpTarget({
    browser,
    page: await browser.newPage(),
    rules: { allowHosts: ['shop.test'] },
    clock: frozenClock(),
    ...(maxDownloadBytes === undefined ? {} : { maxDownloadBytes }),
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
    // Released with the very bytes read: a stream taken from a response cannot be continued.
    expect(browser.browserFetch.fulfilled).toContain('https://shop.test/export.csv');
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

  test('two files from one trigger: the newest answers, and the older is cleared', async () => {
    const { browser, target } = await open();
    for (const name of ['a.csv', 'b.csv']) {
      await browser.emitDownload({
        url: `https://shop.test/${name}`,
        filename: name,
        body: name,
        disposition: 'attachment',
      });
    }
    expect((await target.download({ timeoutMs: 1_000 })).filename).toBe('b.csv');
    expect(await codeOf(target.download({ timeoutMs: 100 }))).toBe('X_SCRAPE_DOWNLOAD_TIMEOUT');
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

describe('unit · download() answers the LAST trigger, never an older file', () => {
  const csv = (name: string) => ({
    url: `https://shop.test/${name}`,
    filename: name,
    body: name,
    disposition: 'attachment',
  });

  test('a download nobody asked for is not handed to the next click', async () => {
    const { browser, target } = await open();
    await target.click('#a');
    await browser.emitDownload(csv('a.csv'));
    await target.click('#b');
    await browser.emitDownload(csv('b.csv'));
    expect((await target.download({ timeoutMs: 1_000 })).filename).toBe('b.csv');
  });

  test('a file that lands after its download() timed out does not answer the next trigger', async () => {
    const { browser, target } = await open();
    await target.click('#a');
    expect(await codeOf(target.download({ timeoutMs: 100 }))).toBe('X_SCRAPE_DOWNLOAD_TIMEOUT');
    await browser.emitDownload(csv('a.csv'));
    await target.click('#b');
    await browser.emitDownload(csv('b.csv'));
    expect((await target.download({ timeoutMs: 1_000 })).filename).toBe('b.csv');
  });

  test('asked BEFORE the new file lands, it waits for it rather than answer the late one', async () => {
    const { browser, target } = await open();
    await target.click('#a');
    expect(await codeOf(target.download({ timeoutMs: 100 }))).toBe('X_SCRAPE_DOWNLOAD_TIMEOUT');
    await browser.emitDownload(csv('a.csv'));
    await target.click('#b');
    const pending = target.download({ timeoutMs: 60_000 });
    await browser.emitDownload(csv('b.csv'));
    expect((await pending).filename).toBe('b.csv');
  });

  test('a late file is still the answer when asked again with no new trigger', async () => {
    const { browser, target } = await open();
    await target.click('#a');
    expect(await codeOf(target.download({ timeoutMs: 100 }))).toBe('X_SCRAPE_DOWNLOAD_TIMEOUT');
    await browser.emitDownload(csv('a.csv'));
    expect((await target.download({ timeoutMs: 1_000 })).filename).toBe('a.csv');
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

  test('past the bound, the newest still answers — the held files never grow the worker', async () => {
    const { browser, target } = await open();
    for (let index = 0; index <= MAX_HELD_DOWNLOADS; index += 1) {
      await browser.emitDownload({
        url: `https://shop.test/${String(index)}.bin`,
        filename: `${String(index)}.bin`,
        body: String(index),
        disposition: 'attachment',
      });
    }
    expect((await target.download({ timeoutMs: 1_000 })).filename).toBe(
      `${String(MAX_HELD_DOWNLOADS)}.bin`,
    );
  });
});

describe('unit · a body is never buffered past maxDownloadBytes', () => {
  const MIB = 1024 * 1024;

  test('a DECLARED length over the cap is left to Chrome — not one byte read', async () => {
    const { browser, target } = await open({}, 10);
    await browser.emitDownload({
      url: 'https://shop.test/big.bin',
      filename: 'big.bin',
      body: 'x'.repeat(20),
      disposition: 'attachment',
    });
    expect(browser.browserFetch.bytesRead).toBe(0);
    expect(browser.browserFetch.continued).toContain('https://shop.test/big.bin');
    expect(await codeOf(target.download({ timeoutMs: 100 }))).toBe('X_SCRAPE_DOWNLOAD_TIMEOUT');
  });

  test('an UNDECLARED attachment is abandoned at the cap, mid-stream, and failed', async () => {
    const { browser, target } = await open({}, 1.5 * MIB);
    await browser.emitDownload({
      url: 'https://shop.test/chunked.bin',
      filename: 'chunked.bin',
      body: 'x'.repeat(4 * MIB),
      disposition: 'attachment',
      length: 'none',
    });
    // Two 1 MiB reads crossed the cap; the other two MiB were never pulled into the worker.
    expect(browser.browserFetch.bytesRead).toBe(2 * MIB);
    expect(browser.browserFetch.failed).toContain('https://shop.test/chunked.bin');
    expect(await codeOf(target.download({ timeoutMs: 100 }))).toBe('X_SCRAPE_DOWNLOAD_TIMEOUT');
  });

  test('an undeclared attachment under the cap is read whole and answers', async () => {
    const { browser, target } = await open({}, 1.5 * MIB);
    await browser.emitDownload({
      url: 'https://shop.test/small.csv',
      filename: 'small.csv',
      body: 'a,b',
      disposition: 'attachment',
      length: 'none',
    });
    expect(text((await target.download({ timeoutMs: 1_000 })).bytes)).toBe('a,b');
  });

  test('an undeclared NON-attachment is left alone: cutting it would break what the page shows', async () => {
    const { browser } = await open({}, 10);
    await browser.emitDownload({
      url: 'https://shop.test/feed.json',
      filename: 'feed.json',
      body: '{}',
      contentType: 'application/json',
      length: 'none',
    });
    expect(browser.browserFetch.bytesRead).toBe(0);
    expect(browser.browserFetch.continued).toContain('https://shop.test/feed.json');
  });

  test('a cap that is not a number is refused when the target is built', async () => {
    const thrown = await open({}, Number.NaN).then(
      () => undefined,
      (caught: unknown) => (caught as { code?: string }).code,
    );
    expect(thrown).toBe('X_INVARIANT');
  });
});

describe('unit · a file is stamped when it BEGAN, not when its bytes arrived', () => {
  test('a blob download begun before a trigger, read after it, is dropped', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const page = {
      ...fakeCdpBrowser({ url: URL_A, html: '' }),
      evaluate: () =>
        new Promise<unknown>((resolve) => {
          answer = resolve;
        }),
    } as unknown as CdpPageLike;
    const catcher = downloadCatcher({ page, clock: frozenClock() });
    let willBegin: (payload: unknown) => void = () => undefined;
    await catcher.arm({
      send: () => Promise.resolve({}),
      detach: () => Promise.resolve(),
      on: (event, handler) => {
        if (event === 'Browser.downloadWillBegin') willBegin = handler;
      },
    });
    willBegin({ url: 'blob:https://shop.test/1', suggestedFilename: 'old.txt' });
    catcher.mark();
    answer(btoa('old'));
    await Promise.resolve();
    expect(await codeOf(catcher.next(100, URL_A))).toBe('X_SCRAPE_DOWNLOAD_TIMEOUT');
  });
});
