// One question, one answer, whichever DRIVER is asked. `fakeBrowser` is what every test in every
// app runs against, `fixtureBrowser` is what a recorded suite runs against, and the puppeteer
// driver is what production runs against — so a semantic only one of them holds is a guarantee
// that passes CI and fails on deploy.
//
// This is the highest-value file in the package: it is what stops the fake drifting from the real
// one. Where the three genuinely CANNOT agree — a parsed HTML string has no layout engine, so no
// box and no hit-target — the divergence is pinned HERE, in one place, with the reason.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fakeCdpLauncher } from './cdp-fake';
import { testClock } from './clock';
import type { ScrapeDriver, ScrapeSession } from './driver';
import { localBrowser } from './driver-cdp';
import { fakeBrowser } from './driver-fake';
import { fixtureBrowser, recordingFilename } from './driver-fixture';
import { httpRecordingFilename } from './http-recorded';
import type { PageRecording } from './recording';

const URL_A = 'https://shop.test/orders';
const URL_B = 'https://shop.test/orders/2';
const HTML_A = `<html><body>
  <h1 id="title">Orders</h1>
  <ul><li class="row" data-id="1">One</li><li class="row" data-id="2">Two</li></ul>
  <button id="next" data-goto="/orders/2">Next</button>
  <button class="go" data-goto="/orders/2">Go first</button>
  <button class="go" data-goto="/orders/nowhere">Go second</button>
  <button id="pay" disabled>Pay</button>
  <img src="https://tracker.test/pixel.gif">
</body></html>`;
const HTML_B = '<html><body><h1 id="title">Page two</h1></body></html>';
const API = 'https://shop.test/api/orders?page=1';

const PAGES: readonly PageRecording[] = [
  { url: URL_A, html: HTML_A },
  { url: URL_B, html: HTML_B },
];
const HTTP = [{ url: API, method: 'GET', status: 200, body: '{"orders":[{"id":1}]}' }];

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(`${tmpdir()}/ultimate-scrape-parity-`);
  for (const page of PAGES) {
    await writeFile(`${dir}/${recordingFilename(page.url)}`, JSON.stringify(page));
  }
  for (const recording of HTTP) {
    await writeFile(
      `${dir}/${httpRecordingFilename(recording.method, recording.url)}`,
      JSON.stringify(recording),
    );
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const open = (driver: ScrapeDriver): Promise<ScrapeSession> =>
  driver.open({
    name: 'orders',
    rules: { allowHosts: ['shop.test'], block: ['image'] },
    clock: testClock(),
    timeoutMs: 5_000,
  });

/** The two offline drivers plus the real driver's code path over an injected CDP browser. */
const drivers = (): readonly (readonly [string, ScrapeDriver])[] => [
  ['fake', fakeBrowser(PAGES, { http: HTTP })],
  ['fixture', fixtureBrowser(dir)],
  [
    'puppeteer',
    localBrowser({
      launcher: fakeCdpLauncher({
        url: URL_A,
        html: HTML_A,
        routes: {
          '#next': { url: URL_B, html: HTML_B },
          // Keyed by SELECTOR, not by element: this fake has no DOM index for clicks, which is
          // exactly why the `index` divergence below could hide from every existing test.
          '.go': { url: URL_B, html: HTML_B },
        },
        covered: ['#covered'],
      }),
    }),
  ],
];

const forEachDriver = async (
  run: (session: ScrapeSession, name: string) => Promise<void>,
): Promise<void> => {
  for (const [name, driver] of drivers()) {
    const session = await open(driver);
    try {
      await run(session, name);
    } finally {
      await session.close();
    }
  }
};

describe('unit · every driver answers the vocabulary the same way', () => {
  test('text, values and count read the same document on all three', async () => {
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      expect(await session.page.text('#title'), name).toBe('Orders');
      expect(await session.page.count('.row'), name).toBe(2);
      const rows = await session.page.values('.row');
      expect(
        rows.map((row) => [row.text, row.attrs['data-id']]),
        name,
      ).toEqual([
        ['One', '1'],
        ['Two', '2'],
      ]);
    });
  });

  /**
   * `ScrapeTarget.click` took a second `index` argument that `html-target.ts` honoured
   * (`at(selector, index)`) and `cdp-target.ts` silently dropped — its implementations are
   * `click: (selector) => …`, so puppeteer clicked the first match whatever was asked for. They
   * agreed only because the sole production caller, `page-over-target.ts`, always passed `0`.
   *
   * The parameter is deleted rather than implemented in the second driver: no public vocabulary
   * can set it (`ScrapeFrame.click(selector, options?: WaitOptions)` has no index), so it was a
   * port member no app could reach and one driver ignored. This is the test that would have
   * caught the divergence — a multi-match selector, driven through the page, on all three.
   */
  test('a multi-match selector clicks the FIRST match on all three', async () => {
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      await session.page.click('.go');
      // The first `.go` goes to /orders/2; the second points at a URL no recording covers, so an
      // offline driver that clicked it raises `X_SCRAPE_FIXTURE_MISSING` instead of landing here.
      // The puppeteer path routes by selector and cannot tell the two apart — that blindness is
      // the reason the divergence survived, and it is why the port no longer carries an `index`
      // for one driver to honour and the other to drop.
      expect(await session.page.text('#title'), name).toBe('Page two');
    });
  });

  test('a disabled control is refused with X_SCRAPE_NOT_ACTIONABLE on all three', async () => {
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      let code: string | undefined;
      try {
        await session.page.click('#pay', { timeout: 50 });
      } catch (thrown) {
        code = (thrown as { code?: string }).code;
      }
      expect(code, name).toBe('X_SCRAPE_NOT_ACTIONABLE');
    });
  });

  test('a missing selector is X_SCRAPE_SELECTOR_MISSING on all three', async () => {
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      let code: string | undefined;
      try {
        await session.page.waitFor('#nothing', { timeout: 50 });
      } catch (thrown) {
        code = (thrown as { code?: string }).code;
      }
      expect(code, name).toBe('X_SCRAPE_SELECTOR_MISSING');
    });
  });

  /**
   * `ScrapeTarget.url()` is live on all three drivers, and `pageOverTarget` used to answer from a
   * frame-local `lastUrl` that only a `waitFor` refreshed — so `page.url()` answered `about:blank`
   * after a `goto`. `x shot` reads it as `finalUrl` and so called every route a redirect to
   * `about:blank`; `auth.ts` handed the same string to a `PromptHandler`. Nothing asserted on it.
   */
  test('page.url() answers the navigated URL, before and after a click, on all three', async () => {
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      expect(session.page.url(), name).toBe(URL_A);
      // Read again after an operation that navigates NOTHING: a `url()` that only refreshes on a
      // wait would pass the line above and fail here if the two were wired the other way round.
      expect(await session.page.text('#title'), name).toBe('Orders');
      expect(session.page.url(), name).toBe(URL_A);
      await session.page.click('#next');
      expect(session.page.url(), name).toBe(URL_B);
    });
  });

  test('a click that navigates lands on the same page on all three', async () => {
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      await session.page.click('#next');
      expect(await session.page.text('#title'), name).toBe('Page two');
    });
  });

  test('a host allowHosts does not list is REFUSED before the navigation, on all three', async () => {
    await forEachDriver(async (session, name) => {
      let code: string | undefined;
      try {
        await session.page.goto('https://evil.test/');
      } catch (thrown) {
        code = (thrown as { code?: string }).code;
      }
      expect(code, name).toBe('X_SCRAPE_HOST_BLOCKED');
    });
  });

  test('the HTTP leg enforces the SAME allow list — the guarantee has no second door', async () => {
    await forEachDriver(async (session, name) => {
      let code: string | undefined;
      try {
        await session.http.request('https://evil.test/api');
      } catch (thrown) {
        code = (thrown as { code?: string }).code;
      }
      expect(code, name).toBe('X_SCRAPE_HOST_BLOCKED');
    });
  });
});

describe('unit · where the drivers genuinely cannot agree, pinned in one place', () => {
  test('only a real layout engine answers box and hitTarget', async () => {
    const boxes: Record<string, boolean> = {};
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      const [row] = await session.page.values('.row');
      expect(row, name).toBeDefined();
      const snapshot = await session.page.waitFor('#title', { state: 'attached' });
      boxes[name] = snapshot.box !== undefined;
    });
    // The offline drivers parse markup; nothing is laid out, so they answer `undefined` rather
    // than a fabricated `{ x: 0, y: 0 }` — which is what would make a covered button read as
    // clickable in the only suite that could have caught it. `actionability.ts` treats an unknown
    // hit-target as unknown, never as covered.
    expect(boxes).toEqual({ fake: false, fixture: false, puppeteer: true });
  });

  test('every driver ANSWERS pageErrors(); only a JS engine can ever fill it', async () => {
    // The divergence, pinned beside the box one: `fake` and `fixture` parse markup and execute
    // none of it, so nothing there can throw an uncaught exception — but the method answers on all
    // three, or `page.pageErrors()` would be a call an author has to know their driver to make.
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      expect(session.page.pageErrors(), name).toEqual([]);
      expect(session.page.pageErrorsDropped(), name).toBe(0);
    });
  });

  test('SessionSnapshot.headers is answerable OFFLINE and empty on the real driver', async () => {
    const restore = {
      cookies: [],
      headers: { 'x-csrf': 'tok' },
      storage: {},
      userAgent: 'agent',
      origin: 'https://shop.test',
    };
    const withRestore = (driver: ScrapeDriver): Promise<ScrapeSession> =>
      driver.open({
        name: 'orders',
        rules: { allowHosts: ['shop.test'], block: ['image'] },
        clock: testClock(),
        timeoutMs: 5_000,
        restore,
      });
    const offline = await withRestore(fakeBrowser(PAGES, { http: HTTP }));
    const real = await withRestore(
      localBrowser({ launcher: fakeCdpLauncher({ url: URL_A, html: HTML_A }) }),
    );
    try {
      expect((await offline.page.session()).headers).toEqual({ 'x-csrf': 'tok' });
      // PINNED, and it is a divergence rather than a bug: CDP exposes no "headers this site now
      // expects" to read back. The alternative considered was capturing observed request headers —
      // rejected, because that persists a `cookie`/`authorization` into the session record and
      // `httpOverFetch` spreads `session.headers` onto EVERY allowed host, which is a wider leak
      // than the empty field. So a fixture may assert on headers the real driver will not send:
      // put a token the HTTP leg must carry in the request's own `headers`, never in the session.
      expect((await real.page.session()).headers).toEqual({});
    } finally {
      await offline.close();
      await real.close();
    }
  });

  test('only the offline drivers refuse an unrecorded request', async () => {
    const fixture = await open(fixtureBrowser(dir));
    try {
      let code: string | undefined;
      try {
        await fixture.http.request('https://shop.test/api/unrecorded');
      } catch (thrown) {
        code = (thrown as { code?: string }).code;
      }
      // The rule an offline driver exists for: never a pass-through to the network.
      expect(code).toBe('X_SCRAPE_FIXTURE_MISSING');
    } finally {
      await fixture.close();
    }
  });
});

describe('unit · one fixture directory replays both legs of a hybrid run', () => {
  test('browser walk, then the JSON endpoint behind it', async () => {
    for (const driver of [fakeBrowser(PAGES, { http: HTTP }), fixtureBrowser(dir)]) {
      const session = await open(driver);
      try {
        await session.page.goto(URL_A);
        expect(await session.page.count('.row')).toBe(2);
        const response = await session.http.request(API);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ orders: [{ id: 1 }] });
      } finally {
        await session.close();
      }
    }
  });
});
