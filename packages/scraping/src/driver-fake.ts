// The DEFAULT driver under `bun test`: no process, no port, no CDP, no Chrome. A scraper's tests
// are the point of this package, and a test suite that needs a browser installed is a test suite
// that runs on one machine.
//
// It covers BOTH legs. `fakeBrowser({ pages, http })` replays the browser walk and the JSON
// endpoints behind it from one declaration, so a hybrid scrape is tested the way it runs.

import { finiteCount } from '@ultimat3/core';
import type { ScrapeClock } from './clock';
import { systemScrapeClock } from './clock';
import type { ScrapeDriver, ScrapeSession, SessionInit } from './driver';
import { htmlTarget } from './html-target';
import { httpRecordingsOf } from './http-recorded';
import { openOfflineSession } from './offline-session';
import type { ScrapePage } from './page';
import type { PageContext } from './page-over-target';
import { pageOverTarget } from './page-over-target';
import type { HttpRecording, PageRecording } from './recording';
import type { SessionSnapshot } from './session-state';
import type { ScrapeCookie } from './target';

export const FAKE_DRIVER = 'fake';

/** `{ 'https://example.com/': '<html>…' }`, or full recordings when a page needs frames. */
export type FakePages = Readonly<Record<string, string>> | readonly PageRecording[];

const normalise = (url: string): string => {
  try {
    const parsed = new URL(url);
    // `https://example.com` and `https://example.com/` are one page to every browser, and two
    // keys to a `Map` — which is a `X_SCRAPE_FIXTURE_MISSING` for a page the author did record.
    if (parsed.pathname === '') parsed.pathname = '/';
    return parsed.toString();
  } catch {
    return url;
  }
};

export function recordingsOf(pages: FakePages): readonly PageRecording[] {
  return Array.isArray(pages)
    ? (pages as readonly PageRecording[])
    : Object.entries(pages as Readonly<Record<string, string>>).map(([url, html]) => ({
        url,
        html,
      }));
}

export interface FakeBrowserOptions {
  readonly cookies?: readonly ScrapeCookie[] | undefined;
  /** What `page.session()` answers — the browser-to-HTTP handoff, as data a test can assert on. */
  readonly session?: SessionSnapshot | undefined;
  /** The JSON endpoints the hybrid leg calls. An unrecorded one throws, like an unrecorded page. */
  readonly http?: readonly HttpRecording[] | undefined;
}

/**
 * An in-memory site. Every request it cannot answer — page or HTTP — THROWS
 * `X_SCRAPE_FIXTURE_MISSING`, never a pass-through to the network, which is the one behaviour
 * that would make an offline suite secretly live.
 */
export function fakeBrowser(pages: FakePages, options: FakeBrowserOptions = {}): ScrapeDriver {
  const byUrl = new Map(recordingsOf(pages).map((page) => [normalise(page.url), page]));
  const byRequest = httpRecordingsOf(options.http ?? []);
  return {
    name: FAKE_DRIVER,
    open: (session: SessionInit): Promise<ScrapeSession> =>
      openOfflineSession({
        driver: FAKE_DRIVER,
        source: 'fakeBrowser()',
        lookup: (url) => Promise.resolve(byUrl.get(normalise(url))),
        http: (method, url) => Promise.resolve(byRequest.get(`${method} ${url}`)),
        session,
        cookies: options.cookies,
        snapshot: options.session,
      }),
  };
}

export interface FakePageOptions {
  readonly url?: string | undefined;
  readonly clock?: ScrapeClock | undefined;
  readonly allowHosts?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly context?: Partial<PageContext> | undefined;
  /** Extra pages this one can navigate to — `data-goto` and `<a href>` both land here. */
  readonly pages?: FakePages | undefined;
  readonly session?: SessionSnapshot | undefined;
}

export const FAKE_PAGE_URL = 'https://fake.test/';

/**
 * One page of markup as a `ScrapePage`, for a test that wants to assert on the vocabulary and
 * nothing else. No session and no driver: `page.html()`, `page.click()` and `page.values()` are
 * the whole surface under test.
 */
export function fakePage(dom: string, options: FakePageOptions = {}): ScrapePage {
  const url = options.url ?? FAKE_PAGE_URL;
  const start: PageRecording = { url, html: dom };
  const clock = options.clock ?? systemScrapeClock;
  const allowHosts = options.allowHosts ?? ['*'];
  const byUrl = new Map(
    [start, ...recordingsOf(options.pages ?? [])].map((page) => [normalise(page.url), page]),
  );
  const target = htmlTarget({
    driver: FAKE_DRIVER,
    lookup: (next) => Promise.resolve(byUrl.get(normalise(next))),
    rules: { allowHosts },
    clock,
    source: 'fakePage()',
    start,
    session: options.session,
  });
  return pageOverTarget(target, {
    clock,
    allowHosts,
    // The default budget for every wait AND every navigation on this page, so the floor is 1: a
    // session default of 0 is already out of time everywhere, which a per-call `{ timeout: 0 }` —
    // "is it there right now" — is not. Non-finite is the loop that never leaves.
    defaultTimeoutMs: finiteCount('fakePage', 'timeoutMs', options.timeoutMs ?? 1_000, 1),
    ...options.context,
  });
}
