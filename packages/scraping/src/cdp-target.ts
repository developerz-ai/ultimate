// `ScrapeTarget` over a real browser, through the structural CDP port. Everything driver-specific
// in this package lives here and in `driver-cdp.ts`; the vocabulary above it does not change.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { parse, t } from '@ultimat3/schema';
import type { CdpBrowserLike, CdpFrameLike, CdpPageLike, CdpRequestLike } from './cdp-port';
import { parseSnapshots, snapshotExpression } from './cdp-snapshot';
import type { ScrapeClock } from './clock';
import { browserUnreachable, pageCrashed, scrapeNotImplemented } from './error-throws';
import type { InterceptRules } from './intercept';
import { interceptVerdict, refusalEntry } from './intercept';
import type { ConsoleLine, NetworkEntry, ResourceType } from './rings';
import { createRing, RESOURCE_TYPES } from './rings';
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

const readString = (value: unknown): string | undefined =>
  typeof value === 'function'
    ? readString((value as () => unknown)())
    : typeof value === 'string'
      ? value
      : undefined;

export interface CdpTargetInit {
  readonly page: CdpPageLike;
  readonly browser: CdpBrowserLike;
  readonly rules: InterceptRules;
  readonly clock: ScrapeClock;
  readonly ringCapacity?: number | undefined;
}

/**
 * Interception is armed BEFORE the first navigation and refuses at the request, not after the
 * response — an `allowHosts` that reported afterwards would be a log line about bytes that
 * already left the container.
 */
async function arm(
  init: CdpTargetInit,
  network: ReturnType<typeof createRing<NetworkEntry>>,
  console_: ReturnType<typeof createRing<ConsoleLine>>,
  crashed: { value: string | undefined },
): Promise<void> {
  await init.page.setRequestInterception(true);
  init.page.on('request', (payload) => {
    const request = asRequest(payload);
    if (request === undefined) return;
    const url = request.url();
    const type = asResourceType(request.resourceType());
    const verdict = interceptVerdict(url, type, init.rules);
    const at = init.clock.now().getTime();
    if (verdict === 'allow') {
      network.push({ method: 'GET', url, resourceType: type, at });
      void request.continue();
      return;
    }
    network.push(refusalEntry(url, type, verdict, at));
    void request.abort();
  });
  init.page.on('console', (payload) => {
    const record = payload as { type?: unknown; text?: unknown };
    console_.push({
      level: 'log',
      text: readString(record.text) ?? '',
      at: init.clock.now().getTime(),
    });
  });
  // A renderer that dies must be a CODE, not a hang: every later call answers X_SCRAPE_PAGE_CRASHED
  // instead of waiting out its own timeout against a tab that is gone.
  init.page.on('error', (payload) => {
    crashed.value = readString((payload as { message?: unknown }).message) ?? 'renderer crashed';
  });
}

export async function cdpTarget(init: CdpTargetInit): Promise<ScrapeTarget> {
  const console_ = createRing<ConsoleLine>(init.ringCapacity);
  const network = createRing<NetworkEntry>(init.ringCapacity);
  const crashed: { value: string | undefined } = { value: undefined };
  await arm(init, network, console_, crashed);

  const live = (): void => {
    if (crashed.value !== undefined) throw pageCrashed(init.page.url());
  };

  const guard = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    live();
    try {
      return await run();
    } catch (thrown) {
      live();
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
    url: () => init.page.url(),
    goto: (url: string, options: GotoOptions) =>
      guard('goto', async () => {
        await init.page.goto(url, { timeout: options.timeoutMs });
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
    download: (_options): Promise<ScrapeDownloadFile> => {
      // Honest stub, in the shape `packages/jobs/src/driver-redis.ts` uses. A real one needs
      // `Browser.setDownloadBehavior` over a raw CDP session plus a directory watch, and a
      // half-written version that silently returned empty bytes is worse than this line.
      throw scrapeNotImplemented(
        'download() on the puppeteer driver',
        'fetch the file inside the page — page.evaluate("fetch(url).then(r => r.text())") — or run this scrape on fixtureBrowser(), whose download() is complete',
      );
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
        const source = init.browser as {
          setCookie?: (...cookies: readonly unknown[]) => Promise<void>;
        };
        if (typeof source.setCookie === 'function' && session.cookies.length > 0) {
          await source.setCookie(...session.cookies);
        }
        if (Object.keys(session.storage).length > 0) {
          await init.page.evaluate(
            `(() => { const entries = ${JSON.stringify(session.storage)}; for (const key of Object.keys(entries)) localStorage.setItem(key, entries[key]); })()`,
          );
        }
      }),
    close: async (): Promise<void> => {
      await init.page.close();
    },
  };
  return target;
}
