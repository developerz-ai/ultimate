// What happens to a real Chrome process when `open()` does not finish. Between the launch and the
// `WedgeGuard` that owns `quit`/`kill` there are three awaits that can throw, and until they were
// wrapped every one of them leaked a browser: `runScrape`'s `finally { session.close() }` cannot
// run for a session that was never returned, so the process — or a paid remote session — outlived
// the attempt with nobody holding a handle to it.

import { describe, expect, test } from 'bun:test';
import { fakeCdpLauncher } from './cdp-fake';
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

describe('unit · the wedge watchdog reaches the waits — incident #1, on the attach path', () => {
  const wedgeInit = (over: Partial<SessionInit> = {}): SessionInit =>
    init({ watchdog: { idleMs: 1_000 }, ...over });

  /** Enough microtask turns for the guard's poll loop to cross `idleMs` on the test clock. */
  const untilWedged = async (): Promise<void> => {
    for (let tick = 0; tick < 40; tick += 1) await new Promise((r) => queueMicrotask(() => r(0)));
  };

  test('a wedge aborts a page wait — not X_SCRAPE_SELECTOR_MISSING minutes later', async () => {
    const launcher = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p>hi</p>' });
    // `remoteBrowser`, deliberately: `Browser.process()` is null for an attached browser, so the
    // guard's `kill()` is a no-op and the abort half is the ONLY thing that can end the wait.
    const session = await remoteBrowser({ launcher, cdpUrl: 'ws://browser.test/1' }).open(
      wedgeInit(),
    );
    await untilWedged();
    const code = await session.page
      .waitFor('.never-appears')
      .then(() => 'resolved')
      .catch((thrown: unknown) => (thrown as { code?: string }).code);
    expect(code).toBe('X_SCRAPE_WEDGED');
  });

  test('a wedge aborts the HTTP leg — the same guard, the second transport', async () => {
    const launcher = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p>hi</p>' });
    let handed: AbortSignal | undefined;
    const session = await remoteBrowser({ launcher, cdpUrl: 'ws://browser.test/1' }).open(
      // `pace` runs before the fetch, so what it is handed is what the request would carry — and
      // it refuses, which is what keeps this assertion off the network.
      wedgeInit({
        pace: (signal) => {
          handed = signal;
          return Promise.reject(new Error('paced: no request leaves this test'));
        },
      }),
    );
    await untilWedged();
    await session.http.request('https://shop.test/api/orders').catch(() => undefined);
    expect(handed?.aborted).toBe(true);
    expect((handed?.reason as { code?: string } | undefined)?.code).toBe('X_SCRAPE_WEDGED');
  });

  test("the run's own signal still aborts a wait — the guard is composed, never a swap", async () => {
    const launcher = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p>hi</p>' });
    const run = new AbortController();
    const session = await remoteBrowser({ launcher, cdpUrl: 'ws://browser.test/1' }).open(
      // A long wait budget, so the poll below reaches `clock.sleep(ms, signal)` rather than
      // expiring first — the watchdog's own poll advances this test clock while the wait runs.
      init({ watchdog: { idleMs: 600_000 }, timeoutMs: 600_000, signal: run.signal }),
    );
    run.abort(new Error('the job was cancelled'));
    const message = await session.page
      .waitFor('.never-appears')
      .then(() => 'resolved')
      .catch((thrown: unknown) => (thrown as { message?: string }).message);
    expect(message).toBe('the job was cancelled');
  });
});

describe('unit · the session reports the exit it dialled', () => {
  // The proxy is a DRIVER option, resolved after the robots gate the run hands to `open()` has
  // already been built — so the session has to say what it dialled, or the default `/robots.txt`
  // read exits from the worker's IP while every page load exits through the proxy, and an origin
  // reachable ONLY through the proxy reads as "no robots.txt", which the gate treats as
  // allow-everything.
  test('a launched browser hands its exit back on the session', async () => {
    const launcher = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p>hi</p>' });
    const session = await localBrowser({ launcher, proxy: 'http://exit:8080' }).open(init());
    expect(session.proxy).toBe('http://exit:8080');
    await session.close();
  });

  test('an attached browser does too — the HTTP leg already dialled through it', async () => {
    const launcher = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p>hi</p>' });
    const session = await remoteBrowser({
      launcher,
      cdpUrl: 'ws://browser.test/1',
      proxy: 'http://exit:9000',
    }).open(init());
    expect(session.proxy).toBe('http://exit:9000');
    await session.close();
  });

  test('a direct browser reports no exit at all, never an empty string', async () => {
    const launcher = fakeCdpLauncher({ url: 'https://shop.test/', html: '<p>hi</p>' });
    const session = await localBrowser({ launcher }).open(init());
    expect(session.proxy).toBeUndefined();
    await session.close();
  });
});
