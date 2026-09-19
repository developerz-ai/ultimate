// `prepare()` — a script run ahead of every document — end to end across every driver: the CDP
// forward and its ORDER against `goto`, the refusal a launcher without the method earns, and the
// offline drivers' acceptance. Its own file for `color-scheme.test.ts`'s reason: one question
// asked of three implementations.

import { describe, expect, test } from 'bun:test';
import { fakeCdpBrowser, fakeCdpLauncher } from './cdp-fake';
import { cdpTarget } from './cdp-target';
import { testClock } from './clock';
import type { ScrapeDriver } from './driver';
import { localBrowser } from './driver-cdp';
import { fakeBrowser } from './driver-fake';
import { htmlTarget } from './html-target';
import type { PageRecording } from './recording';

const RULES = { allowHosts: ['shop.test'] };
const URL = 'https://shop.test/o';
const HTML = '<html><body><p id="t">hi</p></body></html>';
const SEED = 'try{localStorage.setItem("k","v")}catch(e){}';

describe('unit · the CDP forward', () => {
  test('reaches evaluateOnNewDocument with the exact string, before the navigation', async () => {
    const browser = fakeCdpBrowser({ url: URL, html: HTML });
    const page = await browser.newPage();
    const target = await cdpTarget({ page, browser, rules: RULES, clock: testClock() });

    await target.prepare(SEED);
    expect(browser.prepared).toEqual([SEED]);
    await target.goto(URL, { timeoutMs: 1_000 });
    // Still exactly one, and unchanged: a navigation neither re-registers nor clears it — the
    // browser keeps a new-document script for the page's lifetime, as puppeteer does.
    expect(browser.prepared).toEqual([SEED]);
  });

  // The half that keeps OPTIONAL from meaning UNWIRED, exactly as `setColorScheme` is refused: a
  // launcher predating the method must fail by name, or a theme asked for is silently the default.
  test('a launcher with no evaluateOnNewDocument is X_NOT_IMPLEMENTED, named and fixable', async () => {
    const browser = fakeCdpBrowser({ url: URL, html: HTML });
    const rich = await browser.newPage();
    const { evaluateOnNewDocument: _dropped, ...page } = rich as typeof rich & {
      evaluateOnNewDocument?: unknown;
    };
    const target = await cdpTarget({ page, browser, rules: RULES, clock: testClock() });

    let thrown: { code?: string; fix?: string } = {};
    try {
      await target.prepare(SEED);
    } catch (caught) {
      thrown = caught as { code?: string; fix?: string };
    }
    expect(thrown.code).toBe('X_NOT_IMPLEMENTED');
    expect(thrown.fix).toContain('evaluateOnNewDocument');
    expect(browser.prepared).toEqual([]);
  });
});

describe('unit · the offline drivers', () => {
  const RECORDING: PageRecording = { url: URL, html: HTML };
  const offline = () =>
    htmlTarget({
      driver: 'fake',
      source: 'test',
      lookup: (url) => Promise.resolve(url === URL ? RECORDING : undefined),
      rules: RULES,
      clock: testClock(),
      start: RECORDING,
    });

  // ACCEPTED where `setOfflineMode` is REFUSED: nothing here runs a script, so nothing here can be
  // wrong about one — and a refusal would make every `x shot` unit test need a Chrome.
  test('resolves without a recording, and the page reads the same afterwards', async () => {
    const target = offline();
    await target.prepare(SEED);
    await target.goto(URL, { timeoutMs: 1_000 });
    expect(await target.content()).toBe(HTML);
  });

  test('a closed target REJECTS rather than throwing synchronously', async () => {
    const target = offline();
    await target.close();
    const code = await target.prepare(SEED).then(
      () => 'resolved',
      (thrown: unknown) => (thrown as { code?: string }).code,
    );
    expect(code).toBe('X_SCRAPE_BROWSER_UNREACHABLE');
  });
});

describe('unit · every driver accepts the verb through the page vocabulary', () => {
  const drivers = (): readonly (readonly [string, ScrapeDriver])[] => [
    ['fake', fakeBrowser({ [URL]: HTML })],
    ['puppeteer', localBrowser({ launcher: fakeCdpLauncher({ url: URL, html: HTML }) })],
  ];

  test('prepare() before goto() resolves on each, and the page then answers', async () => {
    for (const [name, driver] of drivers()) {
      const session = await driver.open({
        name: 'prepare',
        rules: RULES,
        clock: testClock(),
        timeoutMs: 5_000,
      });
      try {
        await session.page.prepare(SEED);
        await session.page.goto(URL);
        expect(await session.page.text('#t'), name).toBe('hi');
      } finally {
        await session.close();
      }
    }
  });
});
