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
import { COLOR_SCHEME_FEATURE } from './color-scheme';
import { queryHtml } from './html-query';
import type { ElementSnapshot, ScrapeCookie } from './target';

/** The selector inside `snapshotExpression()`'s `document.querySelectorAll("…")`. */
const selectorOf = (expression: string): string | undefined => {
  const match = /querySelectorAll\((".*?")\)/s.exec(expression);
  if (match?.[1] === undefined) return undefined;
  return JSON.parse(match[1]) as string;
};

/**
 * The selector inside `clearExpression()`'s `document.querySelector("…")`, READ rather than
 * imported. A clear is the one verb this port has no method for — it travels as an expression — so
 * a fake that recognised it by identity could not tell the page's document from a frame's, which
 * is precisely the divergence `driver-parity-frames.test.ts` needs it to expose.
 */
const clearedSelectorOf = (expression: string): string | undefined => {
  if (!expression.includes(".value = ''")) return undefined;
  const match = /querySelector\((".*?")\)/s.exec(expression);
  if (match?.[1] === undefined) return undefined;
  return JSON.parse(match[1]) as string;
};

export interface FakeCdpFrameInit {
  readonly url: string;
  readonly html: string;
}

export interface FakeCdpPageInit {
  readonly url: string;
  readonly html: string;
  /** Selectors a click navigates from, and where to. */
  readonly routes?: Readonly<Record<string, { readonly url: string; readonly html: string }>>;
  /**
   * Child frames by NAME, each its own document. A frame with its own markup is what makes a
   * frame verb aimed at the parent document visible — with `frames(): []` the whole frame half of
   * `cdp-target.ts` was unreachable from every test in the package.
   */
  readonly frames?: Readonly<Record<string, FakeCdpFrameInit>>;
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
  /**
   * Fire `pageerror` — the page threw and nothing caught it. `payload` is whatever the library
   * would hand a handler, `unknown` on purpose: a page can throw a string as easily as an `Error`,
   * and the target reads it defensively either way.
   */
  emitPageError(payload: unknown): void;
  readonly aborted: readonly string[];
  readonly closed: boolean;
  /** What `page.setOfflineMode()` last set, so a test asserts on the CONDITION, not on a call. */
  readonly offline: boolean;
  /**
   * What `page.emulateMediaFeatures()` last set `prefers-color-scheme` to, for `offline`'s reason
   * — the condition the page is now in, never the fact that a method was called. `null` until
   * something sets one, which is the launcher's own default and not a value this fake invents.
   */
  readonly colorScheme: string | null;
}

/** A layout box every element gets, so the CDP path exercises the fields the fake target lacks. */
const boxed = (snapshot: ElementSnapshot, covered: boolean): ElementSnapshot => ({
  ...snapshot,
  box: { x: 10, y: 10, width: 100, height: 20 },
  hitTarget: !covered,
});

/**
 * ONE document — the page's, or a frame's. A browser gives every browsing context its own DOM, so
 * the fake gives every one its own typed values: a verb that reaches the wrong document then shows
 * up as text in the wrong place rather than as nothing at all.
 */
interface FakeDocument {
  html(): string;
  /** Typed text, keyed the way `keyOf` keys it offline: `#id` when there is one, else the selector. */
  readonly typed: Map<string, string>;
}

const keyFor = (selector: string, element: ElementSnapshot | undefined): string => {
  const id = element?.attrs['id'];
  return id === undefined ? selector : `#${id}`;
};

/** What the DOM would answer after a `type()`: the element, carrying whatever was typed into it. */
const withTyped = (
  document: FakeDocument,
  selector: string,
  elements: readonly ElementSnapshot[],
): readonly ElementSnapshot[] =>
  elements.map((element) => {
    const typed = document.typed.get(keyFor(selector, element));
    return typed === undefined ? element : { ...element, value: typed };
  });

export function fakeCdpBrowser(init: FakeCdpPageInit): FakeCdpBrowser {
  const handlers: Handlers = new Map();
  const aborted: string[] = [];
  let url = init.url;
  let html = init.html;
  let closed = false;
  let offline = false;
  let colorScheme: string | null = null;
  const covered = new Set(init.covered ?? []);
  const storage: Record<string, string> = { ...init.storage };
  let cookies: readonly ScrapeCookie[] = init.cookies ?? [];

  const documentOf = (read: () => string): FakeDocument => ({ html: read, typed: new Map() });
  const pageDocument = documentOf(() => html);

  /** Every expression this package sends, answered against the document it was sent to. */
  const evaluateIn = async (target: FakeDocument, expression: string): Promise<unknown> => {
    const selector = selectorOf(expression);
    if (selector !== undefined) {
      const found = withTyped(target, selector, await queryHtml(target.html(), selector));
      return JSON.stringify(found.map((element) => boxed(element, covered.has(selector))));
    }
    const cleared = clearedSelectorOf(expression);
    if (cleared !== undefined) {
      const [first] = await queryHtml(target.html(), cleared);
      target.typed.set(keyFor(cleared, first), '');
      return undefined;
    }
    return undefined;
  };

  const typeIn = async (target: FakeDocument, selector: string, text: string): Promise<void> => {
    const [first] = await queryHtml(target.html(), selector);
    const key = keyFor(selector, first);
    target.typed.set(key, `${target.typed.get(key) ?? first?.value ?? ''}${text}`);
  };

  const selectIn = async (target: FakeDocument, selector: string, value: string): Promise<void> => {
    const [first] = await queryHtml(target.html(), selector);
    target.typed.set(keyFor(selector, first), value);
  };

  const frames: readonly CdpFrameLike[] = Object.entries(init.frames ?? {}).map(([name, frame]) => {
    const frameDocument = documentOf(() => frame.html);
    return {
      name: () => name,
      url: () => frame.url,
      content: () => Promise.resolve(frame.html),
      evaluate: (expression: string) => evaluateIn(frameDocument, expression),
      click: () => Promise.resolve(),
      type: (selector: string, text: string) => typeIn(frameDocument, selector, text),
      select: async (selector: string, ...values: string[]): Promise<string[]> => {
        await selectIn(frameDocument, selector, values[0] ?? '');
        return [...values];
      },
    };
  });

  const page: CdpPageLike = {
    url: () => url,
    goto: (next: string) => {
      url = next;
      // A navigation is a new document, so what was typed into the old one is gone. Keeping it
      // would let a stale value answer a query on a page that never had it.
      pageDocument.typed.clear();
      return Promise.resolve(undefined);
    },
    content: () => Promise.resolve(html),
    async evaluate(expression: string): Promise<unknown> {
      if (expression.includes('localStorage')) {
        if (expression.includes('setItem')) return undefined;
        return JSON.stringify(storage);
      }
      if (expression.includes('navigator.userAgent')) return init.userAgent ?? 'fake-agent';
      return await evaluateIn(pageDocument, expression);
    },
    click: (selector: string) => {
      const route = init.routes?.[selector];
      if (route !== undefined) {
        url = route.url;
        html = route.html;
        pageDocument.typed.clear();
      }
      return Promise.resolve();
    },
    type: (selector: string, text: string) => typeIn(pageDocument, selector, text),
    select: async (selector: string, ...values: string[]): Promise<string[]> => {
      await selectIn(pageDocument, selector, values[0] ?? '');
      return [...values];
    },
    screenshot: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    pdf: () => Promise.resolve(new Uint8Array([4, 5])),
    setRequestInterception: () => Promise.resolve(),
    setOfflineMode: (enabled: boolean) => {
      offline = enabled;
      return Promise.resolve();
    },
    // Read out of the array by NAME, never `features[0].value`: the port's shape is a list and a
    // caller setting `prefers-reduced-motion` beside the scheme must not overwrite the scheme.
    emulateMediaFeatures: (features: readonly { name: string; value: string }[]) => {
      const found = features.find((feature) => feature.name === COLOR_SCHEME_FEATURE);
      if (found !== undefined) colorScheme = found.value;
      return Promise.resolve();
    },
    on: (event: string, handler: (payload: unknown) => void) => {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
      return undefined;
    },
    frames: (): readonly CdpFrameLike[] => frames,
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
    emitPageError(payload: unknown): void {
      for (const handler of handlers.get('pageerror') ?? []) handler(payload);
    },
    aborted,
    get closed(): boolean {
      return closed;
    },
    get offline(): boolean {
      return offline;
    },
    get colorScheme(): string | null {
      return colorScheme;
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
