// A CDP-shaped browser with no browser behind it — the seam `driver-parity.test.ts` needs to run
// the SAME suite against the real driver's code path without Chrome.
//
// It exists for one reason, and it is the reason `mock.module('puppeteer-core')` is banned in this
// package: `mock.module` replaces a module for the whole run, `bun test` does not fully serialise
// test files, and a mock installed here has been observed leaking into a concurrently-running
// file's assertions. An INJECTED launcher is a value; a value cannot leak.
//
// Precedent: `packages/storage/src/driver-s3-fixture.ts` ships the same way.

import type { CdpBrowserLike, CdpFrameLike, CdpLauncherLike, CdpPageLike } from './cdp-port';
import { queryHtml } from './html-query';
import type { ElementSnapshot, ScrapeCookie } from './target';

/** The selector inside `snapshotExpression()`'s `document.querySelectorAll("…")`. */
const selectorOf = (expression: string): string | undefined => {
  const match = /querySelectorAll\((".*?")\)/s.exec(expression);
  if (match?.[1] === undefined) return undefined;
  return JSON.parse(match[1]) as string;
};

export interface FakeCdpPageInit {
  readonly url: string;
  readonly html: string;
  /** Selectors a click navigates from, and where to. */
  readonly routes?: Readonly<Record<string, { readonly url: string; readonly html: string }>>;
  readonly cookies?: readonly ScrapeCookie[];
  readonly storage?: Readonly<Record<string, string>>;
  readonly userAgent?: string;
  /** Selectors whose element is covered at its centre — what only a layout engine can see. */
  readonly covered?: readonly string[];
}

type Handlers = Map<string, ((payload: unknown) => void)[]>;

export interface FakeCdpBrowser extends CdpBrowserLike {
  /** Fire a request event, as a real browser would when the page fetches a subresource. */
  emitRequest(url: string, resourceType: string): void;
  readonly aborted: readonly string[];
  readonly closed: boolean;
}

/** A layout box every element gets, so the CDP path exercises the fields the fake target lacks. */
const boxed = (snapshot: ElementSnapshot, covered: boolean): ElementSnapshot => ({
  ...snapshot,
  box: { x: 10, y: 10, width: 100, height: 20 },
  hitTarget: !covered,
});

export function fakeCdpBrowser(init: FakeCdpPageInit): FakeCdpBrowser {
  const handlers: Handlers = new Map();
  const aborted: string[] = [];
  let url = init.url;
  let html = init.html;
  let closed = false;
  const covered = new Set(init.covered ?? []);
  const storage: Record<string, string> = { ...init.storage };
  let cookies: readonly ScrapeCookie[] = init.cookies ?? [];

  const evaluate = async (expression: string): Promise<unknown> => {
    const selector = selectorOf(expression);
    if (selector !== undefined) {
      const found = await queryHtml(html, selector);
      return JSON.stringify(found.map((element) => boxed(element, covered.has(selector))));
    }
    if (expression.includes('localStorage')) {
      if (expression.includes('setItem')) return undefined;
      return JSON.stringify(storage);
    }
    if (expression.includes('navigator.userAgent')) return init.userAgent ?? 'fake-agent';
    return undefined;
  };

  const page: CdpPageLike = {
    url: () => url,
    goto: (next: string) => {
      url = next;
      return Promise.resolve(undefined);
    },
    content: () => Promise.resolve(html),
    evaluate,
    click: (selector: string) => {
      const route = init.routes?.[selector];
      if (route !== undefined) {
        url = route.url;
        html = route.html;
      }
      return Promise.resolve();
    },
    type: () => Promise.resolve(),
    select: () => Promise.resolve([]),
    screenshot: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    pdf: () => Promise.resolve(new Uint8Array([4, 5])),
    setRequestInterception: () => Promise.resolve(),
    on: (event: string, handler: (payload: unknown) => void) => {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
      return undefined;
    },
    frames: (): readonly CdpFrameLike[] => [],
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };

  return {
    newPage: () => Promise.resolve(page),
    cookies: () => Promise.resolve(cookies),
    setCookie: (...next: readonly unknown[]) => {
      cookies = next as readonly ScrapeCookie[];
      return Promise.resolve();
    },
    close: () => {
      closed = true;
      return Promise.resolve();
    },
    process: () => null,
    emitRequest(requestUrl: string, resourceType: string): void {
      for (const handler of handlers.get('request') ?? []) {
        handler({
          url: () => requestUrl,
          resourceType: () => resourceType,
          abort: () => {
            aborted.push(requestUrl);
            return Promise.resolve();
          },
          continue: () => Promise.resolve(),
        });
      }
    },
    aborted,
    get closed(): boolean {
      return closed;
    },
  };
}

/** A launcher over `fakeCdpBrowser`, for `localBrowser({ launcher })` in a test. */
export function fakeCdpLauncher(init: FakeCdpPageInit): CdpLauncherLike & {
  readonly browser: FakeCdpBrowser;
} {
  const browser = fakeCdpBrowser(init);
  return {
    browser,
    launch: () => Promise.resolve(browser),
    connect: () => Promise.resolve(browser),
  };
}
