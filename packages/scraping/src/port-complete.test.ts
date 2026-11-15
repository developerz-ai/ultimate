// Every port method, callable on every target that declares it — the build error behind "a port
// method one target cannot honour is a second path". The call tables are keyed by the port's own
// members, so a member added to `ScrapeTarget` or `ScrapeFrameTarget` without a row here does not
// compile, and a row whose target refuses (`X_NOT_IMPLEMENTED` or anything else) fails the run.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { fakeCdpBrowser } from './cdp-fake-fixture';
import type { CdpBrowserLike, CdpPageLike } from './cdp-port';
import { cdpTarget } from './cdp-target';
import { htmlTarget } from './html-target';
import type { ScrapeFrame } from './page';
import type { PageRecording } from './recording';
import type { ScrapeFrameTarget, ScrapeTarget } from './target';

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
    frames: { login: { url: 'https://shop.test/login', html: FRAME_HTML } },
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

type FrameCalls = { readonly [K in keyof ScrapeFrameTarget]: (t: ScrapeFrameTarget) => unknown };
type PageCalls = {
  readonly [K in Exclude<keyof ScrapeTarget, keyof ScrapeFrameTarget>]: (
    t: ScrapeTarget,
    subject: Subject,
  ) => unknown;
};

const FRAME_CALLS: FrameCalls = {
  url: (t) => t.url(),
  content: (t) => t.content(),
  query: (t) => t.query('#user'),
  click: (t) => t.click('#user'),
  type: (t) => t.type('#user', 'ada'),
  clear: (t) => t.clear('#user'),
  select: (t) => t.select('#user', ['ada']),
  evaluate: (t) => t.evaluate('1 + 1'),
  press: (t) => t.press('Enter'),
  focus: (t) => t.focus('#user'),
  frames: (t) => t.frames(),
};

/** The page-wide members, in an order a session can run them in: `close` is last. */
const PAGE_CALLS: PageCalls = {
  driver: (t) => t.driver,
  console: (t) => t.console.entries(),
  network: (t) => t.network.entries(),
  pageErrors: (t) => t.pageErrors.entries(),
  goto: (t) => t.goto(URL_A, { timeoutMs: 1_000 }),
  accessibility: async (t) => {
    expect(await t.accessibility('#go', 5)).toMatchObject([{ role: 'button', name: 'Run search' }]);
  },
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
  test('the page-wide members', async () => {
    for (const subject of await subjects()) {
      expect(await refusals(PAGE_CALLS, subject.target, subject), subject.name).toEqual([]);
    }
  });

  test("the frame members, on the page and on a frame's own target", async () => {
    for (const subject of await subjects()) {
      await subject.target.goto(URL_A, { timeoutMs: 1_000 });
      const [frame] = await subject.target.frames();
      if (frame === undefined) throw expect.unreachable(`${subject.name} answered no frame`);
      // On the page too: `ScrapeTarget` extends the frame verbs, and the page answers them for its
      // own document (`#q` there, `#user` in the frame — both are typed into the same way).
      expect(await refusals(FRAME_CALLS, frame.target, subject), subject.name).toEqual([]);
    }
  });
});

/** True when `K` is a required member of `T` — absent from `T` is a compile error at the call. */
type IsRequired<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? false : true;

describe('unit · the narrowing is the type, not a runtime refusal', () => {
  test('a frame has no page-wide verb, and the CDP port requires every verb it forwards to', () => {
    // @ts-expect-error — a frame target has no accessibility read; asking does not compile
    const frameAx: ScrapeFrameTarget['accessibility'] = undefined;
    // @ts-expect-error — nor does the public frame handle
    const handleAx: ScrapeFrame['accessibility'] = undefined;
    const required: readonly true[] = [
      true satisfies IsRequired<CdpPageLike, 'keyboard'>,
      true satisfies IsRequired<CdpPageLike, 'focus'>,
      true satisfies IsRequired<CdpPageLike, 'createCDPSession'>,
      true satisfies IsRequired<CdpPageLike, 'setOfflineMode'>,
      true satisfies IsRequired<CdpPageLike, 'emulateMediaFeatures'>,
      true satisfies IsRequired<CdpPageLike, 'evaluateOnNewDocument'>,
      true satisfies IsRequired<CdpBrowserLike, 'cookies'>,
      true satisfies IsRequired<CdpBrowserLike, 'setCookie'>,
    ];
    expect([frameAx, handleAx, required.length]).toEqual([undefined, undefined, 8]);
  });
});
