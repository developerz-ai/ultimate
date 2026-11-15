// A `ScrapeTarget` over recorded HTML: no process, no port, no CDP. This is what `bun test` runs
// against, and it is the reason a scraper's tests need no Chrome.
//
// The rule that makes it worth having: an UNRECORDED request THROWS. A driver that quietly fell
// through to the network would make a green offline suite that is secretly hitting production —
// the exact failure an offline driver exists to prevent.

import type { SleepClock } from '@ultimat3/core';
import type { CaptureClip } from './capture-clip';
import type { ColorScheme } from './color-scheme';
import { browserUnreachable, downloadTimeout, fixtureMissing, fixtureStale } from './error-throws';
import { htmlAccessibility } from './html-a11y';
import { queryHtml } from './html-query';
import { markupRequests } from './html-requests';
import type { InterceptRules } from './intercept';
import { interceptVerdict, refusalEntry } from './intercept';
import { parseKeyChord } from './key-chord';
import { pdfLayoutText } from './pdf-request';
import type { PageRecording } from './recording';
import { splitDownload } from './recording';
import type { ConsoleLine, NetworkEntry, PageError } from './rings';
import { boundedRing } from './rings';
import type { SessionSnapshot } from './session-state';
import { EMPTY_SESSION } from './session-state';
import type {
  AxNode,
  CaptureOptions,
  ElementSnapshot,
  FrameRef,
  GotoOptions,
  PdfOptions,
  ScrapeCookie,
  ScrapeDownloadFile,
  ScrapeFrameTarget,
  ScrapeTarget,
} from './target';

/** Deterministic bytes, so an artifact test asserts on a stable digest. Not a real PNG render. */
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A capture answers DIFFERENT deterministic bytes for every framing fact that was set — one
 * picture per rectangle, one per colour preference. CI has no Chrome, so the offline drivers are
 * the only place a framing knob can be proved at all: a fake that answered the same eight bytes
 * whatever the rectangle would let a driver that silently drops the clip pass every test there is.
 *
 * The colour scheme joined that rule on 2026-08-26, and it is the same defect one axis over. `x
 * shot --island` photographed every state twice and delivered the second picture as a byte-for-
 * byte COPY of the first (issue #338), and no test could see it because this fake answered one
 * constant for both themes.
 *
 * Bytes with NO framing fact set are unchanged, and clip-only bytes are unchanged too — the notes
 * append in a fixed order, so every digest asserted before this existed still holds.
 */
const framedPng = (clip: CaptureClip | undefined, scheme: ColorScheme | null): Uint8Array => {
  const notes =
    (clip === undefined
      ? ''
      : ` clip ${String(clip.x)},${String(clip.y)},${String(clip.width)},${String(clip.height)}`) +
    (scheme === null ? '' : ` scheme ${scheme}`);
  if (notes === '') return FAKE_PNG;
  const suffix = new TextEncoder().encode(notes);
  const out = new Uint8Array(FAKE_PNG.length + suffix.length);
  out.set(FAKE_PNG);
  out.set(suffix, FAKE_PNG.length);
  return out;
};
const FAKE_PDF = new TextEncoder().encode('%PDF-1.4 offline');

/**
 * The PDF rule `framedPng` keeps for pictures: different deterministic bytes per layout, so a
 * driver that dropped `format` or a margin fails a test instead of passing every one. No layout
 * asked for is the old constant, so every digest asserted before this existed still holds.
 */
const laidOutPdf = (options: PdfOptions): Uint8Array => {
  // The framing is not layout: a PDF has no clip (refused upstream) and is always the document.
  const { fullPage: _fullPage, clip: _clip, ...layout } = options;
  const notes = pdfLayoutText(layout);
  return notes === '' ? FAKE_PDF : new TextEncoder().encode(`%PDF-1.4 offline ${notes}`);
};

export type RecordingLookup = (url: string) => Promise<PageRecording | undefined>;

export interface HtmlTargetInit {
  readonly driver: string;
  readonly lookup: RecordingLookup;
  readonly rules: InterceptRules;
  readonly clock: SleepClock;
  /** Where recordings come from, for the cause line: a directory, or `fakeBrowser()`. */
  readonly source: string;
  readonly start?: PageRecording | undefined;
  readonly maxAgeMs?: number | undefined;
  readonly cookies?: readonly ScrapeCookie[] | undefined;
  /** What `page.session()` answers, so a fixture can assert on the browser-to-HTTP handoff. */
  readonly session?: SessionSnapshot | undefined;
}

const EMPTY: PageRecording = { url: 'about:blank', html: '' };

/**
 * A recorded map, read by a key that came out of the RECORDING's own markup — a selector, an
 * expression, an `<iframe name>`. Plain indexing walks the prototype chain, so `name="constructor"`
 * resolved to `Object` rather than to `undefined` and `fixtureMissing` never threw; the run then
 * carried a function where an HTML string belongs. Offline driver only, and it is still worth
 * closing: the confusing test failure it produces costs more to read than this line does.
 */
const recorded = (
  map: Readonly<Record<string, string>> | undefined,
  key: string,
): string | undefined => (map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined);

/** Typed text is an overlay keyed by `id`, then `name`, then the selector used to type it. */
const keyOf = (selector: string, element: ElementSnapshot | undefined): string => {
  if (element === undefined) return selector;
  const id = element.attrs['id'];
  if (id !== undefined) return `#${id}`;
  const name = element.attrs['name'];
  if (name !== undefined) return `[name=${name}]`;
  return selector;
};

/**
 * ONE browsing context: the page's document, or a frame's. A browser gives every context its own
 * DOM and its own form state, so this target gives every one its own markup and its own overlay.
 *
 * It is the whole fix for the frame half. The frame target used to be `{ ...base }` with `query`
 * overridden, so `type`, `clear` and `select` read the element out of the PARENT's markup and
 * wrote into the PARENT's overlay — a value typed into an iframe'd login form then read back out
 * of `page.values()`, and a `fill` seeded itself from the parent field's value.
 */
interface OfflineDocument {
  html(): string;
  readonly overlay: Map<string, string>;
}

export function htmlTarget(init: HtmlTargetInit): ScrapeTarget {
  const consoleRing = boundedRing<ConsoleLine>();
  const networkRing = boundedRing<NetworkEntry>();
  // Built and never pushed to, deliberately: this target parses markup and executes none of it, so
  // there is no uncaught exception for it to have. It ANSWERS rather than omitting the ring —
  // `page.pageErrors()` returning `[]` here is the honest "nothing threw, and nothing could",
  // where a missing ring would be a page method that throws on two of the three drivers.
  // `driver-parity.test.ts` pins the divergence, beside the box/hit-target one it already carries.
  const pageErrorRing = boundedRing<PageError>();
  const overlay = new Map<string, string>();
  /**
   * One overlay per FRAME, held here rather than in the frame target, because `frames()` builds a
   * fresh target on every call — `page.frame(name)` re-resolves per operation, by design — so an
   * overlay owned by the target would be discarded between the `clear` and the `type` a single
   * `fill` performs. Keyed by name and URL together: two frames may share either one alone.
   */
  const frameOverlays = new Map<string, Map<string, string>>();
  let page: PageRecording = init.start ?? EMPTY;
  let armed: string | undefined;
  // `null` and not `'no-preference'`: nothing set one, which is the launcher's own default and not
  // a value this driver invents — and it is what keeps an unframed picture's bytes unchanged.
  let colorScheme: ColorScheme | null = null;
  let closed = false;
  // `page.offline(true)`: every navigation fails until it is cleared, as in a browser.
  let offline = false;
  let session: SessionSnapshot = init.session ?? {
    ...EMPTY_SESSION,
    cookies: init.cookies ?? [],
  };

  const live = (): void => {
    if (closed) throw browserUnreachable(init.driver, 'the offline target is already closed');
  };

  const withOverlay = (
    document: OfflineDocument,
    selector: string,
    elements: readonly ElementSnapshot[],
  ): ElementSnapshot[] =>
    elements.map((element) => {
      const typed = document.overlay.get(keyOf(selector, element));
      return typed === undefined ? element : { ...element, value: typed };
    });

  const queryIn = async (
    document: OfflineDocument,
    selector: string,
  ): Promise<readonly ElementSnapshot[]> => {
    live();
    return withOverlay(document, selector, await queryHtml(document.html(), selector));
  };

  const atIn = (
    document: OfflineDocument,
    selector: string,
    index: number,
  ): Promise<ElementSnapshot | undefined> =>
    queryIn(document, selector).then((elements) => elements[index]);

  /** Appends, exactly as typing does — the port's contract. `fill` is a `clear` and then this. */
  const typeIn = async (
    document: OfflineDocument,
    selector: string,
    text: string,
  ): Promise<void> => {
    const element = await atIn(document, selector, 0);
    const key = keyOf(selector, element);
    document.overlay.set(key, `${document.overlay.get(key) ?? element?.value ?? ''}${text}`);
  };

  const setIn = async (
    document: OfflineDocument,
    selector: string,
    value: string,
  ): Promise<void> => {
    document.overlay.set(keyOf(selector, await atIn(document, selector, 0)), value);
  };

  const pageDocument: OfflineDocument = { html: () => page.html, overlay };

  const query = (selector: string): Promise<readonly ElementSnapshot[]> =>
    queryIn(pageDocument, selector);

  const at = (selector: string, index: number): Promise<ElementSnapshot | undefined> =>
    atIn(pageDocument, selector, index);

  /** Interception, offline: every request the markup would make, judged by the same rule. */
  const intercept = async (recording: PageRecording): Promise<void> => {
    for (const request of await markupRequests(recording.html, recording.url)) {
      const verdict = interceptVerdict(request.url, request.resourceType, init.rules);
      const now = init.clock.now().getTime();
      networkRing.push(
        verdict === 'allow'
          ? {
              method: 'GET',
              url: request.url,
              resourceType: request.resourceType,
              at: now,
              status: 200,
            }
          : refusalEntry(request.url, request.resourceType, verdict, now),
      );
    }
  };

  const load = async (url: string): Promise<void> => {
    const found = await init.lookup(url);
    if (found === undefined) throw fixtureMissing(url, init.source);
    if (init.maxAgeMs !== undefined && found.recordedAt !== undefined) {
      const age = init.clock.now().getTime() - new Date(found.recordedAt).getTime();
      if (age > init.maxAgeMs) throw fixtureStale(url, age, init.maxAgeMs);
    }
    page = found;
    overlay.clear();
    // A navigation is a new document tree, frames included: a value typed into the old page's
    // frame must not answer a query on the new one's.
    frameOverlays.clear();
    armed = undefined;
    networkRing.push({
      method: 'GET',
      url,
      resourceType: 'document',
      status: 200,
      at: init.clock.now().getTime(),
    });
    await intercept(found);
  };

  /** Relative specifiers resolve against the current page, exactly as a browser resolves them. */
  const navigate = async (url: string): Promise<void> => {
    live();
    if (offline) throw browserUnreachable(`${init.driver} goto ${url}`, 'the browser is offline');
    let absolute: string;
    try {
      absolute = new URL(url, page.url === 'about:blank' ? undefined : page.url).toString();
    } catch {
      throw fixtureMissing(url, init.source);
    }
    await load(absolute);
  };

  const overlayFor = (key: string): Map<string, string> => {
    const found = frameOverlays.get(key);
    if (found !== undefined) return found;
    const created = new Map<string, string>();
    frameOverlays.set(key, created);
    return created;
  };

  /**
   * A frame target: `ScrapeFrameTarget`'s verbs, every one pointed at this frame's DOCUMENT. It
   * was built by spreading the parent's, and a verb nobody overrode silently acted on the parent;
   * the narrow type leaves nothing to inherit, so every verb is listed here.
   *
   * `click` navigates NOTHING, and that is a real limit rather than an oversight: a
   * `PageRecording.frames` entry is one static document, so there is no second frame document for
   * a click to land on. What it must never do is navigate the PARENT, which is what inheriting
   * `base.click` did — `driver-parity-frames.test.ts` pins that on all three drivers. `evaluate`
   * is the parent's: the recording format keys evaluations per PAGE, so a frame has no map of its
   * own to read. `press` is the parent's for the browser's reason — one keyboard.
   */
  const frameTarget = (html: string, url: string, key: string): ScrapeFrameTarget => {
    const document: OfflineDocument = { html: () => html, overlay: overlayFor(key) };
    return {
      url: () => url,
      content: () => Promise.resolve(html),
      query: (selector) => queryIn(document, selector),
      async click(selector: string): Promise<void> {
        const element = await atIn(document, selector, 0);
        if (element === undefined) throw fixtureMissing(`${url} ${selector}`, init.source);
        const download =
          recorded(page.downloads, selector) ?? recorded(page.downloads, element.attrs['id'] ?? '');
        if (download !== undefined) armed = download;
      },
      type: (selector, text) => typeIn(document, selector, text),
      clear: (selector) => setIn(document, selector, ''),
      select: (selector, values) => setIn(document, selector, values[0] ?? ''),
      // The frame's OWN document, for `click`'s reason: inheriting `base.focus` would refuse a
      // selector that exists only in the frame, and accept one that exists only in the parent.
      async focus(selector: string): Promise<void> {
        const element = await atIn(document, selector, 0);
        if (element === undefined) throw fixtureMissing(`${url} ${selector}`, init.source);
      },
      evaluate: (expression) => base.evaluate(expression),
      press: (chord) => base.press(chord),
      frames: () => Promise.resolve([]),
    };
  };

  const base: ScrapeTarget = {
    driver: init.driver,
    console: consoleRing,
    network: networkRing,
    pageErrors: pageErrorRing,
    url: () => page.url,
    goto: (url: string, _options: GotoOptions): Promise<void> => navigate(url),
    content: (): Promise<string> => {
      live();
      return Promise.resolve(page.html);
    },
    query,
    async click(selector: string): Promise<void> {
      const element = await at(selector, 0);
      if (element === undefined) throw fixtureMissing(`${page.url} ${selector}`, init.source);
      const download =
        recorded(page.downloads, selector) ?? recorded(page.downloads, element.attrs['id'] ?? '');
      if (download !== undefined) armed = download;
      const href =
        element.attrs['data-goto'] ?? (element.tag === 'a' ? element.attrs['href'] : undefined);
      if (href !== undefined && href !== '') await navigate(href);
    },
    type: (selector: string, text: string): Promise<void> => typeIn(pageDocument, selector, text),
    clear: (selector: string): Promise<void> => setIn(pageDocument, selector, ''),
    select: (selector: string, values: readonly string[]): Promise<void> =>
      setIn(pageDocument, selector, values[0] ?? ''),
    /**
     * PARSED and then resolved, for `setColorScheme`'s reason and not `setOfflineMode`'s. There is
     * no JS engine here, so no `keydown` listener can hear the chord — but the one thing this
     * driver CAN be wrong about, the chord's spelling, is checked by the same `parseKeyChord` the
     * real driver runs, so `'Ctrl+K'` is `X_SCRAPE_KEY_INVALID` offline exactly as it is live. What
     * it cannot prove is that the page reacted; a test that needs that runs on `localBrowser()`.
     */
    press(chord: string): Promise<void> {
      live();
      parseKeyChord(chord);
      return Promise.resolve();
    },
    /** The selector must exist, as `click` requires — a focus on nothing is a fixture gap. */
    async focus(selector: string): Promise<void> {
      const element = await at(selector, 0);
      if (element === undefined) throw fixtureMissing(`${page.url} ${selector}`, init.source);
    },
    /**
     * The HTML-AAM mapping of the markup (`html-a11y.ts`) — ARIA, the implicit role, label
     * association — never `role=` read alone. What it cannot see is CSS and script: a role a
     * stylesheet hides or a script adds is a test for `localBrowser()`/`remoteBrowser()`.
     */
    async accessibility(selector: string, max: number): Promise<readonly AxNode[]> {
      live();
      return await htmlAccessibility(page.html, selector, max);
    },
    evaluate(expression: string): Promise<unknown> {
      live();
      const answer = recorded(page.evaluate, expression);
      // Unrecorded and therefore refused, for the same reason an unrecorded page is: an offline
      // driver that invented an answer here would make the assertion above it meaningless.
      if (answer === undefined)
        throw fixtureMissing(`${page.url} evaluate(${expression})`, init.source);
      return Promise.resolve(JSON.parse(answer) as unknown);
    },
    /**
     * CUTS this driver's own network, never a resolved no-op: while set, every navigation — a
     * `goto`, a link's click — fails with the code a browser's failed navigation carries under the
     * real driver (`X_SCRAPE_BROWSER_UNREACHABLE`), so an offline test that navigates fails here
     * too. The app's own offline code never runs on a driver with no JS engine, so an assertion on
     * what it renders fails rather than passing — the lie a resolved promise used to tell.
     */
    // `async`, so a closed target REJECTS rather than escaping `page.offline(true).catch(…)`.
    async setOfflineMode(enabled: boolean): Promise<void> {
      live();
      offline = enabled;
    },
    /**
     * ACCEPTED and recorded — the line between this and `setOfflineMode`, which cuts navigations,
     * is which side of a capture the verb is on, not whether this driver has a browser.
     *
     * `setOfflineMode` must CUT something because an offline ASSERTION is reachable here: this
     * driver answers content, so a resolved no-op would let `expect(page).toShow('queued')` go
     * green against an app that was online the whole time. A colour preference has no such
     * assertion to pass. Nothing here
     * evaluates CSS, and the only thing a preference could be wrong ABOUT is a picture — which on
     * this driver is `FAKE_PNG`, a constant that claims nothing about a theme, exactly as `pdf()`
     * answers `FAKE_PDF` rather than refusing.
     *
     * Refusing would cost the capability its unit test. `x shot --island` is proved end to end on
     * a machine with no Chrome by driving this driver, so a refusal here makes the command
     * untestable offline — and the picture it would be protecting does not exist.
     *
     * Observable through the PICTURE, which is the only place it could ever be wrong: `framedPng`
     * answers different deterministic bytes per scheme, exactly as it already does per clip, so a
     * driver that silently dropped the preference fails a test rather than passing every one.
     */
    setColorScheme(scheme: ColorScheme): Promise<void> {
      // `'no-preference'` is a CLEAR on the real driver, so it is a clear here — and the picture
      // goes back to the unframed bytes, which is the same fact stated in the one place a fake can
      // state it.
      colorScheme = scheme === 'no-preference' ? null : scheme;
      return Promise.resolve();
    },
    /**
     * ACCEPTED, for `setColorScheme`'s reason. This driver parses
     * markup and executes none of it, so there is no document script for the expression to run
     * ahead of — and no assertion a resolved promise could let through: what a prepared script
     * seeds is the INPUT to a boot this driver never runs. Refusing would cost `x shot` and every
     * `ui.*` tool their unit tests on a machine with no Chrome, for an outcome that does not exist
     * here. `live()` still refuses a closed target, which is the one thing this can be wrong about
     * — and `async`, so that refusal REJECTS rather than escaping a caller's `.catch()`.
     */
    async prepare(_expression: string): Promise<void> {
      live();
    },
    screenshot: (options: CaptureOptions): Promise<Uint8Array> =>
      Promise.resolve(framedPng(options.clip, colorScheme)),
    pdf: (options: PdfOptions): Promise<Uint8Array> => Promise.resolve(laidOutPdf(options)),
    cookies: (): Promise<readonly ScrapeCookie[]> => Promise.resolve(session.cookies),
    session: (): Promise<SessionSnapshot> => Promise.resolve(session),
    restore: (next: SessionSnapshot): Promise<void> => {
      session = next;
      return Promise.resolve();
    },
    // `async`, so the refusal REJECTS: the method is typed `Promise<ScrapeDownloadFile>` and a
    // synchronous `throw` from one escapes past `download().catch(…)` at every caller.
    async download(options: { readonly timeoutMs: number }): Promise<ScrapeDownloadFile> {
      if (armed === undefined) throw downloadTimeout(options.timeoutMs, page.url);
      const { filename, contents } = splitDownload(armed);
      armed = undefined;
      return { filename, bytes: new TextEncoder().encode(contents) };
    },
    async frames(): Promise<readonly FrameRef[]> {
      const refs: FrameRef[] = [];
      for (const element of await queryHtml(page.html, 'iframe')) {
        const name = element.attrs['name'] ?? element.attrs['id'] ?? '';
        const src = element.attrs['src'] ?? '';
        const html = recorded(page.frames, name) ?? recorded(page.frames, src);
        if (html === undefined)
          throw fixtureMissing(`${page.url} iframe ${name || src}`, init.source);
        const url = src === '' ? page.url : new URL(src, page.url).toString();
        refs.push({
          name,
          url,
          selector: element.attrs['id'] === undefined ? undefined : `#${element.attrs['id']}`,
          target: frameTarget(html, url, `${name}\u0000${url}`),
        });
      }
      return refs;
    },
    close(): Promise<void> {
      closed = true;
      return Promise.resolve();
    },
  };
  return base;
}
