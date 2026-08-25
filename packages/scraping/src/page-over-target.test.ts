// The vocabulary's own traps, on the fake driver — no browser, no port.

import { describe, expect, test } from 'bun:test';
import { testClock } from './clock';
import { fakeBrowser, fakePage } from './driver-fake';
import { downloadTimeout } from './error-throws';
import { htmlTarget } from './html-target';
import type { ScrapePage } from './page';
import { pageOverTarget } from './page-over-target';
import type { PageRecording } from './recording';
import type { PageError } from './rings';
import { createRing, pageErrorEntry } from './rings';
import { createSecretBag, SECRET_PLACEHOLDER } from './secrets';
import type { ScrapeTarget } from './target';

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · frame() re-resolves on every call', () => {
  const PAGES: readonly PageRecording[] = [
    {
      url: 'https://bank.test/step1',
      html: '<iframe name="form" src="/f1"></iframe>',
      frames: { form: '<p id="who">step one</p>' },
    },
    {
      url: 'https://bank.test/step2',
      html: '<iframe name="form" src="/f2"></iframe>',
      frames: { form: '<p id="who">step two</p>' },
    },
  ];

  test('a handle taken before a re-navigation addresses the CURRENT frame, not a detached one', async () => {
    const session = await fakeBrowser(PAGES).open({
      name: 'bank',
      rules: { allowHosts: ['bank.test'] },
      clock: testClock(),
      timeoutMs: 1_000,
    });
    await session.page.goto('https://bank.test/step1');
    // Taken ONCE, before the navigation — the exact shape that goes stale with a locator-style
    // handle, and the single biggest correctness trap in this whole vocabulary.
    const form = session.page.frame('form');
    expect(await form.text('#who')).toBe('step one');
    await session.page.goto('https://bank.test/step2');
    expect(await form.text('#who')).toBe('step two');
    await session.close();
  });

  test('a frame that never appears is X_SCRAPE_SELECTOR_MISSING, not a silent empty read', async () => {
    const page = fakePage('<p>no frames here</p>', { clock: testClock(), timeoutMs: 100 });
    expect(await codeOf(page.frame('missing').text('#x'))).toBe('X_SCRAPE_SELECTOR_MISSING');
  });
});

describe('unit · typing, filling and reading back', () => {
  const FORM =
    '<input id="q" name="q" value="seed"><select id="s"><option value="a">A</option></select>';

  test('type appends to what is there, fill replaces it', async () => {
    const page = fakePage(FORM);
    await page.type('#q', '-more');
    expect((await page.values('#q'))[0]?.value).toBe('seed-more');
    await page.fill('#q', 'fresh');
    expect((await page.values('#q'))[0]?.value).toBe('fresh');
  });

  test('select records the chosen value', async () => {
    const page = fakePage(FORM);
    await page.select('#s', ['a']);
    expect((await page.values('#s'))[0]?.value).toBe('a');
  });

  test('text() with no selector is the whole document', async () => {
    const page = fakePage('<h1>Title</h1><p>Body</p>');
    expect(await page.text()).toBe('TitleBody');
  });
});

describe('unit · interception is recorded, never silent', () => {
  test('a blocked resource type and a foreign host both land in the network ring', async () => {
    const session = await fakeBrowser([
      {
        url: 'https://shop.test/',
        html: '<img src="/logo.png"><img src="https://tracker.test/p.gif"><script src="/a.js"></script>',
      },
    ]).open({
      name: 'shop',
      rules: { allowHosts: ['shop.test'], block: ['image'] },
      clock: testClock(),
      timeoutMs: 1_000,
    });
    await session.page.goto('https://shop.test/');
    const refused = session.page.network().filter((entry) => entry.refused !== undefined);
    expect(refused.map((entry) => [entry.url, entry.refused])).toEqual([
      ['https://shop.test/logo.png', 'blocked'],
      // Blocked BY TYPE before the host is even consulted — the cheaper reason, so an
      // `allowHosts` finding keeps meaning "a host you did not list".
      ['https://tracker.test/p.gif', 'blocked'],
    ]);
    // The script is on an allowed host and is not a blocked type, so it went through.
    expect(session.page.network().some((entry) => entry.url.endsWith('/a.js'))).toBe(true);
    await session.close();
  });
});

describe('unit · the rings are bounded', () => {
  test('a long run keeps the tail, counts the drops, and never grows without limit', async () => {
    const { createRing } = await import('./rings');
    const ring = createRing<number>(3);
    for (let index = 0; index < 10; index += 1) ring.push(index);
    expect(ring.entries()).toEqual([7, 8, 9]);
    expect(ring.dropped).toBe(7);
  });
});

describe('unit · pageErrors() reports what the DRIVER saw, drops included', () => {
  const targetWithErrors = (capacity: number): ScrapeTarget => {
    const recording: PageRecording = { url: 'https://shop.test/o', html: '<p>o</p>' };
    const base = htmlTarget({
      driver: 'fixture',
      lookup: () => Promise.resolve(recording),
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
      source: 'test/fixtures',
      start: recording,
    });
    // A driver's ring, filled the way a driver fills it. `ScrapeTarget` is the seam a third party
    // implements, so what is under test here is the FORWARDING, not any one driver's capture.
    return { ...base, pageErrors: createRing<PageError>(capacity) };
  };

  const pageOver = (target: ScrapeTarget) =>
    pageOverTarget(target, {
      clock: testClock(),
      allowHosts: ['shop.test'],
      defaultTimeoutMs: 100,
    });

  test('every entry the driver captured reaches the page vocabulary, stack and all', () => {
    const target = targetWithErrors(10);
    target.pageErrors.push(
      pageErrorEntry({ message: 'boom', stack: 'at Cart (/app/islands/cart.tsx:9:3)', at: 4 }),
    );
    const errors = pageOver(target).pageErrors();
    expect(errors.map((error) => error.message)).toEqual(['boom']);
    expect(errors[0]?.stack).toContain('cart.tsx:9:3');
  });

  test('and pageErrorsDropped() makes the count a FLOOR when the bound bit', () => {
    // The same honesty `networkDropped()` carries: "2 page errors" read off a truncated tail is a
    // number a reader trusts and should not, and the error count is what a verdict gates on.
    const target = targetWithErrors(2);
    for (const index of [1, 2, 3, 4, 5])
      target.pageErrors.push(pageErrorEntry({ message: `boom ${index}`, at: index }));
    const page = pageOver(target);
    expect(page.pageErrors().map((error) => error.message)).toEqual(['boom 4', 'boom 5']);
    expect(page.pageErrorsDropped()).toBe(3);
  });

  test('an offline driver answers an EMPTY list, never a missing method', () => {
    // The divergence, stated where a caller meets it: no JS engine offline, so nothing can throw
    // — but `pageErrors()` still answers, or the vocabulary would be driver-dependent.
    const page = fakePage('<p>hello</p>');
    expect(page.pageErrors()).toEqual([]);
    expect(page.pageErrorsDropped()).toBe(0);
  });
});

describe('unit · a promise-typed page method rejects whatever the driver under it did', () => {
  test('a target that THROWS from download() still reaches the caller`s .catch()', async () => {
    // `ScrapeTarget` is the seam a third party implements, so the page cannot assume every driver
    // got this right — and a synchronous throw forwarded by a non-async arrow is invisible to
    // `page.download().catch(…)`, which is how every caller of a promise-typed method handles it.
    const recording: PageRecording = { url: 'https://shop.test/orders', html: '<p>orders</p>' };
    const target = htmlTarget({
      driver: 'fixture',
      lookup: () => Promise.resolve(recording),
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
      source: 'test/fixtures',
      start: recording,
    });
    const rude: ScrapeTarget = {
      ...target,
      download: () => {
        throw downloadTimeout(10, recording.url);
      },
    };
    const page = pageOverTarget(rude, {
      clock: testClock(),
      allowHosts: ['shop.test'],
      defaultTimeoutMs: 100,
    });
    let caught: unknown;
    await page.download().catch((thrown: unknown) => {
      caught = thrown;
    });
    expect((caught as { code?: string } | undefined)?.code).toBe('X_SCRAPE_DOWNLOAD_TIMEOUT');
  });
});

describe('unit · what a capture actually asks the driver for', () => {
  /**
   * `CaptureOptions.timeoutMs` used to be REQUIRED by the port and honoured by no driver:
   * `page.screenshot({ timeout })` was documented, threaded down here, and dropped by
   * `cdp-target.ts` and `html-target.ts` alike. It is deleted rather than implemented.
   *
   * Implementing it was the tempting answer and it is the wrong one twice over. The CDP port's
   * `screenshot({ fullPage })` has no timeout slot, and a generic race in this file would have to
   * race `clock.sleep`, which under `testClock` resolves on the FIRST microtask — so every capture
   * in every test would have timed out instead of running. A knob no driver ever honoured takes
   * nothing away when it goes; a deadline that fires in tests and not in production would.
   *
   * What the driver is handed is now exactly what a driver can act on: `fullPage`, and nothing it
   * would have to ignore.
   */
  test('the driver is handed fullPage and nothing else', async () => {
    const recording: PageRecording = { url: 'https://shop.test/o', html: '<p>o</p>' };
    const base = htmlTarget({
      driver: 'fixture',
      lookup: () => Promise.resolve(recording),
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
      source: 'test/fixtures',
      start: recording,
    });
    const asked: unknown[] = [];
    const target: ScrapeTarget = {
      ...base,
      screenshot: (options) => {
        asked.push({ ...options });
        return Promise.resolve(new Uint8Array([1]));
      },
      pdf: (options) => {
        asked.push({ ...options });
        return Promise.resolve(new Uint8Array([2]));
      },
    };
    const page = pageOverTarget(target, {
      clock: testClock(),
      allowHosts: ['shop.test'],
      defaultTimeoutMs: 100,
    });

    await page.screenshot({ fullPage: true });
    await page.pdf();

    expect(asked).toEqual([{ fullPage: true }, { fullPage: undefined }]);
  });
});

// A capture's CROP rectangle. `x shot --island` photographs one component for a vision model to
// review, and a whole-viewport picture spends the reader's scarce pixels on everything that is not
// the component. Every assertion here runs on the offline driver, because CI has no Chrome and the
// crop has to be provable without one.
describe('unit · capture framing — the crop rectangle', () => {
  const UNCLIPPED = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const page = (): ScrapePage =>
    fakePage('<main><p id="a">hi</p></main>', {
      clock: testClock(),
      timeoutMs: 1_000,
    });

  test('a caller who names no clip gets exactly the bytes that shipped before it existed', async () => {
    expect([...(await page().screenshot())]).toEqual(UNCLIPPED);
    expect([...(await page().screenshot({}))]).toEqual(UNCLIPPED);
    expect([...(await page().screenshot({ fullPage: true }))]).toEqual(UNCLIPPED);
  });

  test('a clip REACHES the driver — two rectangles are two pictures', async () => {
    const first = await page().screenshot({ clip: { x: 4, y: 8, width: 100, height: 40 } });
    const second = await page().screenshot({ clip: { x: 4, y: 8, width: 200, height: 40 } });
    expect([...first]).not.toEqual(UNCLIPPED);
    expect([...first]).not.toEqual([...second]);
  });

  test('clip and fullPage together are REFUSED by name, never silently one of them', async () => {
    // CDP ignores one of the two without saying which, so the caller gets a picture they did not
    // ask for and no way to tell. The refusal is the whole point of the pair being illegal.
    expect(
      await codeOf(
        page().screenshot({ fullPage: true, clip: { x: 0, y: 0, width: 10, height: 10 } }),
      ),
    ).toBe('X_SCRAPE_CAPTURE_INVALID');
  });

  test('fullPage: false alongside a clip is fine — only the CONFLICT is refused', async () => {
    const shot = await page().screenshot({
      fullPage: false,
      clip: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(shot.byteLength).toBeGreaterThan(0);
  });

  test('a rectangle with no area is a refusal, not a blank picture that looks like a success', async () => {
    // The reachable case: a measurement taken of a hidden element answers a zero box, and a 0x0
    // PNG is indistinguishable from a capture that worked.
    for (const clip of [
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: 0 },
      { x: 0, y: 0, width: -10, height: 10 },
    ]) {
      expect(await codeOf(page().screenshot({ clip })), JSON.stringify(clip)).toBe(
        'X_SCRAPE_CAPTURE_INVALID',
      );
    }
  });

  test('a rectangle no page content can be inside is a refusal too', async () => {
    // Entirely in negative coordinates. Knowable without asking the browser anything, unlike
    // "outside the viewport" — see `capture-clip.ts` for why that one is not checked.
    for (const clip of [
      { x: -100, y: 0, width: 50, height: 50 },
      { x: 0, y: -100, width: 50, height: 50 },
      { x: Number.NaN, y: 0, width: 50, height: 50 },
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 50 },
    ]) {
      expect(await codeOf(page().screenshot({ clip })), JSON.stringify(clip)).toBe(
        'X_SCRAPE_CAPTURE_INVALID',
      );
    }
  });

  test('a rectangle BELOW THE FOLD is accepted — that is the case a component crop exists for', async () => {
    const shot = await page().screenshot({ clip: { x: 0, y: 5_000, width: 320, height: 200 } });
    expect(shot.byteLength).toBeGreaterThan(0);
  });

  test('a PDF has no crop rectangle, and says so instead of printing the whole page', async () => {
    expect(await codeOf(page().pdf({ clip: { x: 0, y: 0, width: 10, height: 10 } }))).toBe(
      'X_SCRAPE_CAPTURE_INVALID',
    );
    expect((await page().pdf()).byteLength).toBeGreaterThan(0);
  });
});

/**
 * `secrets.ts`'s header promises redaction BY VALUE over "page HTML, a console line, a request
 * URL, an error cause". Three of those four had no redaction at all: `redactSecrets` had exactly
 * one caller — `safeHtml` — so a password echoed into a console line, or pasted into a query
 * string the page fetched, reached `page.console()` and `page.network()` verbatim, and from there
 * `saveFailureArtifact`, the dead-letter row and every `x jobs show` an operator runs.
 */
describe('unit · what leaves the page is redacted by VALUE, not only its HTML', () => {
  const SECRET = 'hunter2-the-password';

  const tainted = (): { page: ScrapePage; target: ScrapeTarget } => {
    const recording: PageRecording = { url: 'https://shop.test/o', html: '<p>o</p>' };
    const target = htmlTarget({
      driver: 'fixture',
      lookup: () => Promise.resolve(recording),
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
      source: 'test/fixtures',
      start: recording,
    });
    return {
      target,
      page: pageOverTarget(target, {
        clock: testClock(),
        allowHosts: ['shop.test'],
        defaultTimeoutMs: 100,
        secrets: createSecretBag(['SHOP_PASSWORD'], () => SECRET),
      }),
    };
  };

  test('a console line that echoes the secret answers [redacted]', () => {
    const { page, target } = tainted();
    target.console.push({ level: 'error', text: `login failed for ${SECRET}`, at: 1 });
    expect(page.console()[0]?.text).not.toContain(SECRET);
    expect(page.console()[0]?.text).toContain(SECRET_PLACEHOLDER);
  });

  test('a request URL that carries the secret in its query string answers [redacted]', () => {
    const { page, target } = tainted();
    target.network.push({
      method: 'GET',
      url: `https://shop.test/login?pw=${SECRET}`,
      resourceType: 'fetch',
      at: 1,
    });
    expect(page.network()[0]?.url).not.toContain(SECRET);
    expect(page.network()[0]?.url).toContain(SECRET_PLACEHOLDER);
  });

  test('an uncaught page exception that quotes the secret answers [redacted]', () => {
    // The stack too: a framework that prints the argument it threw on puts the value in both.
    const { page, target } = tainted();
    target.pageErrors.push(
      pageErrorEntry({ message: `bad password ${SECRET}`, stack: `submit(${SECRET})`, at: 1 }),
    );
    expect(JSON.stringify(page.pageErrors())).not.toContain(SECRET);
    expect(page.pageErrors()[0]?.stack).toContain(SECRET_PLACEHOLDER);
  });

  test('with no secrets declared the text is passed through untouched, allocation and all', () => {
    const recording: PageRecording = { url: 'https://shop.test/o', html: '<p>o</p>' };
    const target = htmlTarget({
      driver: 'fixture',
      lookup: () => Promise.resolve(recording),
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
      source: 'test/fixtures',
      start: recording,
    });
    const page = pageOverTarget(target, {
      clock: testClock(),
      allowHosts: ['shop.test'],
      defaultTimeoutMs: 100,
    });
    const line = { level: 'log', text: 'plain', at: 1 } as const;
    target.console.push(line);
    expect(page.console()[0]).toBe(line);
  });
});
