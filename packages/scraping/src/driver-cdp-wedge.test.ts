// A wedge on an ATTACHED browser, end to end through the real driver. `process()` is `null` there,
// so the fire's kill reaches nothing, and `evaluate` takes no signal: the only thing that ends a
// call blocked on the socket is closing the browser. Before the fire closed it, this test hung.

import { describe, expect, test } from 'bun:test';
import { structuredLogger } from '@ultimat3/core';
import { fakeBrowserTarget } from './cdp-fake-target-fixture';
import type { CdpBrowserLike, CdpLauncherLike, CdpPageLike } from './cdp-port';
import { testScrapeClock } from './clock';
import { remoteBrowser } from './driver-cdp';

/** A remote browser whose `evaluate`, once `wedge()` is called, settles only when it is closed. */
const wedgingLauncher = (): CdpLauncherLike & {
  readonly wedge: () => void;
  readonly closes: () => number;
} => {
  let wedged = false;
  let closes = 0;
  const blocked: ((thrown: unknown) => void)[] = [];
  const page: CdpPageLike = {
    url: () => 'https://shop.test/',
    goto: () => Promise.resolve(undefined),
    content: () => Promise.resolve(''),
    evaluate: () =>
      wedged
        ? new Promise((_resolve, reject) => {
            blocked.push(reject);
          })
        : Promise.resolve(undefined),
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    select: () => Promise.resolve([]),
    screenshot: () => Promise.resolve(new Uint8Array()),
    pdf: () => Promise.resolve(new Uint8Array()),
    setRequestInterception: () => Promise.resolve(),
    on: () => undefined,
    frames: () => [],
    close: () => Promise.resolve(),
  };
  const browser: CdpBrowserLike = {
    newPage: () => Promise.resolve(page),
    target: () => fakeBrowserTarget().target,
    setCookie: () => Promise.resolve(),
    close: () => {
      closes += 1;
      // What puppeteer does to every pending call when the socket closes. The `Error` is INPUT —
      // the library's own rejection — not this test's verdict.
      for (const reject of blocked.splice(0)) reject(new Error('Target closed'));
      return Promise.resolve();
    },
    process: () => null,
  };
  return {
    wedge: () => {
      wedged = true;
    },
    closes: () => closes,
    launch: () => Promise.resolve(browser),
    connect: () => Promise.resolve(browser),
  };
};

describe('unit · a hung evaluate on an attached browser ends at the fire', () => {
  test('rejects with X_SCRAPE_WEDGED at the idle budget, and the browser is closed once', async () => {
    const launcher = wedgingLauncher();
    const session = await remoteBrowser({ launcher, cdpUrl: 'ws://browser.test/1' }).open({
      name: 'orders',
      logger: structuredLogger({ writer: () => undefined }),
      rules: { allowHosts: ['shop.test'] },
      clock: testScrapeClock(),
      timeoutMs: 1_000,
      watchdog: { idleMs: 1_000, graceMs: 5_000 },
    });
    launcher.wedge();
    const code = await session.page
      .evaluate('document.title')
      .then(() => 'resolved')
      .catch((thrown: unknown) => (thrown as { code?: string }).code);
    // Not `X_SCRAPE_BROWSER_UNREACHABLE`: the closed socket is the fire's consequence, and the
    // run's error names its cause — `x errors explain` then says to raise `idleMs`.
    expect(code).toBe('X_SCRAPE_WEDGED');
    expect(launcher.closes()).toBe(1);
    // The run's own `close()` shares the fire's teardown rather than quitting twice.
    await session.close();
    expect(launcher.closes()).toBe(1);
  });
});
