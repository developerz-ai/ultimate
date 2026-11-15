// The offline target's recorded maps are keyed by strings the RECORDING chose — an `<iframe name>`,
// a selector, an `evaluate()` expression. Every one of them can name an `Object.prototype` member,
// and a lookup that walks the prototype chain answers a function where the fixture has nothing.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { htmlTarget } from './html-target';
import type { PageRecording } from './recording';

const PAGE_URL = 'https://shop.test/orders';

const targetOver = (recording: PageRecording) =>
  htmlTarget({
    driver: 'fixture',
    lookup: (url) => Promise.resolve(url === recording.url ? recording : undefined),
    rules: { allowHosts: ['shop.test'] },
    clock: frozenClock(),
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

  test('setOfflineMode CUTS navigation while set, and a cleared one navigates again', async () => {
    // Pinned HERE rather than through the page: `pageOverTarget.offline` is `async`, so its `await`
    // would hide a synchronous throw from this target from every page-level test.
    //
    // Never a resolved no-op: that let "a like taken offline is queued" pass against an app that
    // was online the whole time. A navigation while offline fails with the code a browser's does.
    const target = targetOver({ url: PAGE_URL, html: '<a id="next" href="/next">n</a>' });
    await target.setOfflineMode(true);
    expect(await codeOf(() => target.goto(PAGE_URL, { timeoutMs: 10 }))).toBe(
      'X_SCRAPE_BROWSER_UNREACHABLE',
    );
    expect(await codeOf(() => target.click('#next'))).toBe('X_SCRAPE_BROWSER_UNREACHABLE');
    await target.setOfflineMode(false);
    await expect(target.goto(PAGE_URL, { timeoutMs: 10 })).resolves.toBeUndefined();
  });

  test('setOfflineMode on a closed target REJECTS rather than throwing past .catch()', async () => {
    const target = targetOver({ url: PAGE_URL, html: '<p>o</p>' });
    await target.close();
    let caught: unknown;
    await target.setOfflineMode(true).catch((thrown: unknown) => {
      caught = thrown;
    });
    expect((caught as { code?: string } | undefined)?.code).toBe('X_SCRAPE_BROWSER_UNREACHABLE');
  });

  test("the file is the LAST click's: a later click that downloads nothing disarms it", async () => {
    // The browser driver's rule (`cdp-download.ts`): a click is a trigger, and a file from an
    // earlier one is not handed to `download()` after a later one.
    const target = targetOver({
      url: PAGE_URL,
      html: '<button id="export">Export</button><button id="other">Other</button>',
      downloads: { '#export': 'orders.csv:id,1' },
    });
    await target.click('#export');
    await target.click('#other');
    expect(await codeOf(() => target.download({ timeoutMs: 10 }))).toBe(
      'X_SCRAPE_DOWNLOAD_TIMEOUT',
    );
    await target.click('#export');
    await target.press('Escape');
    expect(await codeOf(() => target.download({ timeoutMs: 10 }))).toBe(
      'X_SCRAPE_DOWNLOAD_TIMEOUT',
    );
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

describe('unit · press, focus and accessibility offline', () => {
  test('focus on a present element resolves; on a missing one it is a FIXTURE gap', async () => {
    const target = targetOver({ url: PAGE_URL, html: '<input id="q">' });
    await expect(target.focus('#q')).resolves.toBeUndefined();
    expect(await codeOf(() => target.focus('#missing'))).toBe('X_SCRAPE_FIXTURE_MISSING');
  });

  test('a frame focus reads the FRAME document, not the parent', async () => {
    const target = targetOver({
      url: PAGE_URL,
      html: '<input id="parent-only"><iframe name="idp"></iframe>',
      frames: { idp: '<input id="frame-only">' },
    });
    const inner = (await target.frames())[0]?.target;
    expect(inner).toBeDefined();
    if (inner === undefined) return;
    await expect(inner.focus('#frame-only')).resolves.toBeUndefined();
    expect(await codeOf(() => inner.focus('#parent-only'))).toBe('X_SCRAPE_FIXTURE_MISSING');
  });

  test('press parses the chord and stops — a bad chord is refused with no keyboard at all', async () => {
    const target = targetOver({ url: PAGE_URL, html: '<p>o</p>' });
    await expect(target.press('Meta+K')).resolves.toBeUndefined();
    expect(await codeOf(() => target.press('Meta+'))).toBe('X_SCRAPE_KEY_INVALID');
  });

  test('accessibility answers the HTML-AAM mapping, and a <div onclick> maps to nothing', async () => {
    const target = targetOver({
      url: PAGE_URL,
      html: '<button id="go" aria-label="Run search">Go</button><div id="fake" onclick="go()">Looks clickable</div>',
    });
    expect(await target.accessibility('#go', 25)).toEqual([
      { role: 'button', name: 'Run search', ignored: false },
    ]);
    // The finding the read exists for: no role and no name, on this driver as in a browser.
    expect(await target.accessibility('#fake', 25)).toEqual([
      { role: '', name: '', ignored: false },
    ]);
  });
});
