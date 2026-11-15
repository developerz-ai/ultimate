// Every port method, callable on every target that declares it — the build error behind "a port
// method one target cannot honour is a second path". The call tables are keyed by the port's own
// members, so a member added to `ScrapeTarget` without a row here does not compile, and a row whose
// target refuses (`X_NOT_IMPLEMENTED` or anything else) fails the run — on a page and on a frame.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { fakeCdpBrowser } from './cdp-fake-fixture';
import type { CdpBrowserLike, CdpPageLike, CompleteCdpBrowser, CompleteCdpPage } from './cdp-port';
import { cdpTarget } from './cdp-target';
import { htmlTarget } from './html-target';
import type { PageRecording } from './recording';
import type { ScrapeTarget } from './target';

const URL_A = 'https://shop.test/search';
const HTML_A = `<html><body>
  <label for="q">Search orders</label><input id="q" name="q">
  <select id="sort"><option value="new">Newest</option></select>
  <button id="go" aria-label="Run search">Go</button>
  <button id="export" type="button">Export</button>
  <iframe name="login" src="/login"></iframe>
</body></html>`;
const FRAME_HTML = '<input id="user" name="user">';

const recording: PageRecording = {
  url: URL_A,
  html: HTML_A,
  evaluate: { '1 + 1': '2' },
  frames: { login: FRAME_HTML },
  downloads: { '#export': 'orders.csv:a,b' },
};

interface Subject {
  readonly name: string;
  readonly target: ScrapeTarget;
  /** Makes the browser produce a file, the way the driver's own trigger would. */
  readonly trigger: () => Promise<void>;
}

const html = (): Subject => {
  const target = htmlTarget({
    driver: 'fake',
    lookup: (url) => Promise.resolve(url === URL_A ? recording : undefined),
    rules: { allowHosts: ['shop.test'] },
    clock: frozenClock(),
    source: 'port-complete',
  });
  return { name: 'fake', target, trigger: () => target.click('#export') };
};

const cdp = async (): Promise<Subject> => {
  const browser = fakeCdpBrowser({
    url: 'about:blank',
    html: HTML_A,
    frames: {
      login: {
        url: 'https://shop.test/login',
        html: FRAME_HTML,
        accessibility: { '#user': [{ role: 'textbox', name: '', ignored: false }] },
      },
    },
    accessibility: { '#go': [{ role: 'button', name: 'Run search', ignored: false }] },
  });
  const target = await cdpTarget({
    browser,
    page: await browser.newPage(),
    rules: { allowHosts: ['shop.test'] },
    clock: frozenClock(),
  });
  return {
    name: 'puppeteer',
    target,
    trigger: () =>
      browser.emitDownload({
        url: 'https://shop.test/export.csv',
        filename: 'orders.csv',
        body: 'a,b',
        contentType: 'text/csv',
        disposition: 'attachment; filename="orders.csv"',
      }),
  };
};

/** The members that address a DOCUMENT — the ones a frame target answers from its own. */
type DocumentVerb =
  | 'url'
  | 'content'
  | 'query'
  | 'click'
  | 'type'
  | 'clear'
  | 'select'
  | 'evaluate'
  | 'press'
  | 'focus'
  | 'accessibility'
  | 'frames';
type DocumentCalls = { readonly [K in DocumentVerb]: (t: ScrapeTarget) => unknown };
type PageCalls = {
  readonly [K in Exclude<keyof ScrapeTarget, DocumentVerb>]: (
    t: ScrapeTarget,
    subject: Subject,
  ) => unknown;
};

/** The document members against one element of that document, and the role it must read as. */
const documentCalls = (selector: string, role: string): DocumentCalls => ({
  url: (t) => t.url(),
  content: (t) => t.content(),
  query: (t) => t.query(selector),
  click: (t) => t.click(selector),
  type: (t) => t.type(selector, 'ada'),
  clear: (t) => t.clear(selector),
  select: (t) => t.select(selector, ['ada']),
  evaluate: (t) => t.evaluate('1 + 1'),
  press: (t) => t.press('Enter'),
  focus: (t) => t.focus(selector),
  accessibility: async (t) => {
    expect(await t.accessibility(selector, 5)).toMatchObject([{ role }]);
  },
  frames: (t) => t.frames(),
});

/** The page-wide members, in an order a session can run them in: `close` is last. */
const PAGE_CALLS: PageCalls = {
  driver: (t) => t.driver,
  console: (t) => t.console.entries(),
  network: (t) => t.network.entries(),
  pageErrors: (t) => t.pageErrors.entries(),
  goto: (t) => t.goto(URL_A, { timeoutMs: 1_000 }),
  setOfflineMode: async (t) => {
    await t.setOfflineMode(true);
    await t.setOfflineMode(false);
  },
  setColorScheme: (t) => t.setColorScheme('dark'),
  prepare: (t) => t.prepare('window.__seed = 1'),
  screenshot: (t) => t.screenshot({ fullPage: true }),
  pdf: (t) => t.pdf({}),
  cookies: (t) => t.cookies(),
  download: async (t, subject) => {
    await subject.trigger();
    const file = await t.download({ timeoutMs: 1_000 });
    expect([file.filename, new TextDecoder().decode(file.bytes)]).toEqual(['orders.csv', 'a,b']);
  },
  session: (t) => t.session(),
  restore: async (t) => t.restore(await t.session()),
  close: (t) => t.close(),
};

const codeOf = (thrown: unknown): string =>
  typeof thrown === 'object' && thrown !== null && 'code' in thrown
    ? String(thrown.code)
    : String(thrown);

/** Every row, run; the failures are collected so one run names every member a target refused. */
const refusals = async <T, C extends Record<string, (t: T, s: Subject) => unknown>>(
  calls: C,
  target: T,
  subject: Subject,
): Promise<readonly string[]> => {
  const out: string[] = [];
  for (const [member, call] of Object.entries(calls)) {
    try {
      await call(target, subject);
    } catch (thrown) {
      out.push(`${member}: ${codeOf(thrown)}`);
    }
  }
  return out;
};

const subjects = async (): Promise<readonly Subject[]> => [html(), await cdp()];

describe('unit · every ScrapeTarget member answers on every target', () => {
  test('the page-wide members, after the document members on the page itself', async () => {
    for (const subject of await subjects()) {
      await subject.target.goto(URL_A, { timeoutMs: 1_000 });
      const onPage = documentCalls('#go', 'button');
      expect(await refusals(onPage, subject.target, subject), subject.name).toEqual([]);
      expect(await refusals(PAGE_CALLS, subject.target, subject), subject.name).toEqual([]);
    }
  });

  test("the document members, on a frame's own target — accessibility included", async () => {
    for (const subject of await subjects()) {
      await subject.target.goto(URL_A, { timeoutMs: 1_000 });
      // By name: a browser lists the MAIN frame first, and the offline drivers do not list it.
      const frame = (await subject.target.frames()).find((ref) => ref.name === 'login');
      if (frame === undefined) throw expect.unreachable(`${subject.name} answered no frame`);
      // `#user` exists only in the frame, so a verb that reached the PARENT document fails here.
      const inFrame = documentCalls('#user', 'textbox');
      expect(await refusals(inFrame, frame.target, subject), subject.name).toEqual([]);
    }
  });
});

/** True when `K` is a required member of `T` — absent from `T` is a compile error at the call. */
type IsRequired<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? false : true;

describe('unit · the launcher port: optional for an app, complete for the built-ins', () => {
  test('CdpPageLike leaves each verb optional; the Complete types require every one', () => {
    const checks: readonly boolean[] = [
      // Optional, so a launcher written against 31.x still compiles — and is checked at open.
      false satisfies IsRequired<CdpPageLike, 'keyboard'>,
      false satisfies IsRequired<CdpPageLike, 'setOfflineMode'>,
      false satisfies IsRequired<CdpBrowserLike, 'cookies'>,
      true satisfies IsRequired<CompleteCdpPage, 'keyboard'>,
      true satisfies IsRequired<CompleteCdpPage, 'focus'>,
      true satisfies IsRequired<CompleteCdpPage, 'createCDPSession'>,
      true satisfies IsRequired<CompleteCdpPage, 'setOfflineMode'>,
      true satisfies IsRequired<CompleteCdpPage, 'emulateMediaFeatures'>,
      true satisfies IsRequired<CompleteCdpPage, 'evaluateOnNewDocument'>,
      true satisfies IsRequired<CompleteCdpBrowser, 'cookies'>,
      true satisfies IsRequired<CompleteCdpBrowser, 'setCookie'>,
    ];
    expect(checks.length).toBe(11);
  });
});
