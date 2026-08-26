// `PageLike` over a browser page. The adapter itself: `@ultimat3/testing` declares the surface an
// e2e test drives and `@ultimat3/scraping` owns the only driver that can drive one, and neither
// may import the other — so the join is here, in the one package allowed to know about both.

import { finiteCount } from '@ultimat3/core';
import type { LocatorLike, PageLike } from '@ultimat3/testing';
import { E2eServiceWorkerAbsentError } from './e2e-errors';
import { evaluateClosure } from './e2e-evaluate';
import { e2eLocator } from './e2e-locator';
import type { E2eSelection } from './e2e-selection';

/**
 * What this adapter needs of a browser: four members, every one of them on `ScrapePage`. Declared
 * structurally rather than as `ScrapePage` so a test can stand one up in six lines — the same
 * bargain `cdp-port.ts` makes about puppeteer, one layer up.
 */
export interface E2eBrowserPage {
  url(): string;
  goto(url: string, options?: { readonly timeout?: number | undefined }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  click(selector: string): Promise<void>;
}

export interface E2ePageOptions {
  readonly page: E2eBrowserPage;
  /** Every `goto('/feed')` in an e2e suite is app-relative; this is what makes one absolute. */
  readonly baseUrl: string;
  /** Per-navigation deadline, handed to the driver rather than enforced here. */
  readonly timeoutMs?: number | undefined;
  /** How long `waitForServiceWorker()` waits before refusing. Bounded IN THE PAGE. */
  readonly serviceWorkerTimeoutMs?: number | undefined;
}

/** Named once, so both refusals below name the call an app's test preload actually makes. */
const SUBJECT = 'installE2eDriver';

export const DEFAULT_E2E_TIMEOUT_MS = 30_000;
export const DEFAULT_SERVICE_WORKER_TIMEOUT_MS = 10_000;

/** Every in-page expression here answers JSON text, for the reason `cdp-snapshot.ts` states. */
const readField = (raw: unknown, key: string): unknown => {
  const decoded = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  return typeof decoded === 'object' && decoded !== null
    ? (decoded as Record<string, unknown>)[key]
    : undefined;
};

const TITLE = '(() => JSON.stringify({ title: document.title }))()';

/**
 * The first flush, read by a `fetch` INSIDE the page after the navigation, because neither
 * `ScrapePage` nor `CdpPageLike` exposes a response body — puppeteer's `page.on('response')` is
 * not on the port and adding it would be an edit to `@ultimat3/scraping`.
 *
 * The cost, stated rather than hidden: this is a SECOND request to the same route, so what it
 * measures is that route's streaming behaviour and not the byte-for-byte first chunk the open
 * document received. It runs in the page, so it carries the page's cookies and its origin — a
 * `fetch` from the test process would carry neither.
 */
const firstFlushExpression = (url: string): string =>
  `(() => fetch(${JSON.stringify(url)}, { credentials: 'same-origin' })
    .then((response) => response.body.getReader().read())
    .then((chunk) => JSON.stringify({ html: new TextDecoder().decode(chunk.value || new Uint8Array()) })))()`;

/**
 * `ready` alone is not control: a first load activates a worker that is not yet the page's
 * controller, and an offline assertion made in that window tests nothing. So this waits for
 * `controllerchange` too — an EVENT, not a poll, so the harness still has exactly one retry loop.
 */
const serviceWorkerExpression = (timeoutMs: number): string =>
  `(() => {
  if (!navigator.serviceWorker) return JSON.stringify({ controlled: false });
  const controlled = new Promise((resolve) => {
    if (navigator.serviceWorker.controller) { resolve(true); return; }
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), { once: true });
  });
  const deadline = new Promise((resolve) => setTimeout(() => resolve(false), ${String(timeoutMs)}));
  return Promise.race([navigator.serviceWorker.ready.then(() => controlled), deadline])
    .catch(() => false)
    .then((ok) => JSON.stringify({ controlled: ok === true }));
})()`;

/**
 * The adapter. Every member re-reads the live page: a `PageLike` handed to a test outlives every
 * navigation the test makes, so nothing here may capture a URL, a document or an element.
 */
export function e2ePage(options: E2ePageOptions): PageLike {
  const page = options.page;
  // Both are screened HERE, at construction, and not where they land: `timeout` is handed to a
  // driver that reads it as a deadline, and `swTimeout` is INTERPOLATED into the in-page source,
  // where `setTimeout(fn, NaN)` is `setTimeout(fn, 0)` — so a NaN budget makes every
  // `waitForServiceWorker()` refuse a worker that really did take control. A misdiagnosis reported
  // as a test failure is worse than the failure. Floor 0, because a driver reads `timeout: 0` as
  // "no deadline" and that is a value an app is entitled to declare.
  const timeout = finiteCount(SUBJECT, 'timeoutMs', options.timeoutMs ?? DEFAULT_E2E_TIMEOUT_MS);
  const swTimeout = finiteCount(
    SUBJECT,
    'serviceWorkerTimeoutMs',
    options.serviceWorkerTimeoutMs ?? DEFAULT_SERVICE_WORKER_TIMEOUT_MS,
  );
  const absolute = (url: string): string => new URL(url, options.baseUrl).toString();
  const locate = (selection: E2eSelection): LocatorLike => e2eLocator(page, selection);

  return {
    url: () => page.url(),
    goto: (url) => page.goto(absolute(url), { timeout }),
    // The page's OWN url, re-read at call time: a reload of the url the adapter was built with
    // would navigate away from wherever the test had got to.
    reload: () => page.goto(page.url(), { timeout }),
    title: async () => {
      const title = readField(await page.evaluate(TITLE), 'title');
      return typeof title === 'string' ? title : '';
    },
    gotoStreamed: async (url) => {
      const target = absolute(url);
      await page.goto(target, { timeout });
      const html = readField(await page.evaluate(firstFlushExpression(target)), 'html');
      return { html: typeof html === 'string' ? html : '' };
    },
    waitForServiceWorker: async () => {
      const raw = await page.evaluate(serviceWorkerExpression(swTimeout));
      if (readField(raw, 'controlled') !== true) {
        throw new E2eServiceWorkerAbsentError({ url: page.url(), timeoutMs: swTimeout });
      }
    },
    evaluate: <T>(fn: () => T): Promise<T> => evaluateClosure(page, fn) as unknown as Promise<T>,
    locator: (selector) => locate({ kind: 'css', selector, first: false }),
    getByRole: (role, roleOptions) =>
      locate({
        kind: 'role',
        role,
        first: false,
        ...(roleOptions?.name === undefined ? {} : { name: roleOptions.name }),
        ...(roleOptions?.level === undefined ? {} : { level: roleOptions.level }),
      }),
    getByText: (text) => locate({ kind: 'text', text, first: false }),
  };
}
