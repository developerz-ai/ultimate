// `ScrapeTarget` over a real browser, through the structural CDP port. Everything driver-specific
// in this package lives here and in `driver-cdp.ts`; the vocabulary above it does not change.

import { isUltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { parse, t } from '@ultimat3/schema';
import { browserRecord } from './browser-record';
import { axNodesFor } from './cdp-a11y';
import { frameDocument } from './cdp-a11y-frame';
import type { CdpArmInit } from './cdp-arm';
import { arm, armBrowser } from './cdp-arm';
import { downloadCatcher } from './cdp-download';
import type { CdpFrameLike, CompleteCdpBrowser, CompleteCdpPage } from './cdp-port';
import {
  clearExpression,
  focusExpression,
  parseSnapshots,
  snapshotExpression,
} from './cdp-snapshot';
import { type ColorScheme, colorSchemeFeatures } from './color-scheme';
import { browserUnreachable, pageCrashed } from './error-throws';
import { parseKeyChord } from './key-chord';
import { printOptionsOf } from './pdf-print';
import type { ConsoleLine, NetworkEntry, PageError } from './rings';
import { boundedRing } from './rings';
import type { SessionSnapshot } from './session-state';
import type {
  AxNode,
  CaptureOptions,
  FrameRef,
  GotoOptions,
  PdfOptions,
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

/**
 * The failures `guard()` must NOT re-label: `X_VALIDATION_FAILED`, because a SECOND attempt
 * reaches the identical answer — never because the error looked coded. The browser ANSWERED, and
 * the answer did not match the shape this driver reads it with; the page is what it is, and
 * attempt five reads the same DOM.
 *
 * It was re-labelled `X_SCRAPE_BROWSER_UNREACHABLE`, which `errors.ts` registers `retryable`, so it
 * spent the whole retry policy — five browser launches, five arrivals at a login — while telling
 * the operator the browser went away about a browser that was answering perfectly.
 * `X_SCRAPE_FRAME_OUT_OF_PROCESS` passes too, for the same reason: site isolation laid the page out
 * that way, and attempt five lays it out the same. `X_NOT_IMPLEMENTED` sat here until 2026-11-15,
 * for refusals of a launcher missing a method; that is now checked when the session opens
 * (`cdp-complete.ts`), so nothing here raises it.
 *
 * Every OTHER coded error stays wrapped, deliberately. `thrown instanceof UltimateError` is the
 * naive version of this check and it is wrong: an `X_SCRAPE_TIMEOUT` raised while the socket was
 * already dead would then arrive unwrapped, and "the browser went away mid-run" is the frame that
 * makes a disconnect legible — which is the whole reason this wrapper exists.
 *
 * The half this package cannot close: the code belongs to `@ultimat3/schema` and is NOT
 * classified, so `classifyThrown` reads them as unclassified and the job's attempt
 * count still governs. Passing them through stops the wrong TITLE and the false `retryable`
 * claim; making them terminal is a `registerErrorRetry` beside the code that declares it.
 *
 * `isUltimateError`, not `instanceof`: the brand survives a duplicated module instance.
 */
const PASSED_THROUGH_CODES: ReadonlySet<string> = new Set([
  'X_VALIDATION_FAILED',
  'X_SCRAPE_FRAME_OUT_OF_PROCESS',
]);

const isStructuralRefusal = (thrown: unknown): boolean =>
  isUltimateError(thrown) && PASSED_THROUGH_CODES.has(thrown.code);

/**
 * `ringCapacity` was declared here, exported, read three lines into `cdpTarget` — and passed by
 * NOBODY: `driver-cdp.ts` constructs without it and no `BrowserOptions` or `ScrapeDefinition`
 * field reaches it, so an app could not set it at any distance. Deleted rather than threaded, the
 * same call `CaptureOptions.timeoutMs` got: wiring it through only the CDP driver would give one
 * of three drivers a bound the other two ignore, which is precisely the divergence
 * `driver-parity.test.ts` exists to refuse. `DEFAULT_RING_CAPACITY` is the one bound.
 */
export interface CdpTargetInit extends CdpArmInit {
  /** Proven complete when the session opened (`cdp-complete.ts`): every verb below is there. */
  readonly page: CompleteCdpPage;
  readonly browser: CompleteCdpBrowser;
  /**
   * Why the session was ended from OUTSIDE the call, if it was — the fired wedge guard's reason.
   * A thunk, because the guard is built after the target. Read before a failure is re-labelled:
   * the fire closes the socket, so a call pending on it rejects, and that rejection is the fire's
   * consequence. Labelled `X_SCRAPE_BROWSER_UNREACHABLE` it hides the cause and its fix.
   */
  readonly ended?: (() => unknown) | undefined;
}

export async function cdpTarget(init: CdpTargetInit): Promise<ScrapeTarget> {
  const console_ = boundedRing<ConsoleLine>();
  const network = boundedRing<NetworkEntry>();
  const pageErrors = boundedRing<PageError>();
  const crashed: { value: string | undefined } = { value: undefined };
  await arm(init, { network, console: console_, pageErrors, crashed });
  const downloads = downloadCatcher({ page: init.page, clock: init.clock });
  await downloads.arm(await armBrowser(init, network, downloads.capture));
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
    // PAIRS, never an object literal: `{"__proto__": "…"}` in the page sets the literal's
    // prototype and files no key, so a token stored under that legal name was never restored.
    await init.page.evaluate(
      `(() => { for (const [key, value] of ${JSON.stringify(Object.entries(pending.storage))}) localStorage.setItem(key, value); })()`,
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
      const ended = init.ended?.();
      if (ended !== undefined) throw ended;
      live();
      if (isStructuralRefusal(thrown)) throw thrown;
      throw browserUnreachable(`${CDP_DRIVER} ${what}`, thrown);
    }
  };

  // The parent's, with every verb that addresses a DOCUMENT re-pointed at the frame's — the
  // spread is why each of those must be listed, or it silently acts on the parent.
  const frameTarget = (frame: CdpFrameLike, parent: ScrapeTarget): ScrapeTarget => ({
    ...parent,
    url: () => frame.url(),
    content: () => guard('content', () => frame.content()),
    query: (selector, options) =>
      guard('query', async () =>
        parseSnapshots(await frame.evaluate(snapshotExpression(selector, options))),
      ),
    click: (selector) => guard('click', () => frame.click(selector)),
    type: (selector, text) => guard('type', () => frame.type(selector, text)),
    // Listed even though `type` above already covers the pair a `fill` performs: `clear` is the
    // one verb with no port method, so it is the one an author of a new frame verb forgets. It was
    // forgotten — the spread handed the frame the PAGE's closure, so `frame.fill()` emptied the
    // parent document's same-named field and merely APPENDED to the frame's, which is how an
    // iframe'd login submits `oldUserNEWUSER` and passes its own offline test doing it.
    clear: (selector) =>
      guard('clear', async () => {
        await frame.evaluate(clearExpression(selector));
      }),
    select: (selector, values) =>
      guard('select', async () => {
        await frame.select(selector, ...values);
      }),
    evaluate: (expression) => guard('evaluate', () => frame.evaluate(expression)),
    // The PAGE's, listed rather than inherited so the next reader sees it was decided: a browser
    // has one keyboard, and the focused element — set with the frame's own `focus` below — is what
    // routes the chord into the frame's document.
    press: (chord) => parent.press(chord),
    frames: () => Promise.resolve([]),
    focus: (selector) =>
      guard('focus', async () => {
        await frame.evaluate(focusExpression(selector));
      }),
    // The FRAME's document, through the page's own session: `Accessibility.getPartialAXTree` is
    // addressed by node, and `cdp-a11y-frame.ts` finds the frame's document node to scope the
    // query to. Twins — same name, same URL — are told apart by their place in the library's list.
    accessibility: (selector, max) =>
      guard('accessibility', async () => {
        const twins = init.page
          .frames()
          .filter((other) => other.name() === frame.name() && other.url() === frame.url());
        const address = { name: frame.name(), url: frame.url(), ordinal: twins.indexOf(frame) };
        const session = await init.page.createCDPSession();
        try {
          return await axNodesFor(session, selector, max, frameDocument(CDP_DRIVER, address));
        } finally {
          await session.detach();
        }
      }),
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
    query: (selector, options) =>
      guard('query', async () =>
        parseSnapshots(await init.page.evaluate(snapshotExpression(selector, options))),
      ),
    click: (selector) => guard('click', () => init.page.click(selector)),
    type: (selector, text) => guard('type', () => init.page.type(selector, text)),
    clear: (selector) =>
      guard('clear', async () => {
        await init.page.evaluate(clearExpression(selector));
      }),
    select: (selector, values) =>
      guard('select', async () => {
        await init.page.select(selector, ...values);
      }),
    evaluate: (expression) => guard('evaluate', () => init.page.evaluate(expression)),
    // `async`, and the parse OUTSIDE `guard()`: the chord is the caller's literal, not the
    // browser's answer, so a bad one is `X_SCRAPE_KEY_INVALID` and never re-labelled "the browser
    // went away" — and it is parsed before the keyboard is touched, because a refusal halfway
    // through the sequence below would leave a modifier held for every later verb on this page.
    press: async (chord: string): Promise<void> => {
      const { modifiers, key } = parseKeyChord(chord);
      await guard('press', async () => {
        const keyboard = init.page.keyboard;
        // Down in the order written, the key, then up in REVERSE — the order a hand releases
        // them, and the order the browser's own `press` with modifiers performs. `.call`-free:
        // `keyboard` is read as an object and its methods are called through it.
        for (const modifier of modifiers) await keyboard.down(modifier);
        try {
          await keyboard.press(key);
        } finally {
          for (const modifier of [...modifiers].reverse()) await keyboard.up(modifier);
        }
      });
    },
    focus: (selector: string): Promise<void> =>
      guard('focus', async () => {
        await init.page.focus(selector);
      }),
    accessibility: (selector: string, max: number): Promise<readonly AxNode[]> =>
      guard('accessibility', async () => {
        const session = await init.page.createCDPSession();
        try {
          return await axNodesFor(session, selector, max);
        } finally {
          await session.detach();
        }
      }),
    setOfflineMode: (enabled: boolean): Promise<void> =>
      guard('setOfflineMode', async () => {
        await init.page.setOfflineMode(enabled);
      }),
    setColorScheme: (scheme: ColorScheme): Promise<void> =>
      guard('setColorScheme', async () => {
        await init.page.emulateMediaFeatures(colorSchemeFeatures(scheme));
      }),
    prepare: (expression: string): Promise<void> =>
      guard('prepare', async () => {
        await init.page.evaluateOnNewDocument(expression);
      }),
    screenshot: (options: CaptureOptions) =>
      guard('screenshot', async () => {
        // `fullPage` is OMITTED when a clip is given rather than sent as `false`: the two are
        // exclusive at the library too, and some builds refuse the pair on truthiness while others
        // resolve it silently. Sending only what was asked for is the request neither can misread.
        const shot = await init.page.screenshot(
          options.clip === undefined
            ? { fullPage: options.fullPage === true }
            : { clip: options.clip },
        );
        // Some builds answer base64 text, some answer bytes. `atob` is the one decoder both a
        // browser and Bun agree on, and it keeps this file free of a Buffer import.
        return typeof shot === 'string'
          ? Uint8Array.from(atob(shot), (character) => character.charCodeAt(0))
          : shot;
      }),
    pdf: (options: PdfOptions) => guard('pdf', () => init.page.pdf(printOptionsOf(options))),
    cookies: () => guard('cookies', async () => parse(cookieSchema, await init.browser.cookies())),
    // OUTSIDE `guard()`, after `live()`: the wait ends in `X_SCRAPE_DOWNLOAD_TIMEOUT`, a refusal
    // about the trigger and not about the browser, which `guard()` would re-label unreachable.
    // `async`, so a crashed page REJECTS rather than throwing past a caller's `.catch()`.
    download: async (options): Promise<ScrapeDownloadFile> => {
      live();
      return await downloads.next(options.timeoutMs, init.page.url());
    },
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
        const jar = parse(cookieSchema, await init.browser.cookies());
        return {
          cookies: jar,
          headers: {},
          // `browserRecord` and not `t.record()`: a page may legitimately hold a key called
          // `constructor`, and the schema refuses that name outright — see `browser-record.ts`.
          storage: browserRecord(JSON.parse(typeof storage === 'string' ? storage : '{}')),
          userAgent: typeof agent === 'string' ? agent : '',
          origin,
        };
      }),
    restore: (session: SessionSnapshot) =>
      guard('restore', async () => {
        // Two halves, because they belong to two different moments: cookies are the browser's and
        // can be put back now, storage is an ORIGIN's and cannot exist until one is loaded.
        if (session.cookies.length > 0) {
          await init.browser.setCookie(...session.cookies);
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
