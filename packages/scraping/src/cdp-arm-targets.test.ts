// `allowHosts` on EVERY target the browser opens, not only the page this package created. Measured
// on Chrome 150 before the fix: with page-level interception armed, a scraped page's
// `window.open('http://off-list/…')` reached the off-list server — the popup is a new target, and
// `page.setRequestInterception` never sees it. Browser-level `Fetch` does; the fake models it.

import { describe, expect, test } from 'bun:test';
import { createLogger } from '@ultimat3/core';
import { fakeCdpLauncher } from './cdp-fake';
import { fakeBrowserTarget } from './cdp-fake-target';
import { testClock } from './clock';
import type { SessionInit } from './driver';
import { localBrowser, remoteBrowser } from './driver-cdp';

const init: SessionInit = {
  name: 'orders',
  logger: createLogger({ writer: () => undefined }),
  rules: { allowHosts: ['shop.test'], block: ['image'] },
  clock: testClock(),
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
});
