// The KEYBOARD and ACCESSIBILITY half of driver parity: `press`, `focus` and `accessibility`, one
// answer whichever driver is asked — and where the three genuinely cannot agree, the divergence
// pinned here with its reason, beside the box/hit-target one `driver-parity.test.ts` carries.
//
// Its own file because `driver-parity.test.ts` is at the 500-line ceiling.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API, so mkdtemp/rm/writeFile come from node:fs.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { fakeCdpLauncher } from './cdp-fake';
import { testClock } from './clock';
import type { ScrapeDriver, ScrapeSession } from './driver';
import { localBrowser } from './driver-cdp';
import { fakeBrowser } from './driver-fake';
import { fixtureBrowser, recordingFilename } from './driver-fixture';
import type { PageRecording } from './recording';
import type { AxNode } from './target';

const URL_A = 'https://shop.test/search';
const HTML_A = `<html><body>
  <input id="q" name="q" placeholder="Search">
  <button id="go" aria-label="Run search">Go</button>
  <div id="fake-button" onclick="go()">Looks clickable</div>
</body></html>`;

const PAGES: readonly PageRecording[] = [{ url: URL_A, html: HTML_A }];

/** What the browser WOULD compute — canned, because a fake cannot compute a role honestly. */
const AX: Readonly<Record<string, readonly AxNode[]>> = {
  '#go': [{ role: 'button', name: 'Run search', ignored: false, focused: false }],
  '#fake-button': [{ role: '', name: '', ignored: false }],
};

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(`${tmpdir()}/ultimate-scrape-keys-`);
  for (const page of PAGES) {
    await writeFile(`${dir}/${recordingFilename(page.url)}`, JSON.stringify(page));
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const launcher = () => fakeCdpLauncher({ url: URL_A, html: HTML_A, accessibility: AX });

const drivers = (): readonly (readonly [string, ScrapeDriver])[] => [
  ['fake', fakeBrowser(PAGES)],
  ['fixture', fixtureBrowser(dir)],
  ['puppeteer', localBrowser({ launcher: launcher() })],
];

const open = (driver: ScrapeDriver): Promise<ScrapeSession> =>
  driver.open({
    name: 'search',
    rules: { allowHosts: ['shop.test'] },
    clock: testClock(),
    timeoutMs: 5_000,
  });

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

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · focus() and press() agree on every driver', () => {
  test('a focus on a present control resolves on all three', async () => {
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      await expect(session.page.focus('#q'), name).resolves.toBeUndefined();
    });
  });

  test('a focus on a missing selector is X_SCRAPE_SELECTOR_MISSING on all three', async () => {
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      expect(await codeOf(() => session.page.focus('#nothing', { timeout: 50 })), name).toBe(
        'X_SCRAPE_SELECTOR_MISSING',
      );
    });
  });

  test('a well-formed chord resolves on all three — the offline drivers parse it and stop', async () => {
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      await expect(session.page.press('Meta+K'), name).resolves.toBeUndefined();
      await expect(session.page.press('Enter'), name).resolves.toBeUndefined();
    });
  });

  test("a bad chord is X_SCRAPE_KEY_INVALID on all three — 'Ctrl' is not a modifier", async () => {
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      expect(await codeOf(() => session.page.press('Ctrl+K')), name).toBe('X_SCRAPE_KEY_INVALID');
      expect(await codeOf(() => session.page.press('Shift+')), name).toBe('X_SCRAPE_KEY_INVALID');
    });
  });

  test('the real driver holds every modifier, presses the key, and releases in REVERSE', async () => {
    const injected = launcher();
    const session = await open(localBrowser({ launcher: injected }));
    try {
      await session.page.goto(URL_A);
      await session.page.focus('#q');
      await session.page.press('Control+Shift+P');
      expect(injected.browser.focused).toEqual(['#q']);
      expect(injected.browser.pressed).toEqual([
        'down Control',
        'down Shift',
        'press P',
        'up Shift',
        'up Control',
      ]);
    } finally {
      await session.close();
    }
  });
});

/**
 * THE divergence, pinned: the real driver answers what the browser computed, and an offline driver
 * REFUSES rather than reading `role=` off the markup. `#fake-button` is why — a `<div onclick>`
 * computes no role and no name, and that emptiness is the finding a fake reading attributes would
 * invent its way past.
 */
describe('unit · accessibility() is answered by the browser or refused by name', () => {
  test('the real driver answers the computed role and name, and the div that has none', async () => {
    const injected = launcher();
    const session = await open(localBrowser({ launcher: injected }));
    try {
      await session.page.goto(URL_A);
      expect(await session.page.accessibility('#go')).toEqual([
        { role: 'button', name: 'Run search', ignored: false, focused: false },
      ]);
      expect(await session.page.accessibility('#fake-button')).toEqual([
        { role: '', name: '', ignored: false },
      ]);
      expect(await session.page.accessibility('#nothing')).toEqual([]);
      // Every session this read opened was detached, refusal paths included.
      expect(injected.browser.sessions.detached).toBe(injected.browser.sessions.created);
      expect(injected.browser.sessions.created).toBe(3);
    } finally {
      await session.close();
    }
  });

  test('an offline driver REFUSES with X_NOT_IMPLEMENTED, so a role is never invented', async () => {
    for (const [name, driver] of [
      ['fake', fakeBrowser(PAGES)],
      ['fixture', fixtureBrowser(dir)],
    ] as const) {
      const session = await open(driver);
      try {
        await session.page.goto(URL_A);
        let code: string | undefined;
        await session.page.accessibility('#go').catch((thrown: unknown) => {
          code = (thrown as { code?: string }).code;
        });
        expect(code, name).toBe('X_NOT_IMPLEMENTED');
      } finally {
        await session.close();
      }
    }
  });

  test('a non-finite max is refused before any driver is asked, on all three', async () => {
    await forEachDriver(async (session, name) => {
      await session.page.goto(URL_A);
      expect(await codeOf(() => session.page.accessibility('#go', { max: Number.NaN })), name).toBe(
        'X_INVARIANT',
      );
      expect(await codeOf(() => session.page.accessibility('#go', { max: 0 })), name).toBe(
        'X_INVARIANT',
      );
    });
  });
});
