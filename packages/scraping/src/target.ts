// The driver-blind currency: what every browser driver hands back, and the only shape the page
// vocabulary reads. No puppeteer type, no CDP type and no `any` crosses this line — which is what
// lets `page-over-target.ts` be the ONE implementation of `ScrapePage` for the real browser, the
// fixture replayer and the fake alike.

import type { ConsoleRing, NetworkRing, PageErrorRing } from './rings';
import type { SessionSnapshot } from './session-state';

/**
 * The document root, as a selector every target must answer. `text()` with no argument is "all
 * the text on this page", and a driver-specific spelling of that would be the first thing to
 * diverge between the fake and the real browser.
 */
export const ROOT_SELECTOR = 'html';

export interface ElementBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One element, as of one observation. Everything the actionability rule needs, and nothing that
 * would let a caller hold a live handle: a snapshot is a VALUE, so it cannot go stale behind the
 * caller's back the way a `frameLocator` handle does — it is simply old, and `page-over-target.ts`
 * takes a fresh one before every act.
 */
export interface ElementSnapshot {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly text: string;
  /** The form value for a control, `''` for anything else. Never `undefined` — absent is ''. */
  readonly value: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  /**
   * Absent means THIS TARGET HAS NO LAYOUT ENGINE (the fake and the fixture parse HTML; nothing
   * is laid out). Never a fabricated zero box: `driver-parity.test.ts` pins the divergence in one
   * place, and a `{ x: 0, y: 0 }` invented here would make a covered button test green on the
   * only driver that could have caught it.
   */
  readonly box?: ElementBox | undefined;
  /** Whether this element is what a click at its own centre would hit. Absent: no layout. */
  readonly hitTarget?: boolean | undefined;
}

export interface ScrapeCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires?: number | undefined;
  readonly httpOnly: boolean;
  readonly secure: boolean;
}

export interface ScrapeDownloadFile {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

/** A child frame, addressed by whatever the page can see of it. */
export interface FrameRef {
  readonly name: string;
  readonly url: string;
  /** The `<iframe>` selector in the PARENT document, when the driver can tell. */
  readonly selector?: string | undefined;
  readonly target: ScrapeTarget;
}

export interface GotoOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * `fullPage` and nothing else. It carried a required `timeoutMs` until 2026-08 that NO driver
 * honoured — `cdp-target.ts` read only `fullPage`, `html-target.ts` ignored the whole object —
 * so `page.screenshot({ timeout })` was a documented deadline that bounded nothing. Deleted
 * rather than implemented: the CDP port's own `screenshot({ fullPage })` has no timeout slot to
 * forward it to, and a deadline enforced in `page-over-target.ts` would have to race
 * `ScrapeClock.sleep`, which under `testClock` resolves on the first microtask and would time
 * out every capture in every test. A driver's own default is the honest bound.
 */
export interface CaptureOptions {
  readonly fullPage?: boolean | undefined;
}

/**
 * The port. Twelve methods, every one of them something a browser genuinely does and nothing a
 * scraper's vocabulary should be re-deriving per driver.
 */
export interface ScrapeTarget {
  /** `puppeteer` | `fixture` | `fake`. Appears in every error cause raised against it. */
  readonly driver: string;
  readonly console: ConsoleRing;
  readonly network: NetworkRing;
  /**
   * REQUIRED, and empty is a legitimate answer. A driver with no JS engine has no uncaught
   * exception to report and answers an empty ring; an optional member would instead let a driver
   * be silent about errors it CAN see, which is precisely the blind spot this ring closes — and
   * `ScrapePage.pageErrors()` would then be a method that answers nothing on an unknown subset of
   * drivers. A third-party driver added before 2026-08-21 gets a type error naming this field,
   * which is the whole enforcement.
   */
  readonly pageErrors: PageErrorRing;
  url(): string;
  goto(url: string, options: GotoOptions): Promise<void>;
  /** Serialised HTML of THIS target — the document for a page, the subtree for a frame. */
  content(): Promise<string>;
  query(selector: string): Promise<readonly ElementSnapshot[]>;
  /**
   * Clicks the FIRST match. It took an `index` until 2026-08 that `html-target.ts` honoured and
   * `cdp-target.ts` dropped — its implementations are `click: (selector) => …`, so puppeteer
   * clicked match 0 whatever was asked. They agreed only because `page-over-target.ts`, the sole
   * caller, always passed `0`, and no public vocabulary could set it: `ScrapeFrame.click` takes
   * `(selector, options?: WaitOptions)`. A port member no app can reach and one driver ignores is
   * a divergence waiting to be found by an app, so it is gone. `driver-parity.test.ts` pins that
   * all three drivers click the first match.
   */
  click(selector: string): Promise<void>;
  /** Appends, exactly as typing does. Clearing first is `fill`'s job at the page level. */
  type(selector: string, text: string): Promise<void>;
  clear(selector: string): Promise<void>;
  select(selector: string, values: readonly string[]): Promise<void>;
  /** The expression runs in the page. The result is `unknown` and is parsed by the caller. */
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: CaptureOptions): Promise<Uint8Array>;
  pdf(options: CaptureOptions): Promise<Uint8Array>;
  cookies(): Promise<readonly ScrapeCookie[]>;
  /** Whatever the last click/navigation produced as a file, or a `X_SCRAPE_DOWNLOAD_TIMEOUT`. */
  download(options: { readonly timeoutMs: number }): Promise<ScrapeDownloadFile>;
  frames(): Promise<readonly FrameRef[]>;
  /**
   * Everything that makes this client THIS client: cookies, storage, the headers the site now
   * expects, the user agent. It is the browser-to-HTTP handoff, and it is the thing a session
   * store persists — so it is credential material and is summarised, never logged.
   */
  session(): Promise<SessionSnapshot>;
  /** Put a previously captured session back, before the first navigation. */
  restore(session: SessionSnapshot): Promise<void>;
  close(): Promise<void>;
}
