// The one small site every `ScrapeDriver` check reads: pages, an iframe'd login whose frame
// carries the SAME ids as its parent (the only shape in which a frame verb aimed at the parent is
// visible), and one JSON endpoint behind them. A subject's driver must serve exactly these — an
// offline driver from recordings of them, a real browser from a server answering them.

import type { Logger } from '@ultimat3/core';
import { frozenClock, structuredLogger } from '@ultimat3/core';
import type { HttpRecording, PageRecording, ScrapeDriver, ScrapeSession } from '@ultimat3/scraping';

export const SCRAPE_CONFORMANCE_HOST = 'shop.test';
const ORIGIN = `https://${SCRAPE_CONFORMANCE_HOST}`;

export const SCRAPE_CONFORMANCE_URLS = {
  orders: `${ORIGIN}/orders`,
  second: `${ORIGIN}/orders/2`,
  login: `${ORIGIN}/login`,
  search: `${ORIGIN}/search`,
  api: `${ORIGIN}/api/orders?page=1`,
} as const;

const ORDERS = `<html><body>
  <h1 id="title">Orders</h1>
  <ul><li class="row" data-id="1">One</li><li class="row" data-id="2">Two</li></ul>
  <a id="next" href="/orders/2">Next</a>
  <a class="go" href="/orders/2">Go first</a>
  <a class="go" href="/orders/nowhere">Go second</a>
  <button id="pay" disabled>Pay</button>
  <p id="hidden" style="display:none">gone</p>
  <img src="https://tracker.test/pixel.gif">
</body></html>`;

const LOGIN = `<html><body>
  <input id="q" name="q" value="page-value">
  <select id="s"><option value="p1">P1</option></select>
  <a id="go" href="/orders/2">Leave</a>
  <iframe name="idp" src="/idp"></iframe>
</body></html>`;

/** `#go` here does NOT navigate: a frame click resolved against the parent moves the whole page. */
const IDP =
  '<input id="q" name="q" value="frame-value"><select id="s"><option value="f1">F1</option></select><button id="go">Stay</button>';

const SEARCH = `<html><body>
  <input id="q" name="q" placeholder="Search">
  <button id="go" aria-label="Run search">Go</button>
</body></html>`;

export const SCRAPE_CONFORMANCE_PAGES: readonly PageRecording[] = [
  { url: SCRAPE_CONFORMANCE_URLS.orders, html: ORDERS },
  {
    url: SCRAPE_CONFORMANCE_URLS.second,
    html: '<html><body><h1 id="title">Page two</h1></body></html>',
  },
  { url: SCRAPE_CONFORMANCE_URLS.login, html: LOGIN, frames: { idp: IDP } },
  { url: SCRAPE_CONFORMANCE_URLS.search, html: SEARCH },
];

export const SCRAPE_CONFORMANCE_HTTP: readonly HttpRecording[] = [
  { url: SCRAPE_CONFORMANCE_URLS.api, method: 'GET', status: 200, body: '{"orders":[{"id":1}]}' },
];

const silent: Logger = structuredLogger({ writer: () => undefined });

/** A session on `driver` the way a scrape opens one: this site allowed, images blocked. */
export const openOn = (driver: ScrapeDriver): Promise<ScrapeSession> =>
  driver.open({
    name: 'conformance',
    logger: silent,
    rules: { allowHosts: [SCRAPE_CONFORMANCE_HOST], block: ['image'] },
    clock: frozenClock(),
    timeoutMs: 5_000,
  });

/** The code a call failed with, or `undefined` when it answered. */
export async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (thrown) {
    const code: unknown =
      typeof thrown === 'object' && thrown !== null ? Reflect.get(thrown, 'code') : undefined;
    return typeof code === 'string' ? code : `uncoded: ${String(thrown)}`;
  }
}
