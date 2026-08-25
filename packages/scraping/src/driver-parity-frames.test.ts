// The FRAME half of driver parity: one question, one answer, whichever driver is asked — for
// every verb reached through a `ScrapeFrame` handle.
//
// Its own file because `driver-parity.test.ts` is at the 500-line ceiling, and because the fixture
// is different in kind: a parent document and an iframe carrying the SAME ids, which is the only
// shape in which a frame verb aimed at the parent document is visible at all.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fakeCdpLauncher } from './cdp-fake';
import { testClock } from './clock';
import type { ScrapeDriver, ScrapeSession } from './driver';
import { localBrowser } from './driver-cdp';
import { fakeBrowser } from './driver-fake';
import { fixtureBrowser, recordingFilename } from './driver-fixture';
import type { PageRecording } from './recording';

const URL_ORDERS = 'https://shop.test/orders/2';

/**
 * A parent document and an iframe that carry the SAME ids — which is the shape an iframe'd SSO
 * login has, and the only shape in which a frame verb aimed at the parent is visible at all. A
 * frame-only id passes `waitFor` on the frame and then acts on nothing, so it hides the defect.
 */
const URL_LOGIN = 'https://shop.test/login';
const URL_IDP = 'https://shop.test/idp';
const HTML_LOGIN = `<html><body>
  <input id="q" name="q" value="page-value">
  <select id="s"><option value="p1">P1</option></select>
  <button id="go" data-goto="/orders/2">Leave</button>
  <iframe name="idp" src="/idp"></iframe>
</body></html>`;
// `#go` here does NOT navigate; the parent's does. A frame click resolved against the parent's
// markup therefore moves the whole page, which is what the pin below refuses.
const HTML_IDP =
  '<input id="q" name="q" value="frame-value"><select id="s"><option value="f1">F1</option></select><button id="go">Stay</button>';

const PAGES: readonly PageRecording[] = [
  { url: URL_LOGIN, html: HTML_LOGIN, frames: { idp: HTML_IDP } },
  { url: URL_ORDERS, html: '<html><body><h1 id="title">Page two</h1></body></html>' },
];

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(`${tmpdir()}/ultimate-scrape-frames-`);
  for (const page of PAGES) {
    await writeFile(`${dir}/${recordingFilename(page.url)}`, JSON.stringify(page));
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The two offline drivers plus the real driver's code path over an injected CDP browser. */
const drivers = (): readonly (readonly [string, ScrapeDriver])[] => [
  ['fake', fakeBrowser(PAGES)],
  ['fixture', fixtureBrowser(dir)],
  [
    'puppeteer',
    localBrowser({
      launcher: fakeCdpLauncher({
        url: URL_LOGIN,
        html: HTML_LOGIN,
        frames: { idp: { url: URL_IDP, html: HTML_IDP } },
      }),
    }),
  ],
];

const forEachFrameDriver = async (
  run: (session: ScrapeSession, name: string) => Promise<void>,
): Promise<void> => {
  for (const [name, driver] of drivers()) {
    const session = await driver.open({
      name: 'login',
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
      timeoutMs: 5_000,
    });
    try {
      await run(session, name);
    } finally {
      await session.close();
    }
  }
};

/**
 * The class `driver-parity.test.ts` exists for, on the half it did not cover until 2026-08-24: a
 * frame target is built by SPREADING the parent's, so every verb somebody forgets to override
 * silently acts on the parent document. `clear` was the one missed on the CDP side — so
 * `frame.fill()` emptied the PARENT's same-named field and merely appended to the frame's — and
 * all four act-verbs were missed offline, where one shared overlay meant a value typed into a
 * frame read back out of the page.
 *
 * An iframe'd SSO login is the case that makes it a security finding rather than a correctness
 * one: `page.frame('idp').fill('#password', secrets.get('PW'))` is the documented spelling.
 */
describe('unit · a frame verb reaches the FRAME and never the parent document', () => {
  test('fill inside a frame replaces the FRAME field and leaves the parent untouched', async () => {
    await forEachFrameDriver(async (session, name) => {
      await session.page.goto(URL_LOGIN);
      await session.page.frame('idp').fill('#q', 'typed');
      // Replaced, not appended: a `fill` that appends turns a remembered username into
      // `oldUserNEWUSER` and the login fails.
      expect((await session.page.frame('idp').values('#q'))[0]?.value, name).toBe('typed');
      expect((await session.page.values('#q'))[0]?.value, name).toBe('page-value');
    });
  });

  test('type inside a frame appends to the FRAME value, never to the parent`s', async () => {
    await forEachFrameDriver(async (session, name) => {
      await session.page.goto(URL_LOGIN);
      await session.page.frame('idp').type('#q', '-more');
      expect((await session.page.frame('idp').values('#q'))[0]?.value, name).toBe(
        'frame-value-more',
      );
      expect((await session.page.values('#q'))[0]?.value, name).toBe('page-value');
    });
  });

  test('select inside a frame sets the FRAME control, never the parent`s', async () => {
    await forEachFrameDriver(async (session, name) => {
      await session.page.goto(URL_LOGIN);
      await session.page.frame('idp').select('#s', ['f1']);
      expect((await session.page.frame('idp').values('#s'))[0]?.value, name).toBe('f1');
      expect((await session.page.values('#s'))[0]?.value, name).toBe('');
    });
  });

  /**
   * A click inside a frame never moves the PARENT, on any driver. Offline it used to: the frame
   * inherited `base.click`, which resolved the selector against the parent's markup and followed
   * that element's `data-goto` — so a click on a frame button navigated the whole page.
   *
   * What no offline driver can do is navigate the FRAME either: a `PageRecording.frames` entry is
   * one static document, so there is no second frame document to land on. Pinned here beside the
   * box/hit-target divergence rather than left silent.
   */
  test('a click inside a frame leaves the PARENT where it was, on all three', async () => {
    await forEachFrameDriver(async (session, name) => {
      await session.page.goto(URL_LOGIN);
      await session.page.frame('idp').click('#go');
      expect(session.page.url(), name).toBe(URL_LOGIN);
      expect((await session.page.values('#q'))[0]?.value, name).toBe('page-value');
    });
  });

  test('a frame reads its OWN document before anything is typed into it', async () => {
    await forEachFrameDriver(async (session, name) => {
      await session.page.goto(URL_LOGIN);
      expect((await session.page.frame('idp').values('#q'))[0]?.value, name).toBe('frame-value');
      expect((await session.page.values('#q'))[0]?.value, name).toBe('page-value');
    });
  });
});

describe('unit · query() through a frame handle reads the frame`s document', () => {
  /** The half that matters: a frame`s `query` resolves against the FRAME`s document. */
  test('frame.query reads the frame`s own document, not the parent`s', async () => {
    await forEachFrameDriver(async (session, name) => {
      await session.page.goto(URL_LOGIN);
      expect((await session.page.frame('idp').query('#q'))[0]?.value, name).toBe('frame-value');
      expect((await session.page.query('#q'))[0]?.value, name).toBe('page-value');
      await session.page.frame('idp').fill('#q', 'typed');
      expect((await session.page.frame('idp').query('#q'))[0]?.value, name).toBe('typed');
      expect((await session.page.query('#q'))[0]?.value, name).toBe('page-value');
    });
  });
});
