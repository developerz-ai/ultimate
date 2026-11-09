// `allowHosts` on EVERY target the browser opens, not only the page this package created. Measured
// on Chrome 150 before the fix: with page-level interception armed, a scraped page's
// `window.open('http://off-list/…')` reached the off-list server — the popup is a new target, and
// `page.setRequestInterception` never sees it. Browser-level `Fetch` does; the fake models it.

import { describe, expect, test } from 'bun:test';
import { structuredLogger } from '@ultimat3/core';
import { fakeCdpLauncher } from './cdp-fake-fixture';
import { fakeBrowserTarget } from './cdp-fake-target-fixture';
import { testScrapeClock } from './clock';
import type { SessionInit } from './driver';
import { localBrowser, remoteBrowser } from './driver-cdp';

const init: SessionInit = {
  name: 'orders',
  logger: structuredLogger({ writer: () => undefined }),
  rules: { allowHosts: ['shop.test'], block: ['image'] },
  clock: testScrapeClock(),
  timeoutMs: 1_000,
};

const opened = async (remote: boolean) => {
  const launcher = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p>hi</p>' });
  const driver = remote
    ? remoteBrowser({ launcher, cdpUrl: 'ws://browser.test/1' })
    : localBrowser({ launcher });
  const session = await driver.open(init);
  return { session, browser: launcher.browser };
};

describe('unit · every new target is screened at the browser, on both drivers', () => {
  for (const remote of [false, true]) {
    const which = remote ? 'remoteBrowser' : 'localBrowser';

    test(`${which}: a popup to a host off the list is failed and recorded as a refusal`, async () => {
      const { session, browser } = await opened(remote);
      expect(browser.browserFetch.enabled).toBe(true);
      browser.emitTargetRequest('https://evil.test/popup', 'Document');
      expect(browser.browserFetch.failed).toEqual(['https://evil.test/popup']);
      expect(session.page.network()).toContainEqual(
        expect.objectContaining({ url: 'https://evil.test/popup', refused: 'host' }),
      );
      await session.close();
    });

    test(`${which}: a request on the list continues, and a blocked type is failed`, async () => {
      const { session, browser } = await opened(remote);
      browser.emitTargetRequest('https://shop.test/popup', 'Document');
      browser.emitTargetRequest('https://shop.test/a.png', 'Image');
      expect(browser.browserFetch.continued).toEqual(['https://shop.test/popup']);
      expect(browser.browserFetch.failed).toEqual(['https://shop.test/a.png']);
      await session.close();
    });
  }

  test('a browser that refuses browser-level interception refuses the session and is closed', async () => {
    const launcher = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p>hi</p>' });
    const refusing = fakeBrowserTarget({ refuseEnable: true });
    const browser = { ...launcher.browser, target: () => refusing.target };
    let closed = false;
    const thrown = await localBrowser({
      launcher: {
        launch: () =>
          Promise.resolve({
            ...browser,
            close: () => {
              closed = true;
              return Promise.resolve();
            },
          }),
      },
    })
      .open(init)
      .then(
        () => 'resolved',
        (error: unknown) => (error as { code?: string }).code,
      );
    expect(thrown).toBe('X_SCRAPE_BROWSER_UNREACHABLE');
    expect(closed).toBe(true);
  });

  // A wildcard admits the NAME; the browser leg resolves it before release (`browser-dial.ts`).
  // `.test` never resolves (RFC 2606) and the test network is sealed, so an unproxied session
  // refuses it and a proxied one — whose exit resolves names — lets it through.
  test('a wildcard-admitted name is screened unless the session dials through an exit', async () => {
    const outcomes: Record<string, readonly string[]> = {};
    for (const proxy of [undefined, 'http://exit.test:3128']) {
      const launcher = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p>hi</p>' });
      const session = await localBrowser({ launcher }).open({
        ...init,
        rules: { allowHosts: ['*'] },
        ...(proxy === undefined ? {} : { proxy }),
      });
      const { browserFetch } = launcher.browser;
      launcher.browser.emitTargetRequest('https://nowhere.test/popup', 'Document');
      // Awaits the DECISION, not a delay: the default resolver (`Bun.dns`) answers on its own time,
      // and a proxied session decides on the event's own tick. Turns, never the wall clock.
      for (let turn = 0; turn < 10_000; turn += 1) {
        if (browserFetch.failed.length + browserFetch.continued.length > 0) break;
        await Bun.sleep(0);
      }
      outcomes[proxy === undefined ? 'direct' : 'proxied'] = browserFetch.failed;
      await session.close();
    }
    expect(outcomes).toEqual({ direct: ['https://nowhere.test/popup'], proxied: [] });
  });
});
