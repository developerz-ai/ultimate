// One page printed to PDF over raw CDP: open a target, fence its requests to the route's origin,
// navigate, wait for the load event and the fonts, refuse an error page, `Page.printToPDF`. The
// browser is `cdp-launch.ts`'s — one launch per render, at most `maxConcurrent` alive, killed when
// the request is aborted, closed in a `finally` — and injectable, so `bun test` needs no Chrome.

import type { SleepClock } from '@ultimat3/core';
import { ambientClock, finiteCount, stringField } from '@ultimat3/core';
import type { CdpConnection } from './cdp-connection';
import { CdpCallFailedError, CdpTimeoutError } from './cdp-errors';
import type { FoundChromeOptions } from './cdp-launch';
import { LAUNCH_TIMEOUT_MS, launchFoundChrome } from './cdp-launch';
import { pdfRouteFailed } from './error-throws-pdf';
import { printToPdfParams } from './pdf-cdp-params';
import { raisePdfFence } from './pdf-fence';
import type { PdfLayout } from './pdf-request';
import { pdfSlots } from './pdf-slots';

/** One render's every deadline: the launch's first answer, each CDP call, the load event. */
export const DEFAULT_PDF_TIMEOUT_MS = 30_000;

/**
 * Sequential deadlines one render spends after the launch: create, attach, `Page.enable`, the two
 * header calls, the load, the settled read, the print, the close — and one spare.
 */
export const PDF_RENDER_DEADLINES = 10;

/** The launched browser's OS-level bound: a cold start, then every deadline a render spends. */
export const pdfBrowserLifetimeMs = (timeoutMs: number): number =>
  Math.max(timeoutMs, LAUNCH_TIMEOUT_MS) + PDF_RENDER_DEADLINES * timeoutMs;

/**
 * Live print browsers per renderer, by default. Each Chrome holds 150-300 MB; two keeps a burst of
 * prints (or a retry storm) from taking the web role's memory with it, and queues the rest.
 */
export const DEFAULT_PDF_MAX_CONCURRENT = 2;

/**
 * How a production render launches. The SANDBOX STAYS ON: a print renders the app's own pages, and
 * those carry user content — the sandbox is what stands between a renderer exploit and the web
 * role. The test launcher's `--no-sandbox` is for CI runners; the framework's runtime image is
 * distroless and ships no Chrome, so the app's own image supplies it and runs it as non-root, where
 * Chrome's namespace sandbox needs unprivileged user namespaces (or its setuid helper). A container
 * that cannot grant them fails the launch with `X_CDP_LAUNCH_FAILED` quoting Chrome's "No usable
 * sandbox"; that operator opts out in one visible line, `chromePdfRenderer({ sandbox: false })`.
 */
export const pdfLaunchOptions = (timeoutMs: number, sandbox = true): FoundChromeOptions => ({
  lifetimeMs: pdfBrowserLifetimeMs(timeoutMs),
  sandbox,
});

export interface PdfRenderRequest {
  /** Absolute. `pdf()` builds it from the app's own origin and a route path, never a caller's URL. */
  readonly url: string;
  readonly layout: PdfLayout;
  /**
   * Added to the requests the page makes to the ROUTE'S OWN ORIGIN — how a private route learns
   * who is printing it. Never sent anywhere else: every other origin is blocked (`pdf-fence.ts`).
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** The request's cancellation: aborted, a queued render leaves the queue, a running one its browser. */
  readonly signal?: AbortSignal | undefined;
}

/** The seam `pdf()` prints through. `chromePdfRenderer()` is the one this package ships. */
export interface PdfRenderer {
  render(request: PdfRenderRequest): Promise<Uint8Array>;
}

/** A browser one render owns: its connection, and the close that ends it. `LaunchedBrowser` fits. */
export interface PdfBrowser {
  readonly connection: CdpConnection;
  close(): Promise<void>;
}

export interface ChromePdfRendererOptions {
  /** Defaults to `launchFoundChrome` with `pdfLaunchOptions`: `CHROME_PATH`, then the known paths. */
  readonly launch?: (() => Promise<PdfBrowser>) | undefined;
  readonly timeoutMs?: number | undefined;
  /** Browsers alive at once. Default `DEFAULT_PDF_MAX_CONCURRENT`. */
  readonly maxConcurrent?: number | undefined;
  /** How long a render waits for a slot before `X_SCRAPE_PDF_BUSY`. Default `timeoutMs`. */
  readonly queueTimeoutMs?: number | undefined;
  /** What the queue waits on. Default `ambientClock()`, read per wait. */
  readonly clock?: SleepClock | undefined;
  /** Chrome's sandbox for the default launch — on unless the container cannot grant it. */
  readonly sandbox?: boolean | undefined;
}

/**
 * Read in the page once it loaded: the fonts settled (a PDF printed before a webfont arrives prints
 * the fallback face), then the document's own HTTP status — `0` where the browser cannot say.
 */
const SETTLED_STATUS = `(async () => {
  await document.fonts.ready;
  const entry = performance.getEntriesByType('navigation')[0];
  return entry && typeof entry.responseStatus === 'number' ? entry.responseStatus : 0;
})()`;

const required = (value: string | undefined, method: string, field: string): string => {
  if (value === undefined || value === '') {
    throw new CdpCallFailedError({ method, detail: `the browser answered no ${field}` });
  }
  return value;
};

/** Navigate and wait for `load` — the event, not the reply, which Chrome drops on a process swap. */
async function navigate(
  connection: CdpConnection,
  sessionId: string,
  url: string,
  timeoutMs: number,
): Promise<void> {
  const loaded = connection.once('Page.loadEventFired', sessionId, timeoutMs);
  const refused = connection.send('Page.navigate', { url }, sessionId).then(
    (answer) => {
      const failed = answer.result?.['errorText'];
      return typeof failed === 'string' && failed !== '' ? failed : undefined;
    },
    () => undefined,
  );
  const failed = await Promise.race([loaded.then(() => undefined), refused]);
  if (failed !== undefined) {
    throw new CdpCallFailedError({ method: `Page.navigate to ${url}`, detail: failed });
  }
  if (!(await loaded)) throw new CdpTimeoutError({ method: 'Page.loadEventFired', timeoutMs });
}

async function printOnce(
  connection: CdpConnection,
  request: PdfRenderRequest,
  timeoutMs: number,
): Promise<Uint8Array> {
  const created = await connection.send('Target.createTarget', { url: 'about:blank' });
  const targetId = required(
    stringField(created.result, 'targetId'),
    'Target.createTarget',
    'targetId',
  );
  try {
    const attached = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = required(
      stringField(attached.result, 'sessionId'),
      'Target.attachToTarget',
      'sessionId',
    );
    await connection.send('Page.enable', {}, sessionId);
    await raisePdfFence({
      connection,
      sessionId,
      origin: new URL(request.url).origin,
      headers: request.headers,
    });
    await navigate(connection, sessionId, request.url, timeoutMs);
    const settled = await connection.send(
      'Runtime.evaluate',
      { expression: SETTLED_STATUS, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    const inner = settled.result?.['result'];
    const status =
      typeof inner === 'object' && inner !== null && 'value' in inner ? inner.value : 0;
    if (typeof status === 'number' && status >= 400) throw pdfRouteFailed(request.url, status);
    const printed = await connection.send(
      'Page.printToPDF',
      printToPdfParams(request.layout),
      sessionId,
    );
    return Uint8Array.fromBase64(
      required(stringField(printed.result, 'data'), 'Page.printToPDF', 'data'),
    );
  } finally {
    await connection.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }
}

/** One render on a browser this call owns: killed the moment the request is aborted. */
async function renderOn(
  browser: PdfBrowser,
  request: PdfRenderRequest,
  timeoutMs: number,
): Promise<Uint8Array> {
  const { signal } = request;
  const kill = (): void => {
    void browser.close();
  };
  signal?.addEventListener('abort', kill, { once: true });
  try {
    signal?.throwIfAborted();
    return await printOnce(browser.connection, request, timeoutMs);
  } catch (error) {
    // A call cut off by the kill reports the dead socket; the reason the request was dropped is
    // the truth, and is what the caller's own catch expects.
    throw signal?.aborted === true ? signal.reason : error;
  } finally {
    signal?.removeEventListener('abort', kill);
    await browser.close();
  }
}

/**
 * Prints through a Chrome launched for the one render and closed after it, success or not: no
 * browser outlives a request, and nothing is shared between two tenants' documents. At most
 * `maxConcurrent` are alive; the rest queue, bounded. A launch costs a second or two; a pool is the
 * measured next step, not a guess (axiom 9).
 */
export function chromePdfRenderer(options: ChromePdfRendererOptions = {}): PdfRenderer {
  const timeoutMs = finiteCount(
    'chromePdfRenderer',
    'timeoutMs',
    options.timeoutMs ?? DEFAULT_PDF_TIMEOUT_MS,
    1,
  );
  const slots = pdfSlots({
    maxConcurrent: finiteCount(
      'chromePdfRenderer',
      'maxConcurrent',
      options.maxConcurrent ?? DEFAULT_PDF_MAX_CONCURRENT,
      1,
    ),
    queueTimeoutMs: finiteCount(
      'chromePdfRenderer',
      'queueTimeoutMs',
      options.queueTimeoutMs ?? timeoutMs,
      0,
    ),
    clock: () => options.clock ?? ambientClock(),
  });
  const launch =
    options.launch ??
    (() => launchFoundChrome(process.env, timeoutMs, pdfLaunchOptions(timeoutMs, options.sandbox)));
  return {
    async render(request) {
      const release = await slots.acquire(request.signal);
      try {
        return await renderOn(await launch(), request, timeoutMs);
      } finally {
        release();
      }
    },
  };
}
