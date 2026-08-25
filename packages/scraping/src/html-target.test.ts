// The offline target's recorded maps are keyed by strings the RECORDING chose — an `<iframe name>`,
// a selector, an `evaluate()` expression. Every one of them can name an `Object.prototype` member,
// and a lookup that walks the prototype chain answers a function where the fixture has nothing.

import { describe, expect, test } from 'bun:test';
import { testClock } from './clock';
import { htmlTarget } from './html-target';
import type { PageRecording } from './recording';

const PAGE_URL = 'https://shop.test/orders';

const targetOver = (recording: PageRecording) =>
  htmlTarget({
    driver: 'fixture',
    lookup: (url) => Promise.resolve(url === recording.url ? recording : undefined),
    rules: { allowHosts: ['shop.test'] },
    clock: testClock(),
    source: 'test/fixtures',
    start: recording,
  });

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · an unrecorded frame is missing, even when it is named after a prototype key', () => {
  test('<iframe name="constructor"> with no recording throws X_SCRAPE_FIXTURE_MISSING', async () => {
    // The map EXISTS and does not hold this key — which is the only shape the bug had: a bare
    // `page.frames?.[name]` walked the prototype and answered `Object` for `constructor`.
    const target = targetOver({
      url: PAGE_URL,
      html: '<iframe name="constructor"></iframe>',
      frames: { sidebar: '<p>inner</p>' },
    });
    expect(await codeOf(() => target.frames())).toBe('X_SCRAPE_FIXTURE_MISSING');
  });

  test('a frame that IS recorded still resolves', async () => {
    const target = targetOver({
      url: PAGE_URL,
      html: '<iframe name="constructor"></iframe>',
      frames: { constructor: '<p>inner</p>' },
    });
    const frames = await target.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.name).toBe('constructor');
  });
});

describe('unit · an unrecorded evaluate is missing, even for a prototype-key expression', () => {
  test('evaluate("toString") with no recording throws rather than returning a function', async () => {
    const target = targetOver({
      url: PAGE_URL,
      html: '<p>hi</p>',
      evaluate: { 'window.total': '7' },
    });
    expect(await codeOf(() => target.evaluate('toString'))).toBe('X_SCRAPE_FIXTURE_MISSING');
  });

  test('a recorded expression still answers', async () => {
    const target = targetOver({
      url: PAGE_URL,
      html: '<p>hi</p>',
      evaluate: { 'window.total': '7' },
    });
    expect(await target.evaluate('window.total')).toBe(7);
  });
});

describe('unit · a download is armed only by a RECORDED selector', () => {
  test('clicking #constructor arms nothing, so download() refuses', async () => {
    const target = targetOver({
      url: PAGE_URL,
      html: '<a id="constructor" href="">Export</a>',
      downloads: { '#export': 'orders.csv:id,1' },
    });
    await target.click('#constructor');
    expect(await codeOf(() => target.download({ timeoutMs: 10 }))).toBe(
      'X_SCRAPE_DOWNLOAD_TIMEOUT',
    );
  });

  test('the refusal is a REJECTION — `download().catch()` is reached, never jumped over', async () => {
    // `download()` is typed `Promise<ScrapeDownloadFile>`, and `page-over-target.ts` forwards it
    // straight through: a synchronous `throw` here escapes past the caller's `.catch()` and lands
    // wherever the call was written, so an artifact writer's own handler never runs.
    const target = targetOver({ url: PAGE_URL, html: '<p>no download here</p>' });
    let caught: unknown;
    await target.download({ timeoutMs: 10 }).catch((thrown: unknown) => {
      caught = thrown;
    });
    expect((caught as { code?: string } | undefined)?.code).toBe('X_SCRAPE_DOWNLOAD_TIMEOUT');
  });

  test('setOfflineMode REFUSES, and the refusal is a REJECTION too', async () => {
    // The same rule one method over, and it has to be pinned HERE rather than through the page:
    // `pageOverTarget.offline` is `async`, so its `await` would turn a synchronous throw from
    // this target into a rejection and hide the defect from every page-level test.
    //
    // Refused rather than resolved because there is no browser to take offline. A resolved
    // promise would let "a like taken offline is queued" pass against an app that was online.
    const target = targetOver({ url: PAGE_URL, html: '<p>o</p>' });
    let caught: unknown;
    await target.setOfflineMode(true).catch((thrown: unknown) => {
      caught = thrown;
    });
    expect((caught as { code?: string } | undefined)?.code).toBe('X_NOT_IMPLEMENTED');
    expect((caught as { fix?: string } | undefined)?.fix).toContain('localBrowser()');
  });

  test('a recorded download still arms', async () => {
    const target = targetOver({
      url: PAGE_URL,
      html: '<a id="export" href="">Export</a>',
      downloads: { '#export': 'orders.csv:id,1' },
    });
    await target.click('#export');
    const file = await target.download({ timeoutMs: 10 });
    expect(file.filename).toBe('orders.csv');
  });
});
