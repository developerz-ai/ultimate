// `x shot`'s browser, over raw CDP and with no library: launch Chrome here on its debugging pipe
// (`@ultimat3/testing`'s launcher, the one the e2e step already runs on) or ATTACH to one somebody
// else runs over `--cdp-url`. One `open()` is one browser and one page, so a picture's console and
// network are its own. The page is `cdp-shot-page.ts`; this file is the session around it.
import type { CdpConnection, LaunchedBrowser } from '@ultimat3/testing';
import {
  CdpBrowserMissingError,
  CdpCallFailedError,
  CHROME_CANDIDATES,
  cdpConnect,
  launchChrome,
} from '@ultimat3/testing';
import type { ShotDriver, ShotSession, ShotSessionInit } from './browser-launcher-port';
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
  /** Test seams: the two ways a connection comes to exist, so no test needs a browser. */
  readonly launch?:
    | ((executable: string, timeoutMs: number) => Promise<LaunchedBrowser>)
    | undefined;
  readonly connect?: ((endpoint: string, timeoutMs: number) => Promise<CdpConnection>) | undefined;
  readonly fetchJson?: ((url: string) => Promise<unknown>) | undefined;
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
  fetchJson: (url: string) => Promise<unknown>,
): Promise<string> {
  if (cdpUrl.startsWith('ws://') || cdpUrl.startsWith('wss://')) return cdpUrl;
  const version = new URL('/json/version', cdpUrl).toString();
  const socket = field(await fetchJson(version), 'webSocketDebuggerUrl');
  if (socket === undefined) {
    throw new CdpCallFailedError({
      method: `GET ${version}`,
      detail: 'the endpoint answered no webSocketDebuggerUrl',
    });
  }
  return socket;
}

const defaultFetchJson = async (url: string): Promise<unknown> => (await fetch(url)).json();

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
      const endpoint = await socketUrl(options.cdpUrl, options.fetchJson ?? defaultFetchJson);
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
    return { connection: launched.connection, end: async () => launched.close() };
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
        // Watching BEFORE the domains are on, so the first request is already counted.
        const watch = watchPage({
          connection,
          sessionId,
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
        await on('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        return { page: cdpShotPage({ connection, sessionId, init, watch }), close };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
