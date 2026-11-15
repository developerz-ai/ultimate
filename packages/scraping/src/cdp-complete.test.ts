// The launcher check at session OPEN: a page or browser missing a verb the target forwards to is
// `X_SCRAPE_LAUNCHER_INCOMPLETE` naming every missing member, before any verb runs, and the
// browser the driver launched is closed — never `X_NOT_IMPLEMENTED` on the run that first called it.

import { describe, expect, test } from 'bun:test';
import { frozenClock, structuredLogger } from '@ultimat3/core';
import { completeSession } from './cdp-complete';
import { fakeCdpBrowser } from './cdp-fake-fixture';
import type { CdpBrowserLike, CdpLauncherLike, CdpPageLike } from './cdp-port';
import type { SessionInit } from './driver';
import { localBrowser } from './driver-cdp';

const init: SessionInit = {
  name: 'orders',
  logger: structuredLogger({ writer: () => undefined }),
  rules: { allowHosts: ['shop.test'] },
  clock: frozenClock(),
  timeoutMs: 1_000,
};

/** The complete fake with named members taken off its page and its browser. */
const launcherWithout = (
  pageless: readonly string[],
  browserless: readonly string[],
): CdpLauncherLike & { readonly closes: () => number } => {
  const fake = fakeCdpBrowser({ url: 'https://shop.test/', html: '<p>hi</p>' });
  let closes = 0;
  const strip = <T extends object>(owner: T, names: readonly string[]): T =>
    Object.fromEntries(Object.entries(owner).filter(([name]) => !names.includes(name))) as T;
  const browser: CdpBrowserLike = {
    ...strip(fake, browserless),
    newPage: async (): Promise<CdpPageLike> => strip(await fake.newPage(), pageless),
    target: () => fake.target(),
    close: () => {
      closes += 1;
      return Promise.resolve();
    },
  };
  return { closes: () => closes, launch: () => Promise.resolve(browser) };
};

const refusal = async (
  launcher: CdpLauncherLike,
): Promise<{ code?: string; cause?: string; retry?: string }> => {
  try {
    await localBrowser({ launcher }).open(init);
    return {};
  } catch (thrown) {
    return thrown as { code?: string; cause?: string; retry?: string };
  }
};

describe('unit · a launcher missing a verb is refused when the session opens', () => {
  test('every missing member is named, the code is terminal, and the browser is closed', async () => {
    const launcher = launcherWithout(['keyboard', 'setOfflineMode'], ['setCookie']);
    const thrown = await refusal(launcher);
    expect(thrown.code).toBe('X_SCRAPE_LAUNCHER_INCOMPLETE');
    expect(thrown.retry).toBe('terminal');
    expect(thrown.cause).toContain('page.keyboard, page.setOfflineMode(), browser.setCookie()');
    expect(launcher.closes()).toBe(1);
  });

  test.each(['focus', 'evaluateOnNewDocument', 'createCDPSession', 'emulateMediaFeatures'])(
    'a page with no %s is refused by name',
    async (member) => {
      expect((await refusal(launcherWithout([member], []))).cause).toContain(`page.${member}()`);
    },
  );

  test('a browser with no cookie jar is refused by name', async () => {
    expect((await refusal(launcherWithout([], ['cookies']))).cause).toContain('browser.cookies()');
  });

  test('a complete launcher opens', async () => {
    const session = await localBrowser({ launcher: launcherWithout([], []) }).open(init);
    await session.close();
    expect(session.driver).toBe('puppeteer');
  });

  test('a keyboard that is not an object is missing, not present', () => {
    const fake = fakeCdpBrowser({ url: 'https://shop.test/', html: '' });
    const page = { ...fake, keyboard: undefined } as unknown as CdpPageLike;
    expect(() => completeSession('puppeteer', fake, page)).toThrow(/page\.keyboard/);
  });
});
