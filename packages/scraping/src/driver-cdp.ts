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

import type { Logger } from '@ultimat3/core';
import type { MoneyValue } from '@ultimat3/schema';
import type { CdpBrowserLike, CdpLauncherLike } from './cdp-port';
import type { CdpResolver } from './cdp-resolver';
import { acquireCdp } from './cdp-resolver';
import { CDP_DRIVER, cdpTarget } from './cdp-target';
import type { ScrapeDriver, ScrapeSession, SessionInit } from './driver';
import { browserUnreachable, cdpAttachFailed, remoteRequired } from './error-throws';
import { egressUnsupported } from './error-throws-session';
import { isScrapeError } from './errors';
import type { ScrapeEventFields } from './events';
import { errorCode } from './failures';
import { httpOverFetch } from './http';
import { launchArgs } from './launch-args';
import { pageOverTarget } from './page-over-target';
import type { ScrapeTarget } from './target';
import { endpointLabel, hasCredentials, splitCredentials, urlSecretValues } from './url-secrets';
import { createWedgeGuard } from './watchdog';

export { CDP_DRIVER } from './cdp-target';

export interface BrowserOptions {
  /** `puppeteer` itself, or anything with the same two methods. */
  readonly launcher: CdpLauncherLike;
  /**
   * The exit every session of this driver dials when the run names none. A scrape's own
   * `egress(input)` — `SessionInit.proxy` — wins over it, per session.
   */
  readonly proxy?: string | undefined;
  /**
   * Extra launch/connect options, passed through — except `args`, which `localBrowser()` puts
   * BEFORE the exit's `--proxy-server` and screens for a second route (`launch-args.ts`).
   */
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
  /**
   * The `webSocketDebuggerUrl` from `/json/version` or a provider's connect URL — or a
   * `CdpResolver`, for a browser rented PER SESSION: called once per `open()`, told the run's
   * exit, and its `release()` runs exactly once when the session ends. A fixed URL is one browser
   * already bound to one exit, so a run asking for another is `X_SCRAPE_EGRESS_UNSUPPORTED`.
   */
  readonly cdpUrl: string | CdpResolver;
}

/** What one session was opened WITH, decided before the browser exists. */
interface SessionWiring {
  /** The exit both legs dial: the run's, else the driver's. */
  readonly proxy: string | undefined;
  /** True when THIS driver must answer the proxy's auth challenge — a launched browser only. */
  readonly authenticate: boolean;
  readonly release?: (() => Promise<void>) | undefined;
  readonly cost?: MoneyValue | undefined;
}

/**
 * The page, its interception and its restored session — or a closed browser and the failure.
 * A throw from here is classified before it leaves: `newPage()` and `setRequestInterception()` are
 * outside `cdpTarget`'s own `guard()`, so a bare library `Error` would otherwise reach the job's
 * retry classifier with no code at all.
 */
async function opened(
  browser: CdpBrowserLike,
  init: SessionInit,
  wiring: SessionWiring,
): Promise<ScrapeTarget> {
  try {
    const page = await browser.newPage();
    if (wiring.authenticate && wiring.proxy !== undefined) {
      // Before the first navigation, and through its owner: the challenge arrives with the first
      // request, and `--proxy-server` was deliberately handed the exit WITHOUT its userinfo.
      if (typeof page.authenticate !== 'function') {
        throw egressUnsupported({
          driver: CDP_DRIVER,
          egress: wiring.proxy,
          reason:
            'the exit carries credentials and this launcher has no page.authenticate() to answer the proxy with',
        });
      }
      const { username, password } = splitCredentials(wiring.proxy);
      await page.authenticate({ username, password });
    }
    const target = await cdpTarget({ page, browser, rules: init.rules, clock: init.clock });
    if (init.restore !== undefined) await target.restore(init.restore);
    return target;
  } catch (thrown) {
    // Best effort, and it may never replace the failure that caused it: a close that also throws
    // would hide the tab limit or the refused interception the reader actually needs.
    await browser.close().catch(() => undefined);
    throw isScrapeError(thrown) ? thrown : browserUnreachable(CDP_DRIVER, thrown);
  }
}

/**
 * The run's cancellation and the watchdog's, as ONE signal handed to every wait.
 *
 * The guard's abort half had no reader: both legs below were passed `init.signal`, so the
 * watchdog's only production effect was `kill()` — and `Browser.process()` answers `null` for a
 * browser obtained through `connect()`, which is `remoteBrowser()`, this file's primary path. A
 * wedge therefore killed nothing and aborted a signal nobody composed, and the blocked await on
 * the CDP socket stayed blocked past `ctx.signal` and past the watchdog. Verbatim incident #1 in
 * `watchdog.ts`, unfixed for the attach path until the composition below.
 */
const withWedgeSignal = (run: AbortSignal | undefined, guard: AbortSignal): AbortSignal =>
  run === undefined ? guard : AbortSignal.any([run, guard]);

async function sessionOver(
  browser: CdpBrowserLike,
  init: SessionInit,
  options: BrowserOptions,
  wiring: SessionWiring,
): Promise<ScrapeSession> {
  // Acquire, then roll back on ANY throw — the shape `releaseBoot` uses in `packages/cli/src/
  // serve.ts`. Between the launch and the `WedgeGuard` below, nothing else holds this browser:
  // `runScrape`'s `finally { session.close() }` never runs for a session `open()` did not return,
  // so a tab limit, a refused interception or a restore that threw left a real Chrome process —
  // or a remote session somebody is billing for — running per attempt, unattributed.
  const target = await opened(browser, init, wiring);
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
  const signal = withWedgeSignal(init.signal, guard.signal);
  return {
    driver: CDP_DRIVER,
    // The exit the browser was launched or attached with, handed back so the run's robots read
    // presents the SAME client identity to the origin the page loads from. `wiring.proxy` is what
    // the launch args and the HTTP leg below actually carry — the run's exit when it named one,
    // the driver's otherwise — and a reported exit that nothing dialled would be worse than none.
    ...(wiring.proxy === undefined ? {} : { proxy: wiring.proxy }),
    ...(wiring.cost === undefined ? {} : { browserCost: wiring.cost }),
    page: pageOverTarget(target, {
      clock: init.clock,
      allowHosts: init.rules.allowHosts,
      defaultTimeoutMs: init.timeoutMs,
      secrets: init.secrets,
      robots: init.robots,
      signal,
      onActivity,
      pace: init.pace,
      usage: init.usage,
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
      signal,
      onActivity,
      proxy: wiring.proxy,
      usage: init.usage,
      // The run's secrets, so the ONE thing this leg quotes from the site — the first 200 bytes
      // of a non-2xx body, in `X_SCRAPE_HTTP_FAILED`'s cause — cannot carry the password the
      // login endpoint echoed back. The bag was in scope here and unread.
      secrets: init.secrets,
    }),
    // Both halves, in order, and neither can throw: the browser is quit under its ceiling, THEN
    // the rental is handed back — a provider told "done" while the socket is still open bills the
    // tail to nobody. `release` is latched, so a second `close()` does nothing.
    close: async (): Promise<void> => {
      await guard.shutdown();
      await wiring.release?.();
    },
  };
}

/** The line a failed hand-back of a rented browser writes. Stable: alerts are keyed on it. */
const RELEASE_FAILED_EVENT = 'scrape.browser.release_failed';

/**
 * The resolver with its `release` WATCHED. `acquireCdp` swallows a rejected hand-back on purpose
 * — it runs on the way out of a run whose own outcome is the one the reader needs — and swallowed
 * silently, a browser its provider is still billing for left no line anywhere. The error's CODE
 * and the endpoint's scheme and host, nothing else: a provider's failure text quotes its connect
 * URL, and that URL is its access token. Rethrown, so `acquireCdp`'s contract is untouched.
 */
const watched =
  (resolver: CdpResolver, logger: Logger): CdpResolver =>
  async (request) => {
    const resolution = await resolver(request);
    if (resolution.release === undefined) return resolution;
    return {
      cdpUrl: resolution.cdpUrl,
      cost: resolution.cost,
      release: async (): Promise<void> => {
        try {
          await resolution.release?.();
        } catch (thrown) {
          const fields: ScrapeEventFields = {
            code: errorCode(thrown),
            driver: CDP_DRIVER,
            origin: endpointLabel(resolution.cdpUrl),
          };
          logger.warn(RELEASE_FAILED_EVENT, { ...fields });
          throw thrown;
        }
      },
    };
  };

/** The run's exit over the driver's, and its credential-bearing parts into the redaction set. */
function exitFor(init: SessionInit, options: BrowserOptions): string | undefined {
  const exit = init.proxy ?? options.proxy;
  if (exit !== undefined && hasCredentials(exit)) {
    for (const value of urlSecretValues(exit)) init.secrets?.conceal(value);
  }
  return exit;
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
      const proxy = exitFor(init, options);
      const authenticate = proxy !== undefined && hasCredentials(proxy);
      // The userinfo never reaches the argument list: Chrome ignores it there, and an argument is
      // readable by every process on the box. `opened()` answers the challenge instead.
      const proxyArg = proxy !== undefined && authenticate ? splitCredentials(proxy).bare : proxy;
      // The caller's args FIRST and the exit appended after them, never a spread that lets one
      // replace the other: `{ args: ['--no-sandbox'] }` — every container deploy's — used to
      // overwrite the proxy flag, and the browser dialled direct while the session reported the exit.
      const { args: callerArgs, ...passthrough } = options.options ?? {};
      const args = launchArgs(callerArgs, proxyArg);
      let browser: CdpBrowserLike;
      try {
        browser = await launch.call(options.launcher, {
          headless: options.headless ?? true,
          ...(options.executablePath === undefined
            ? {}
            : { executablePath: options.executablePath }),
          ...(options.profileDir === undefined ? {} : { userDataDir: options.profileDir }),
          ...passthrough,
          ...(args === undefined ? {} : { args }),
        });
      } catch (thrown) {
        throw browserUnreachable(CDP_DRIVER, thrown);
      }
      return sessionOver(browser, init, options, { proxy, authenticate });
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
      // Refused BEFORE anything is rented or attached. A fixed URL is a browser that already
      // exists on whatever exit it was started with; attaching and dialling the HTTP leg through
      // the run's exit would be one session presenting two client identities.
      if (
        typeof options.cdpUrl === 'string' &&
        init.proxy !== undefined &&
        init.proxy !== options.proxy
      ) {
        throw egressUnsupported({
          driver: CDP_DRIVER,
          egress: init.proxy,
          reason: `remoteBrowser({ cdpUrl }) was given a fixed URL, and the browser behind it is already bound to ${
            options.proxy === undefined ? 'a direct connection' : endpointLabel(options.proxy)
          }`,
        });
      }
      const proxy = exitFor(init, options);
      const source =
        typeof options.cdpUrl === 'string' ? options.cdpUrl : watched(options.cdpUrl, init.logger);
      const acquired = await acquireCdp(source, {
        scrape: init.name,
        runId: init.runId,
        egress: proxy,
        signal: init.signal,
      });
      // From here the rental exists, and `runScrape`'s `finally` cannot hand back a session
      // `open()` never returned — so every throw below releases it first. `sessionOver` rolls the
      // BROWSER back on its own; this is the half only the resolver knows how to end.
      try {
        if (acquired.cdpUrl === '') throw remoteRequired(CDP_DRIVER);
        // A provider's connect URL is its access token. Into the run's secret set before the
        // attach, so not even the failure artifact of a run that died here can carry it.
        for (const value of urlSecretValues(acquired.cdpUrl)) init.secrets?.conceal(value);
        let browser: CdpBrowserLike;
        try {
          browser = await connect.call(options.launcher, {
            browserWSEndpoint: acquired.cdpUrl,
            ...options.options,
          });
        } catch (thrown) {
          throw cdpAttachFailed(acquired.cdpUrl, thrown);
        }
        return await sessionOver(browser, init, options, {
          proxy,
          // The provider launched this browser; answering its proxy is the provider's.
          authenticate: false,
          release: acquired.release,
          cost: acquired.cost,
        });
      } catch (thrown) {
        await acquired.release();
        throw thrown;
      }
    },
  };
}
