// A `ScrapeTarget` over recorded HTML: no process, no port, no CDP. This is what `bun test` runs
// against, and it is the reason a scraper's tests need no Chrome.
//
// The rule that makes it worth having: an UNRECORDED request THROWS. A driver that quietly fell
// through to the network would make a green offline suite that is secretly hitting production —
// the exact failure an offline driver exists to prevent.

import type { CaptureClip } from './capture-clip';
import type { ScrapeClock } from './clock';
import type { ColorScheme } from './color-scheme';
import {
  browserUnreachable,
  downloadTimeout,
  fixtureMissing,
  fixtureStale,
  scrapeNotImplemented,
} from './error-throws';
import { queryHtml } from './html-query';
import { markupRequests } from './html-requests';
import type { InterceptRules } from './intercept';
import { interceptVerdict, refusalEntry } from './intercept';
import type { PageRecording } from './recording';
import { splitDownload } from './recording';
import type { ConsoleLine, NetworkEntry, PageError } from './rings';
import { createRing } from './rings';
import type { SessionSnapshot } from './session-state';
import { EMPTY_SESSION } from './session-state';
import type {
  CaptureOptions,
  ElementSnapshot,
  FrameRef,
  GotoOptions,
  ScrapeCookie,
  ScrapeDownloadFile,
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

export type RecordingLookup = (url: string) => Promise<PageRecording | undefined>;

export interface HtmlTargetInit {
  readonly driver: string;
  readonly lookup: RecordingLookup;
  readonly rules: InterceptRules;
  readonly clock: ScrapeClock;
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
  const consoleRing = createRing<ConsoleLine>();
  const networkRing = createRing<NetworkEntry>();
  // Built and never pushed to, deliberately: this target parses markup and executes none of it, so
  // there is no uncaught exception for it to have. It ANSWERS rather than omitting the ring —
  // `page.pageErrors()` returning `[]` here is the honest "nothing threw, and nothing could",
  // where a missing ring would be a page method that throws on two of the three drivers.
  // `driver-parity.test.ts` pins the divergence, beside the box/hit-target one it already carries.
  const pageErrorRing = createRing<PageError>();
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
   * A frame target: the parent's, with every verb that touches a DOCUMENT re-pointed at this
   * frame's. `...base` is what makes the spread dangerous — a verb nobody overrides silently acts
   * on the parent — so the act-verbs are listed here even where the body is one line.
   *
   * `click` navigates NOTHING, and that is a real limit rather than an oversight: a
   * `PageRecording.frames` entry is one static document, so there is no second frame document for
   * a click to land on. What it must never do is navigate the PARENT, which is what inheriting
   * `base.click` did — `driver-parity-frames.test.ts` pins that on all three drivers. `evaluate` and
   * `download` stay the parent's: the recording format keys evaluations and downloads per PAGE,
   * so a frame has no map of its own to read.
   */
  const frameTarget = (html: string, url: string, key: string): ScrapeTarget => {
    const document: OfflineDocument = { html: () => html, overlay: overlayFor(key) };
    return {
      ...base,
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
     * REFUSED, and `async` so it REJECTS. There is no browser here and no service worker, so
     * there is no network to cut — and a resolved promise would let "a like taken offline is
     * queued" pass against an app that was online for the whole test. That is the exact shape of
     * lie `packages/testing`'s `fetch` patch already tells about a browser's own requests.
     */
    // `async`, so the refusal REJECTS: the method is typed `Promise<void>` and a synchronous
    // `throw` from one jumps straight over `page.offline(true).catch(…)` at every caller.
    async setOfflineMode(_enabled: boolean): Promise<void> {
      throw scrapeNotImplemented(
        `setOfflineMode() on the ${init.driver} driver`,
        'run this assertion on localBrowser()/remoteBrowser(), whose setOfflineMode() reaches a real browser — an offline driver has no network to cut, so it cannot prove an offline behaviour',
      );
    },
    /**
     * ACCEPTED and recorded, where `setOfflineMode` refuses — and the line between them is which
     * side of a capture the verb is on, not whether this driver has a browser.
     *
     * `setOfflineMode` is refused because an offline ASSERTION is reachable here: this driver
     * answers content, so `expect(page).toShow('queued')` would go green against an app that was
     * online the whole time. A colour preference has no such assertion to pass. Nothing here
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
      colorScheme = scheme;
      return Promise.resolve();
    },
    screenshot: (options: CaptureOptions): Promise<Uint8Array> =>
      Promise.resolve(framedPng(options.clip, colorScheme)),
    pdf: (_options: CaptureOptions): Promise<Uint8Array> => Promise.resolve(FAKE_PDF),
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
