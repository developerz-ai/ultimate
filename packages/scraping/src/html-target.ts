// A `ScrapeTarget` over recorded HTML: no process, no port, no CDP. This is what `bun test` runs
// against, and it is the reason a scraper's tests need no Chrome.
//
// The rule that makes it worth having: an UNRECORDED request THROWS. A driver that quietly fell
// through to the network would make a green offline suite that is secretly hitting production —
// the exact failure an offline driver exists to prevent.

import type { ScrapeClock } from './clock';
import { browserUnreachable, downloadTimeout, fixtureMissing, fixtureStale } from './error-throws';
import { queryHtml } from './html-query';
import { markupRequests } from './html-requests';
import type { InterceptRules } from './intercept';
import { interceptVerdict, refusalEntry } from './intercept';
import type { PageRecording } from './recording';
import { splitDownload } from './recording';
import type { ConsoleLine, NetworkEntry } from './rings';
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

/** Typed text is an overlay keyed by `id`, then `name`, then the selector used to type it. */
const keyOf = (selector: string, element: ElementSnapshot | undefined): string => {
  if (element === undefined) return selector;
  const id = element.attrs['id'];
  if (id !== undefined) return `#${id}`;
  const name = element.attrs['name'];
  if (name !== undefined) return `[name=${name}]`;
  return selector;
};

export function htmlTarget(init: HtmlTargetInit): ScrapeTarget {
  const consoleRing = createRing<ConsoleLine>();
  const networkRing = createRing<NetworkEntry>();
  const overlay = new Map<string, string>();
  let page: PageRecording = init.start ?? EMPTY;
  let armed: string | undefined;
  let closed = false;
  let session: SessionSnapshot = init.session ?? {
    ...EMPTY_SESSION,
    cookies: init.cookies ?? [],
  };

  const live = (): void => {
    if (closed) throw browserUnreachable(init.driver, 'the offline target is already closed');
  };

  const withOverlay = (selector: string, elements: readonly ElementSnapshot[]): ElementSnapshot[] =>
    elements.map((element) => {
      const typed = overlay.get(keyOf(selector, element));
      return typed === undefined ? element : { ...element, value: typed };
    });

  const query = async (selector: string): Promise<readonly ElementSnapshot[]> => {
    live();
    return withOverlay(selector, await queryHtml(page.html, selector));
  };

  const at = (selector: string, index: number): Promise<ElementSnapshot | undefined> =>
    query(selector).then((elements) => elements[index]);

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

  const frameTarget = (html: string, url: string): ScrapeTarget => ({
    ...base,
    url: () => url,
    content: () => Promise.resolve(html),
    query: async (selector) => withOverlay(selector, await queryHtml(html, selector)),
    frames: () => Promise.resolve([]),
  });

  const base: ScrapeTarget = {
    driver: init.driver,
    console: consoleRing,
    network: networkRing,
    url: () => page.url,
    goto: (url: string, _options: GotoOptions): Promise<void> => navigate(url),
    content: (): Promise<string> => {
      live();
      return Promise.resolve(page.html);
    },
    query,
    async click(selector: string, index: number): Promise<void> {
      const element = await at(selector, index);
      if (element === undefined) throw fixtureMissing(`${page.url} ${selector}`, init.source);
      const download = page.downloads?.[selector] ?? page.downloads?.[element.attrs['id'] ?? ''];
      if (download !== undefined) armed = download;
      const href =
        element.attrs['data-goto'] ?? (element.tag === 'a' ? element.attrs['href'] : undefined);
      if (href !== undefined && href !== '') await navigate(href);
    },
    async type(selector: string, text: string): Promise<void> {
      const element = await at(selector, 0);
      const key = keyOf(selector, element);
      overlay.set(key, `${overlay.get(key) ?? element?.value ?? ''}${text}`);
    },
    async clear(selector: string): Promise<void> {
      overlay.set(keyOf(selector, await at(selector, 0)), '');
    },
    async select(selector: string, values: readonly string[]): Promise<void> {
      overlay.set(keyOf(selector, await at(selector, 0)), values[0] ?? '');
    },
    evaluate(expression: string): Promise<unknown> {
      live();
      const recorded = page.evaluate?.[expression];
      // Unrecorded and therefore refused, for the same reason an unrecorded page is: an offline
      // driver that invented an answer here would make the assertion above it meaningless.
      if (recorded === undefined)
        throw fixtureMissing(`${page.url} evaluate(${expression})`, init.source);
      return Promise.resolve(JSON.parse(recorded) as unknown);
    },
    screenshot: (_options: CaptureOptions): Promise<Uint8Array> => Promise.resolve(FAKE_PNG),
    pdf: (_options: CaptureOptions): Promise<Uint8Array> => Promise.resolve(FAKE_PDF),
    cookies: (): Promise<readonly ScrapeCookie[]> => Promise.resolve(session.cookies),
    session: (): Promise<SessionSnapshot> => Promise.resolve(session),
    restore: (next: SessionSnapshot): Promise<void> => {
      session = next;
      return Promise.resolve();
    },
    download(options: { readonly timeoutMs: number }): Promise<ScrapeDownloadFile> {
      if (armed === undefined) throw downloadTimeout(options.timeoutMs, page.url);
      const { filename, contents } = splitDownload(armed);
      armed = undefined;
      return Promise.resolve({ filename, bytes: new TextEncoder().encode(contents) });
    },
    async frames(): Promise<readonly FrameRef[]> {
      const refs: FrameRef[] = [];
      for (const element of await queryHtml(page.html, 'iframe')) {
        const name = element.attrs['name'] ?? element.attrs['id'] ?? '';
        const src = element.attrs['src'] ?? '';
        const html = page.frames?.[name] ?? page.frames?.[src];
        if (html === undefined)
          throw fixtureMissing(`${page.url} iframe ${name || src}`, init.source);
        const url = src === '' ? page.url : new URL(src, page.url).toString();
        refs.push({
          name,
          url,
          selector: element.attrs['id'] === undefined ? undefined : `#${element.attrs['id']}`,
          target: frameTarget(html, url),
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
