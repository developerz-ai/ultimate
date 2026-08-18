// The real browser driver: `localBrowser()` starts one in this container, `remoteBrowser()`
// ATTACHES to one somebody else started over a CDP URL.
//
// Attach is the PRIMARY production path, not an afterthought. Real deployments create a hardened
// browser elsewhere — a provider, a sidecar, a stealth build — and the app connects to it. Which
// is why `close()` here stops BOTH halves: the local connection and the remote session. A close
// that only disconnects leaves a browser somebody is billing for running until its provider times
// it out, and nobody attributes that bill to the run that caused it.
//
// The library is passed IN (`launcher`), never imported — see `cdp-port.ts` for why that seam is
// what keeps a puppeteer type out of the vocabulary and this package free of a dependency.

import type { CdpBrowserLike, CdpLauncherLike } from './cdp-port';
import { CDP_DRIVER, cdpTarget } from './cdp-target';
import type { ScrapeDriver, ScrapeSession, SessionInit } from './driver';
import { browserUnreachable, cdpAttachFailed, remoteRequired } from './error-throws';
import { httpOverFetch } from './http';
import { pageOverTarget } from './page-over-target';
import { createWedgeGuard } from './watchdog';

export { CDP_DRIVER } from './cdp-target';

export interface BrowserOptions {
  /** `puppeteer` itself, or anything with the same two methods. */
  readonly launcher: CdpLauncherLike;
  readonly proxy?: string | undefined;
  /** Extra launch/connect arguments, passed through untouched. */
  readonly options?: Record<string, unknown> | undefined;
  /** How long a graceful `close()` may take before the process is killed. */
  readonly graceMs?: number | undefined;
}

export interface LocalBrowserOptions extends BrowserOptions {
  readonly executablePath?: string | undefined;
  readonly headless?: boolean | undefined;
  /**
   * The user-data directory. Two runs sharing one is `X_SCRAPE_PROFILE_LOCKED`; a run that must
   * arrive as a NEW identity gets its own, which is what burning a session means on disk.
   */
  readonly profileDir?: string | undefined;
}

export interface RemoteBrowserOptions extends BrowserOptions {
  /** The `webSocketDebuggerUrl` from `/json/version`, or a provider's connect URL. */
  readonly cdpUrl: string;
}

async function sessionOver(
  browser: CdpBrowserLike,
  init: SessionInit,
  options: BrowserOptions,
): Promise<ScrapeSession> {
  const page = await browser.newPage();
  const target = await cdpTarget({
    page,
    browser,
    rules: init.rules,
    clock: init.clock,
  });
  if (init.restore !== undefined) await target.restore(init.restore);
  const guard = createWedgeGuard({
    clock: init.clock,
    what: `scrape "${init.name}"`,
    graceMs: init.watchdog?.graceMs ?? options.graceMs,
    idleMs: init.watchdog?.idleMs,
    // `close()` and NOT `disconnect()`, on BOTH drivers. Disconnecting ends the local half and
    // leaves the remote browser running until its provider times it out — a bill nobody
    // attributes to the run that caused it. An app that genuinely wants the remote session to
    // survive keeps its own handle and never hands it to a driver.
    quit: () => browser.close(),
    kill: () => {
      // The OS process, when there is one to reach. Killing it is what makes the socket a wedged
      // await is blocked on close, which is what turns an infinite wait into a catchable error.
      const child = browser.process?.();
      child?.kill(9);
    },
  });
  const onActivity = (): void => {
    guard.touch();
    init.onActivity?.();
  };
  return {
    driver: CDP_DRIVER,
    page: pageOverTarget(target, {
      clock: init.clock,
      allowHosts: init.rules.allowHosts,
      defaultTimeoutMs: init.timeoutMs,
      secrets: init.secrets,
      robots: init.robots,
      signal: init.signal,
      onActivity,
      pace: init.pace,
    }),
    http: httpOverFetch({
      rules: init.rules,
      clock: init.clock,
      timeoutMs: init.timeoutMs,
      network: target.network,
      // Straight through to the live browser: the HTTP leg must see the cookies a login two calls
      // ago produced, and a snapshot taken at open time would be the logged-out one forever.
      session: () => target.session(),
      robots: init.robots,
      pace: init.pace,
      signal: init.signal,
      onActivity,
      proxy: options.proxy,
    }),
    close: () => guard.shutdown(),
  };
}

/**
 * A browser in this container. `executablePath` is required by every puppeteer-core build — it
 * ships no browser — so it is passed through rather than guessed at.
 */
export function localBrowser(options: LocalBrowserOptions): ScrapeDriver {
  return {
    name: CDP_DRIVER,
    async open(init: SessionInit): Promise<ScrapeSession> {
      const launch = options.launcher.launch;
      if (launch === undefined) {
        throw remoteRequired('local browser: the launcher has no launch()');
      }
      let browser: CdpBrowserLike;
      try {
        browser = await launch.call(options.launcher, {
          headless: options.headless ?? true,
          ...(options.executablePath === undefined
            ? {}
            : { executablePath: options.executablePath }),
          ...(options.profileDir === undefined ? {} : { userDataDir: options.profileDir }),
          ...(options.proxy === undefined ? {} : { args: [`--proxy-server=${options.proxy}`] }),
          ...options.options,
        });
      } catch (thrown) {
        throw browserUnreachable(CDP_DRIVER, thrown);
      }
      return sessionOver(browser, init, options);
    },
  };
}

/** Attach to a browser somebody else started. The production path. */
export function remoteBrowser(options: RemoteBrowserOptions): ScrapeDriver {
  return {
    name: CDP_DRIVER,
    async open(init: SessionInit): Promise<ScrapeSession> {
      const connect = options.launcher.connect;
      if (connect === undefined || options.cdpUrl === '') {
        throw remoteRequired(CDP_DRIVER);
      }
      let browser: CdpBrowserLike;
      try {
        browser = await connect.call(options.launcher, {
          browserWSEndpoint: options.cdpUrl,
          ...options.options,
        });
      } catch (thrown) {
        throw cdpAttachFailed(options.cdpUrl, thrown);
      }
      return sessionOver(browser, init, options);
    },
  };
}
