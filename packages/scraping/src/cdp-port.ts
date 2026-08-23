// The browser library's shape, declared STRUCTURALLY and imported from nowhere.
//
// `puppeteer-core` is the intended implementation and `docs/idea/18-build-vs-wrap.md` permits it
// at exactly this seam — a driver/transport boundary, never the vocabulary. Declaring the port
// instead of importing the types is what keeps that promise mechanical rather than aspirational:
// nothing in `@ultimat3/scraping` can name a `Page`, an `ElementHandle` or a `CDPSession`, so a
// puppeteer type cannot reach `ScrapePage` even by accident, and this package takes no runtime
// dependency at all. The app passes its own `puppeteer` in — the same way `s3Driver({ client })`
// takes a `S3ClientLike` rather than importing a cloud SDK.
//
// Verified against puppeteer-core 25.8.0 on Bun 1.3.14 (both `launch` and
// `connect({ browserWSEndpoint })`, headless Chrome 150): the WebSocket upgrade Playwright's
// `connectOverCDP` cannot do under Bun works here, which is why this is the intended library.

/**
 * The library's screenshot options, restated here rather than shared with `CaptureClip`.
 *
 * This file is the shape of somebody ELSE's object, and importing this package's own vocabulary
 * into it would make a puppeteer call signature depend on a scraping type — the direction this
 * seam exists to forbid. The two shapes are structurally identical, so a `CaptureClip` passes
 * where this is expected and no cast is needed anywhere.
 */
export interface CdpScreenshotOptions {
  readonly fullPage?: boolean;
  /** CSS pixels, page coordinates. Set INSTEAD of `fullPage`, never beside it. */
  readonly clip?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface CdpRequestLike {
  url(): string;
  resourceType(): string;
  /**
   * OPTIONAL, and read defensively: this is the shape of somebody else's event payload, so a
   * launcher that predates the method (or a provider SDK that never had it) still satisfies the
   * port and its requests are recorded as `GET` rather than crashing the interception handler.
   */
  method?(): string;
  abort(): Promise<void>;
  continue(): Promise<void>;
}

export interface CdpPageLike {
  url(): string;
  goto(url: string, options?: { readonly timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  /** The string form. Every read this package makes is an expression, never a closure. */
  evaluate(expression: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  select(selector: string, ...values: string[]): Promise<string[]>;
  screenshot(options: CdpScreenshotOptions): Promise<Uint8Array | string>;
  pdf(options?: Record<string, unknown>): Promise<Uint8Array>;
  setRequestInterception(enabled: boolean): Promise<void>;
  /**
   * `event` stays a bare `string` — a union of the four names this package subscribes to would be
   * this file naming somebody else's event vocabulary, which is the thing it exists not to do, and
   * a launcher whose emitter is wider would then fail to satisfy the port for no reason.
   *
   * Those four, and the pair that is easy to confuse: `request`, `console`, `pageerror` — an
   * uncaught exception INSIDE the page, which leaves the session perfectly usable — and `error`,
   * which is the renderer CRASHING and is what `X_SCRAPE_PAGE_CRASHED` is raised from. Every
   * payload arrives `unknown` and is read defensively in `cdp-target.ts`; nothing here may name
   * the library's own types for them.
   */
  on(event: string, handler: (payload: unknown) => void): unknown;
  frames(): readonly CdpFrameLike[];
  close(): Promise<void>;
}

export interface CdpFrameLike {
  name(): string;
  url(): string;
  content(): Promise<string>;
  evaluate(expression: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  select(selector: string, ...values: string[]): Promise<string[]>;
}

export interface CdpBrowserLike {
  newPage(): Promise<CdpPageLike>;
  /** Present on a browser that owns a cookie jar. Absent ones answer `X_NOT_IMPLEMENTED`. */
  cookies?(): Promise<unknown>;
  setCookie?(...cookies: readonly unknown[]): Promise<void>;
  /** Ends the browser. For an attached session this is what stops the REMOTE half. */
  close(): Promise<void>;
  /** Drops the local connection and leaves the remote browser running. */
  disconnect?(): Promise<void>;
  process?(): { readonly pid?: number | undefined; kill(signal?: number | string): void } | null;
}

/**
 * What an app passes in: `puppeteer` itself. Both methods are optional so a launcher that can only
 * attach (a provider SDK) still satisfies the port — `remoteBrowser()` refuses one with no
 * `connect` at the call site, with a code, rather than at a property access.
 */
export interface CdpLauncherLike {
  launch?(options: Record<string, unknown>): Promise<CdpBrowserLike>;
  connect?(options: Record<string, unknown>): Promise<CdpBrowserLike>;
}
