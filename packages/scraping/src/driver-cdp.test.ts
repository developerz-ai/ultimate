// What happens to a real Chrome process when `open()` does not finish. Between the launch and the
// `WedgeGuard` that owns `quit`/`kill` there are three awaits that can throw, and until they were
// wrapped every one of them leaked a browser: `runScrape`'s `finally { session.close() }` cannot
// run for a session that was never returned, so the process — or a paid remote session — outlived
// the attempt with nobody holding a handle to it.

import { describe, expect, test } from 'bun:test';
import type { CdpBrowserLike, CdpLauncherLike, CdpPageLike } from './cdp-port';
import { testClock } from './clock';
import type { SessionInit } from './driver';
import { localBrowser, remoteBrowser } from './driver-cdp';

interface Broken {
  readonly newPage?: boolean;
  readonly intercept?: boolean;
  readonly setCookie?: boolean;
}

const brokenLauncher = (broken: Broken): CdpLauncherLike & { readonly closes: () => number } => {
  let closes = 0;
  const page: CdpPageLike = {
    url: () => 'about:blank',
    goto: () => Promise.resolve(undefined),
    content: () => Promise.resolve(''),
    evaluate: () => Promise.resolve(undefined),
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    select: () => Promise.resolve([]),
    screenshot: () => Promise.resolve(new Uint8Array()),
    pdf: () => Promise.resolve(new Uint8Array()),
    setRequestInterception: () =>
      broken.intercept === true ? Promise.reject(new Error('too many targets')) : Promise.resolve(),
    on: () => undefined,
    frames: () => [],
    close: () => Promise.resolve(),
  };
  const browser: CdpBrowserLike = {
    newPage: () =>
      broken.newPage === true ? Promise.reject(new Error('tab limit')) : Promise.resolve(page),
    setCookie: () =>
      broken.setCookie === true ? Promise.reject(new Error('bad cookie')) : Promise.resolve(),
    close: () => {
      closes += 1;
      return Promise.resolve();
    },
    process: () => null,
  };
  return {
    closes: () => closes,
    launch: () => Promise.resolve(browser),
    connect: () => Promise.resolve(browser),
  };
};

const init = (over: Partial<SessionInit> = {}): SessionInit => ({
  name: 'orders',
  rules: { allowHosts: ['shop.test'] },
  clock: testClock(),
  timeoutMs: 1_000,
  ...over,
});

const failedOpen = async (
  broken: Broken,
  over: Partial<SessionInit> = {},
): Promise<{ readonly code: string | undefined; readonly closes: number }> => {
  const launcher = brokenLauncher(broken);
  let code: string | undefined;
  try {
    await localBrowser({ launcher }).open(init(over));
  } catch (thrown) {
    code = (thrown as { code?: string }).code;
  }
  return { code, closes: launcher.closes() };
};

const RESTORE = {
  cookies: [
    { name: 'sid', value: 'x', domain: 'shop.test', path: '/', httpOnly: true, secure: true },
  ],
  headers: {},
  storage: {},
  userAgent: 'agent',
  origin: 'https://shop.test',
};

describe('unit · a browser that was launched is closed when open() cannot finish', () => {
  test('newPage() rejecting closes the browser rather than leaking it', async () => {
    expect(await failedOpen({ newPage: true })).toEqual({
      code: 'X_SCRAPE_BROWSER_UNREACHABLE',
      closes: 1,
    });
  });

  test('setRequestInterception() rejecting closes the browser', async () => {
    expect(await failedOpen({ intercept: true })).toEqual({
      code: 'X_SCRAPE_BROWSER_UNREACHABLE',
      closes: 1,
    });
  });

  test('a restore that throws closes the browser — the common case, and the one that retries', async () => {
    expect(await failedOpen({ setCookie: true }, { restore: RESTORE })).toEqual({
      code: 'X_SCRAPE_BROWSER_UNREACHABLE',
      closes: 1,
    });
  });

  test('the attached browser gets the same rollback — a remote session is somebody billing', async () => {
    const launcher = brokenLauncher({ newPage: true });
    let code: string | undefined;
    try {
      await remoteBrowser({ launcher, cdpUrl: 'ws://browser.test/1' }).open(init());
    } catch (thrown) {
      code = (thrown as { code?: string }).code;
    }
    expect(code).toBe('X_SCRAPE_BROWSER_UNREACHABLE');
    expect(launcher.closes()).toBe(1);
  });

  test('an open that SUCCEEDS closes nothing — the rollback is not a teardown', async () => {
    const launcher = brokenLauncher({});
    const session = await localBrowser({ launcher }).open(init());
    expect(launcher.closes()).toBe(0);
    await session.close();
    expect(launcher.closes()).toBe(1);
  });
});
