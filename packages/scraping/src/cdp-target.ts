// `ScrapeTarget` over a real browser, through the structural CDP port. Everything driver-specific
// in this package lives here and in `driver-cdp.ts`; the vocabulary above it does not change.

import { isUltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { parse, t } from '@ultimat3/schema';
import type { CdpBrowserLike, CdpFrameLike, CdpPageLike, CdpRequestLike } from './cdp-port';
import { parseSnapshots, snapshotExpression } from './cdp-snapshot';
import type { ScrapeClock } from './clock';
import { browserUnreachable, pageCrashed, scrapeNotImplemented } from './error-throws';
import type { InterceptRules } from './intercept';
import { interceptVerdict, refusalEntry } from './intercept';
import type {
  ConsoleLine,
  ConsoleRing,
  NetworkEntry,
  NetworkRing,
  PageError,
  PageErrorRing,
  ResourceType,
} from './rings';
import { createRing, pageErrorEntry, RESOURCE_TYPES } from './rings';
import type { SessionSnapshot } from './session-state';
import type {
  CaptureOptions,
  FrameRef,
  GotoOptions,
  ScrapeCookie,
  ScrapeDownloadFile,
  ScrapeTarget,
} from './target';

export const CDP_DRIVER = 'puppeteer';

// `.min(0)` for the same reason `cdp-snapshot.ts` needs it: a cookie's value is legitimately the
// empty string (a cleared session cookie), and refusing one would refuse the whole jar.
const anyString = t.string.min(0);

const cookieSchema = t.array(
  t.object({
    name: t.string,
    value: anyString,
    domain: anyString,
    path: anyString,
    httpOnly: t.boolean,
    secure: t.boolean,
  }),
) as unknown as StandardSchemaV1<unknown, ScrapeCookie[]>;

const storageSchema = t.record(anyString) as unknown as StandardSchemaV1<
  unknown,
  Record<string, string>
>;

const asResourceType = (raw: string): ResourceType =>
  (RESOURCE_TYPES as readonly string[]).includes(raw) ? (raw as ResourceType) : 'other';

/** The library's event payloads are `unknown` here — read structurally, never cast. */
const asRequest = (payload: unknown): CdpRequestLike | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Partial<CdpRequestLike>;
  return typeof candidate.url === 'function' && typeof candidate.abort === 'function'
    ? (candidate as CdpRequestLike)
    : undefined;
};

/**
 * CDP's console levels, mapped onto this package's five. `warning` is the library's spelling of
 * `warn`, `verbose` of `debug`, and everything structural (`table`, `startGroup`, `dir`) is a log
 * line with a shape — never its own level, because `ConsoleLine.level` is what an author filters on.
 */
const CONSOLE_LEVELS: Readonly<Record<string, ConsoleLine['level']>> = {
  error: 'error',
  assert: 'error',
  warning: 'warn',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
  verbose: 'debug',
};

/**
 * Reads a string out of somebody else's event payload, calling an accessor THROUGH ITS OWNER.
 *
 * `HTTPRequest.method()` and `ConsoleMessage.type()`/`.text()` read `this` — they are methods on
 * the library's own objects, not closures over a value. Handing the bare function to a helper
 * (`readString(request.method)`) drops the receiver, so the accessor answers against `undefined`:
 * on one build that throws inside the interception handler, on another it answers wrong.
 */
const readStringFrom = (owner: unknown, key: string): string | undefined => {
  if (typeof owner !== 'object' || owner === null) return undefined;
  const value = (owner as Record<string, unknown>)[key];
  if (typeof value === 'string') return value;
  if (typeof value !== 'function') return undefined;
  const answer = (value as (this: unknown) => unknown).call(owner);
  return typeof answer === 'string' ? answer : undefined;
};

/**
 * A `pageerror` payload, read defensively — never cast, and never assumed to be an `Error`.
 *
 * `readStringFrom`, the same reader the console handler uses, because the payload has the same
 * problem: `message` and `stack` are an own property on one build and an accessor on another, and
 * a schema parse cannot call an accessor. A page can also `throw 'a string'` or throw a frozen
 * object with no `message` at all — both reach here, and both are recorded as SOMETHING having
 * thrown, because an entry with a poor message is still the difference between "the island threw"
 * and silence.
 */
const readPageError = (payload: unknown, at: number): PageError => {
  if (typeof payload === 'string') return pageErrorEntry({ message: payload, at });
  return pageErrorEntry({
    message: readStringFrom(payload, 'message') ?? '',
    stack: readStringFrom(payload, 'stack'),
    at,
  });
};

/**
 * The one failure `guard()` must NOT re-label, and the line is drawn at exactly one code.
 *
 * `X_NOT_IMPLEMENTED` is the only code that says "this build does not have the feature" — a fact
 * about the launcher's own shape, never about the connection. A browser cannot produce it; only
 * this file's own `scrapeNotImplemented()` can, from inside a guarded closure. Re-labelled as
 * `X_SCRAPE_BROWSER_UNREACHABLE` (registered `retryable` in `errors.ts`) it spends every attempt
 * in the scrape's retry policy on a method that is still missing on attempt five, and tells the
 * operator the browser went away while the browser is answering fine.
 *
 * Every OTHER coded error stays wrapped, deliberately. `thrown instanceof UltimateError` is the
 * naive version of this check and it is wrong: an `X_SCRAPE_TIMEOUT` raised while the socket was
 * already dead would then arrive unwrapped, and "the browser went away mid-run" is the frame that
 * makes a disconnect legible — which is the whole reason this wrapper exists.
 *
 * `isUltimateError`, not `instanceof`: the brand survives a duplicated module instance.
 */
const isStructuralRefusal = (thrown: unknown): boolean =>
  isUltimateError(thrown) && thrown.code === 'X_NOT_IMPLEMENTED';

export interface CdpTargetInit {
  readonly page: CdpPageLike;
  readonly browser: CdpBrowserLike;
  readonly rules: InterceptRules;
  readonly clock: ScrapeClock;
  readonly ringCapacity?: number | undefined;
}

/**
 * Everything `arm()` writes into. Named rather than positional: three rings of near-identical
 * type plus a latch is a call site nobody can read, and swapping two of them is a mistake the
 * compiler cannot catch.
 */
interface CdpSinks {
  readonly network: NetworkRing;
  readonly console: ConsoleRing;
  readonly pageErrors: PageErrorRing;
  readonly crashed: { value: string | undefined };
}

/**
 * Interception is armed BEFORE the first navigation and refuses at the request, not after the
 * response — an `allowHosts` that reported afterwards would be a log line about bytes that
 * already left the container.
 */
async function arm(init: CdpTargetInit, sinks: CdpSinks): Promise<void> {
  const { network, console: console_, pageErrors, crashed } = sinks;
  await init.page.setRequestInterception(true);
  init.page.on('request', (payload) => {
    const request = asRequest(payload);
    if (request === undefined) return;
    const url = request.url();
    const type = asResourceType(request.resourceType());
    // The METHOD the browser is actually sending. Recording every request as a GET made
    // `page.network()` — which `X_SCRAPE_HTTP_FAILED`'s own fix line tells the reader to open —
    // misreport every POST and PUT the page made.
    const method = readStringFrom(request, 'method') ?? 'GET';
    const verdict = interceptVerdict(url, type, init.rules);
    const at = init.clock.now().getTime();
    if (verdict === 'allow') {
      network.push({ method, url, resourceType: type, at });
      void request.continue();
      return;
    }
    network.push(refusalEntry(url, type, verdict, at, method));
    void request.abort();
  });
  init.page.on('console', (payload) => {
    console_.push({
      level: CONSOLE_LEVELS[(readStringFrom(payload, 'type') ?? '').toLowerCase()] ?? 'log',
      text: readStringFrom(payload, 'text') ?? '',
      at: init.clock.now().getTime(),
    });
  });
  /**
   * The page threw and nothing caught it. THE gap this ring closes: a screenshot of an island
   * that threw during hydration is a picture of the server-rendered markup, indistinguishable
   * from a page that worked — and `console` does not carry it, because throwing calls no console
   * method. Subscribed here, beside the others, so a target is observing before its first
   * navigation: an exception raised during load has no second chance to be recorded.
   *
   * NOT the same event as `error` below, and the difference is the whole reason this is a
   * separate handler: puppeteer's `pageerror` is "an uncaught exception happens within the page"
   * and its `error` is "the page crashes" (`PageEvent.PageError` / `PageEvent.Error`). One is the
   * app being broken and the session is fine; the other is the tab being gone. Recording a
   * `pageerror` into `crashed` would make every scrape of a page with one bad island answer
   * X_SCRAPE_PAGE_CRASHED — a code registered `terminal` — for a page still perfectly usable.
   */
  init.page.on('pageerror', (payload) => {
    pageErrors.push(readPageError(payload, init.clock.now().getTime()));
  });
  // A renderer that dies must be a CODE, not a hang: every later call answers X_SCRAPE_PAGE_CRASHED
  // instead of waiting out its own timeout against a tab that is gone.
  init.page.on('error', (payload) => {
    crashed.value = readStringFrom(payload, 'message') ?? 'renderer crashed';
  });
}

export async function cdpTarget(init: CdpTargetInit): Promise<ScrapeTarget> {
  const console_ = createRing<ConsoleLine>(init.ringCapacity);
  const network = createRing<NetworkEntry>(init.ringCapacity);
  const pageErrors = createRing<PageError>(init.ringCapacity);
  const crashed: { value: string | undefined } = { value: undefined };
  await arm(init, { network, console: console_, pageErrors, crashed });
  let pendingStorage: SessionSnapshot | undefined;

  const originOf = (url: string): string => {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  };

  /**
   * `localStorage` is PER ORIGIN, and `restore()` runs before the first navigation — on
   * `about:blank`, an opaque origin with no storage to write to. So the storage half waits for the
   * navigation that reaches the origin the session belongs to, and lands there.
   *
   * The origin has to MATCH: applying it to whatever page loaded first would write the site's
   * bearer token — `session-state.ts` says this is where most sites keep it — into a different
   * site's storage. A session whose origin is never visited simply keeps its storage, which is
   * the same answer a browser gives.
   */
  const applyPendingStorage = async (): Promise<void> => {
    const pending = pendingStorage;
    if (pending === undefined) return;
    if (originOf(init.page.url()) !== pending.origin || pending.origin === '') return;
    pendingStorage = undefined;
    await init.page.evaluate(
      `(() => { const entries = ${JSON.stringify(pending.storage)}; for (const key of Object.keys(entries)) localStorage.setItem(key, entries[key]); })()`,
    );
  };

  const live = (): void => {
    if (crashed.value !== undefined) throw pageCrashed(init.page.url());
  };

  const guard = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    live();
    try {
      return await run();
    } catch (thrown) {
      live();
      if (isStructuralRefusal(thrown)) throw thrown;
      throw browserUnreachable(`${CDP_DRIVER} ${what}`, thrown);
    }
  };

  const frameTarget = (frame: CdpFrameLike, parent: ScrapeTarget): ScrapeTarget => ({
    ...parent,
    url: () => frame.url(),
    content: () => guard('content', () => frame.content()),
    query: (selector) =>
      guard('query', async () =>
        parseSnapshots(await frame.evaluate(snapshotExpression(selector))),
      ),
    click: (selector) => guard('click', () => frame.click(selector)),
    type: (selector, text) => guard('type', () => frame.type(selector, text)),
    select: (selector, values) =>
      guard('select', async () => {
        await frame.select(selector, ...values);
      }),
    evaluate: (expression) => guard('evaluate', () => frame.evaluate(expression)),
    frames: () => Promise.resolve([]),
  });

  const target: ScrapeTarget = {
    driver: CDP_DRIVER,
    console: console_,
    network,
    // Shared with every frame target below, through the spread: an exception is the PAGE's, and a
    // per-frame ring would hide a throw from an iframe behind whichever handle the caller held.
    pageErrors,
    url: () => init.page.url(),
    goto: (url: string, options: GotoOptions) =>
      guard('goto', async () => {
        await init.page.goto(url, { timeout: options.timeoutMs });
        await applyPendingStorage();
      }),
    content: () => guard('content', () => init.page.content()),
    query: (selector) =>
      guard('query', async () =>
        parseSnapshots(await init.page.evaluate(snapshotExpression(selector))),
      ),
    click: (selector) => guard('click', () => init.page.click(selector)),
    type: (selector, text) => guard('type', () => init.page.type(selector, text)),
    clear: (selector) =>
      guard('clear', async () => {
        await init.page.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } })()`,
        );
      }),
    select: (selector, values) =>
      guard('select', async () => {
        await init.page.select(selector, ...values);
      }),
    evaluate: (expression) => guard('evaluate', () => init.page.evaluate(expression)),
    screenshot: (options: CaptureOptions) =>
      guard('screenshot', async () => {
        const shot = await init.page.screenshot({ fullPage: options.fullPage === true });
        // Some builds answer base64 text, some answer bytes. `atob` is the one decoder both a
        // browser and Bun agree on, and it keeps this file free of a Buffer import.
        return typeof shot === 'string'
          ? Uint8Array.from(atob(shot), (character) => character.charCodeAt(0))
          : shot;
      }),
    pdf: (_options: CaptureOptions) => guard('pdf', () => init.page.pdf()),
    cookies: () =>
      guard('cookies', async () => {
        const source = init.browser as { cookies?: () => Promise<unknown> };
        if (typeof source.cookies !== 'function') {
          throw scrapeNotImplemented(
            'cookies() on a CDP browser with no cookies() method',
            'upgrade the launcher to a puppeteer-core that exposes browser.cookies(), or read them with page.evaluate("document.cookie")',
          );
        }
        return parse(cookieSchema, await source.cookies());
      }),
    // Honest stub, in the shape `packages/jobs/src/driver-redis.ts` uses. A real one needs
    // `Browser.setDownloadBehavior` over a raw CDP session plus a directory watch, and a
    // half-written version that silently returned empty bytes is worse than this line.
    //
    // REJECTS rather than throws: the method is typed `Promise<ScrapeDownloadFile>` and every
    // caller of a promise-typed method handles its failure with `.catch()` or an `await` inside a
    // `try` — a synchronous `throw` jumps over the first of those entirely.
    download: (_options): Promise<ScrapeDownloadFile> =>
      Promise.reject(
        scrapeNotImplemented(
          'download() on the puppeteer driver',
          'fetch the file inside the page — page.evaluate("fetch(url).then(r => r.text())") — or run this scrape on fixtureBrowser(), whose download() is complete',
        ),
      ),
    frames: () =>
      guard('frames', () =>
        Promise.resolve(
          init.page.frames().map(
            (frame): FrameRef => ({
              name: frame.name(),
              url: frame.url(),
              target: frameTarget(frame, target),
            }),
          ),
        ),
      ),
    session: () =>
      guard('session', async () => {
        const storage = await init.page.evaluate(
          '(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))))()',
        );
        const agent = await init.page.evaluate('navigator.userAgent');
        let origin = '';
        try {
          origin = new URL(init.page.url()).origin;
        } catch {
          origin = '';
        }
        const source = init.browser as { cookies?: () => Promise<unknown> };
        return {
          cookies:
            typeof source.cookies === 'function' ? parse(cookieSchema, await source.cookies()) : [],
          headers: {},
          storage: parse(storageSchema, JSON.parse(typeof storage === 'string' ? storage : '{}')),
          userAgent: typeof agent === 'string' ? agent : '',
          origin,
        };
      }),
    restore: (session: SessionSnapshot) =>
      guard('restore', async () => {
        // Two halves, because they belong to two different moments: cookies are the browser's and
        // can be put back now, storage is an ORIGIN's and cannot exist until one is loaded.
        const source = init.browser as {
          setCookie?: (...cookies: readonly unknown[]) => Promise<void>;
        };
        if (typeof source.setCookie === 'function' && session.cookies.length > 0) {
          await source.setCookie(...session.cookies);
        }
        pendingStorage = Object.keys(session.storage).length > 0 ? session : undefined;
        await applyPendingStorage();
      }),
    close: async (): Promise<void> => {
      await init.page.close();
    },
  };
  return target;
}
