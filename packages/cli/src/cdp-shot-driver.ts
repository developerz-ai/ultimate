// `x shot`'s browser, over raw CDP and with no library: launch Chrome here on its debugging pipe
// (`@ultimat3/testing`'s launcher, the one the e2e step already runs on) or ATTACH to one somebody
// else runs over `--cdp-url`. One `open()` is one browser and one page, so a picture's console and
// network are its own. The page is `cdp-shot-page.ts`; this file is the session around it.

import { renderThrowable } from '@ultimat3/core';
import type { CdpConnection, LaunchedBrowser } from '@ultimat3/scraping/cdp';
import {
  CdpBrowserMissingError,
  CdpCallFailedError,
  CHROME_CANDIDATES,
  cdpConnect,
  launchChrome,
} from '@ultimat3/scraping/cdp';
import type { ShotDriver, ShotSession, ShotSessionInit } from './browser-launcher-port';
import { type DialScreen, screenedConnection } from './cdp-shot-driver-screen';
import { cdpShotPage } from './cdp-shot-page';
import { watchPage } from './cdp-shot-watch';

export const CDP_SHOT_DRIVER = 'cdp';

/** What a picture is laid out in when nothing declares a size — the size every earlier shot had. */
export const DEFAULT_SHOT_VIEWPORT = Object.freeze({ width: 800, height: 600 });

export interface CdpShotDriverOptions {
  /** Launch this binary here. Ignored when `cdpUrl` is set. */
  readonly executablePath?: string | undefined;
  /** Attach here: a provider's `wss://` session, or a sidecar's `http://host:9222`. */
  readonly cdpUrl?: string | undefined;
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
  /**
   * The DNS half of the session's interception (`cdp-shot-driver-screen.ts`): every paused request
   * on the page AND the browser session is screened by it before the host allow list decides.
   * `x design research` sets it, because its allow list is every PUBLIC host.
   */
  readonly dialScreen?: Omit<DialScreen, 'owns'> | undefined;
  /** Test seams: the two ways a connection comes to exist, so no test needs a browser. */
  readonly launch?:
    | ((executable: string, timeoutMs: number) => Promise<LaunchedBrowser>)
    | undefined;
  readonly connect?: ((endpoint: string, timeoutMs: number) => Promise<CdpConnection>) | undefined;
  readonly fetchJson?: ((url: string, timeoutMs: number) => Promise<unknown>) | undefined;
}

const field = (value: unknown, key: string): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : undefined;
};

/**
 * A sidecar publishes `http://host:9222`, and the socket is what `/json/version` names. A provider
 * hands out the socket itself. Either way the answer is one `ws:`/`wss:` url.
 */
async function socketUrl(
  cdpUrl: string,
  timeoutMs: number,
  fetchJson: (url: string, timeoutMs: number) => Promise<unknown>,
): Promise<string> {
  if (cdpUrl.startsWith('ws://') || cdpUrl.startsWith('wss://')) return cdpUrl;
  const version = new URL('/json/version', cdpUrl).toString();
  const socket = field(await fetchJson(version, timeoutMs), 'webSocketDebuggerUrl');
  if (socket === undefined) {
    throw new CdpCallFailedError({
      method: `GET ${version}`,
      detail: 'the endpoint answered no webSocketDebuggerUrl',
    });
  }
  return socket;
}

/**
 * Under the session's own deadline: a sidecar that accepts the socket and never answers held
 * `x shot` for as long as it liked, because nothing else bounds this one request.
 */
const defaultFetchJson = async (url: string, timeoutMs: number): Promise<unknown> => {
  try {
    return await (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).json();
  } catch (error) {
    throw new CdpCallFailedError({ method: `GET ${url}`, detail: renderThrowable(error) });
  }
};

export function cdpShotDriver(options: CdpShotDriverOptions): ShotDriver {
  const viewport = options.viewport ?? DEFAULT_SHOT_VIEWPORT;
  const launch =
    options.launch ??
    ((executable: string, timeoutMs: number) => launchChrome({ executable, timeoutMs }));
  const connect =
    options.connect ??
    ((endpoint: string, timeoutMs: number) => cdpConnect({ endpoint, timeoutMs }));

  /** The browser half of a session: its connection, and how to end it. */
  const browser = async (
    timeoutMs: number,
  ): Promise<{ connection: CdpConnection; end: () => Promise<void> }> => {
    if (options.cdpUrl !== undefined) {
      const endpoint = await socketUrl(
        options.cdpUrl,
        timeoutMs,
        options.fetchJson ?? defaultFetchJson,
      );
      const connection = await connect(endpoint, timeoutMs);
      return {
        connection,
        // BOTH halves: a remote browser is somebody else's bill, and a close that only hung up
        // would leave it running until the provider timed it out.
        end: async () => {
          await connection.send('Browser.close').catch(() => undefined);
          connection.close();
        },
      };
    }
    if (options.executablePath === undefined) {
      throw new CdpBrowserMissingError({ tried: CHROME_CANDIDATES });
    }
    const launched = await launch(options.executablePath, timeoutMs);
    // Awaited by `close` below: `x shot` exits right after its last picture, and a reap still
    // running then is a Chrome child left behind and a profile directory it re-creates.
    return { connection: launched.connection, end: () => launched.close() };
  };

  return {
    name: CDP_SHOT_DRIVER,
    async open(init: ShotSessionInit): Promise<ShotSession> {
      const { connection, end } = await browser(init.timeoutMs);
      let closed = false;
      let stopWatch: () => void = () => undefined;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        stopWatch();
        await end().catch(() => undefined);
      };
      try {
        const created = await connection.send('Target.createTarget', { url: 'about:blank' });
        const targetId = field(created.result, 'targetId');
        const attached = await connection.send('Target.attachToTarget', {
          targetId,
          flatten: true,
        });
        const sessionId = field(attached.result, 'sessionId');
        if (targetId === undefined || sessionId === undefined) {
          throw new CdpCallFailedError({
            method: 'Target.attachToTarget',
            detail: 'the browser opened a page and answered no target or session id',
          });
        }
        // The BROWSER's own session, for the allow list on every target the page opens — a popup
        // is a new target the page session's `Fetch` never pauses. A browser that refuses the
        // attach refuses the session: a rule that would hold on one tab only is not a rule.
        const browserAttached = await connection.send('Target.attachToBrowserTarget');
        const browserSessionId = field(browserAttached.result, 'sessionId');
        if (browserSessionId === undefined) {
          throw new CdpCallFailedError({
            method: 'Target.attachToBrowserTarget',
            detail: 'the browser answered no session id, so a popup could not be screened',
          });
        }
        // Watching BEFORE the domains are on, so the first request is already counted.
        const dialScreen = options.dialScreen;
        const watch = watchPage({
          connection:
            dialScreen === undefined
              ? connection
              : screenedConnection(connection, {
                  ...dialScreen,
                  owns: (on) => on === sessionId || on === browserSessionId,
                }),
          sessionId,
          browserSessionId,
          clock: init.clock,
          allowHosts: init.rules.allowHosts,
        });
        stopWatch = () => watch.stop();
        const on = (method: string, params: Record<string, unknown> = {}) =>
          connection.send(method, params, sessionId);
        await on('Runtime.enable');
        await on('Page.enable');
        await on('Network.enable');
        await on('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
        await connection.send(
          'Fetch.enable',
          { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
          browserSessionId,
        );
        // Before the first navigation, like the metrics below: a header set after `goto` would
        // photograph a document negotiated in the machine's own language.
        if (init.headers !== undefined && Object.keys(init.headers).length > 0) {
          await on('Network.setExtraHTTPHeaders', { headers: init.headers });
        }
        // `Network.setCookie` needs the Network domain on and precedes `goto` for the header's
        // reason: a consent banner decided after the first paint is a picture of the banner.
        for (const cookie of init.cookies ?? []) {
          await on('Network.setCookie', {
            name: cookie.name,
            value: cookie.value,
            url: cookie.url,
          });
        }
        const size = init.viewport ?? viewport;
        await on('Emulation.setDeviceMetricsOverride', {
          width: size.width,
          height: size.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        // A classic scrollbar takes ~15px of the layout, so a page "at 1440" was laid out at 1425 and
        // a full-page capture came back 1425 wide. Hidden, the page is laid out at the width asked
        // for, which is what a phone's overlay scrollbar and the reviewer's expectation both are.
        await on('Emulation.setScrollbarsHidden', { hidden: true });
        return { page: cdpShotPage({ connection, sessionId, init, watch, viewport: size }), close };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
