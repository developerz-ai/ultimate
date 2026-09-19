// `press`, `focus` and `accessibility` on the real driver's target, over a hand-built CDP page —
// the three refusals only this file can see: a launcher whose page has no `keyboard`, no `focus()`
// and no `createCDPSession()`. `CdpPageLike` declares each optional (this file is the shape of
// somebody else's object), and these are the tests that keep optional from meaning unwired.
//
// Its own file because `cdp-target.test.ts` is at the 500-line ceiling.

import { describe, expect, test } from 'bun:test';
import { fakeCdpBrowser } from './cdp-fake';
import type { CdpBrowserLike, CdpFrameLike, CdpPageLike } from './cdp-port';
import { cdpTarget } from './cdp-target';
import { testClock } from './clock';
import type { ScrapeTarget } from './target';

/** A page with NONE of the three optional members, and one frame. */
const barePage = (): { readonly page: CdpPageLike; readonly calls: readonly string[] } => {
  const calls: string[] = [];
  const frame: CdpFrameLike = {
    name: () => 'inner',
    url: () => 'https://shop.test/inner',
    content: () => Promise.resolve(''),
    evaluate: (expression: string) => {
      calls.push(`frame evaluate ${expression}`);
      return Promise.resolve(undefined);
    },
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    select: () => Promise.resolve([]),
  };
  const page: CdpPageLike = {
    url: () => 'https://shop.test/o',
    goto: () => Promise.resolve(undefined),
    content: () => Promise.resolve(''),
    evaluate: (expression: string) => {
      calls.push(`evaluate ${expression}`);
      return Promise.resolve(undefined);
    },
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    select: () => Promise.resolve([]),
    screenshot: () => Promise.resolve(new Uint8Array()),
    pdf: () => Promise.resolve(new Uint8Array()),
    setRequestInterception: () => Promise.resolve(),
    on: () => undefined,
    frames: () => [frame],
    close: () => Promise.resolve(),
  };
  return { page, calls };
};

const browserOver = (page: CdpPageLike): CdpBrowserLike => ({
  newPage: () => Promise.resolve(page),
  close: () => Promise.resolve(),
  process: () => null,
});

const targetOver = (page: CdpPageLike): Promise<ScrapeTarget> =>
  cdpTarget({
    page,
    browser: browserOver(page),
    rules: { allowHosts: ['shop.test'] },
    clock: testClock(),
  });

const refusalOf = async (
  run: () => Promise<unknown>,
): Promise<{ code?: string; cause?: string; fix?: string }> => {
  try {
    await run();
    return {};
  } catch (caught) {
    return caught as { code?: string; cause?: string; fix?: string };
  }
};

describe('unit · a launcher without the member is refused BY NAME, never silently accepted', () => {
  test('press() with no keyboard is X_NOT_IMPLEMENTED naming page.keyboard', async () => {
    const target = await targetOver(barePage().page);
    const thrown = await refusalOf(() => target.press('Meta+K'));
    // Passed through `guard()`: the method is still missing on attempt five.
    expect(thrown.code).toBe('X_NOT_IMPLEMENTED');
    expect(thrown.fix).toContain('page.keyboard');
  });

  test('a bad chord is X_SCRAPE_KEY_INVALID even where there is no keyboard — the parse comes first', async () => {
    const target = await targetOver(barePage().page);
    expect((await refusalOf(() => target.press('Cmd+K'))).code).toBe('X_SCRAPE_KEY_INVALID');
  });

  test('focus() with no focus() method is X_NOT_IMPLEMENTED naming page.focus()', async () => {
    const target = await targetOver(barePage().page);
    const thrown = await refusalOf(() => target.focus('#q'));
    expect(thrown.code).toBe('X_NOT_IMPLEMENTED');
    expect(thrown.fix).toContain('page.focus()');
  });

  test('accessibility() with no createCDPSession() is X_NOT_IMPLEMENTED naming it', async () => {
    const target = await targetOver(barePage().page);
    const thrown = await refusalOf(() => target.accessibility('#q', 25));
    expect(thrown.code).toBe('X_NOT_IMPLEMENTED');
    expect(thrown.fix).toContain('page.createCDPSession()');
  });
});

describe('unit · the frame half', () => {
  test('a frame focus travels as an expression into the FRAME, and press reaches the page keyboard', async () => {
    const browser = fakeCdpBrowser({
      url: 'https://shop.test/o',
      html: '<iframe name="inner"></iframe>',
      frames: { inner: { url: 'https://shop.test/inner', html: '<input id="q">' } },
    });
    const page = await browser.newPage();
    const target = await targetOver(page);
    const inner = (await target.frames())[0]?.target;
    expect(inner).toBeDefined();
    if (inner === undefined) return;
    await inner.focus('#q');
    await inner.press('Escape');
    // The page's own `focus()` was NOT called — the frame evaluated its expression instead.
    expect(browser.focused).toEqual([]);
    expect(browser.pressed).toEqual(['press Escape']);
  });

  test('a frame accessibility() REJECTS with X_NOT_IMPLEMENTED rather than reading the parent', async () => {
    const { page } = barePage();
    const target = await targetOver(page);
    const inner = (await target.frames())[0]?.target;
    expect(inner).toBeDefined();
    if (inner === undefined) return;
    let code: string | undefined;
    // `.catch`, the caller's own shape: a synchronous throw here would jump straight over it.
    await inner.accessibility('#q', 25).catch((thrown: unknown) => {
      code = (thrown as { code?: string }).code;
    });
    expect(code).toBe('X_NOT_IMPLEMENTED');
  });
});

describe('unit · the session opened for an accessibility read is always detached', () => {
  test('detached on the success path and on a parse refusal alike', async () => {
    const browser = fakeCdpBrowser({
      url: 'https://shop.test/o',
      html: '<button id="go">Go</button>',
      accessibility: { '#go': [{ role: 'button', name: 'Go', ignored: false }] },
    });
    const target = await targetOver(await browser.newPage());
    expect(await target.accessibility('#go', 25)).toEqual([
      { role: 'button', name: 'Go', ignored: false },
    ]);
    expect(browser.sessions).toEqual({ created: 1, detached: 1 });
  });

  test('a build whose answer does not parse is X_VALIDATION_FAILED, passed through, and detached', async () => {
    let detached = 0;
    const { page } = barePage();
    const withSession: CdpPageLike = {
      ...page,
      createCDPSession: () =>
        Promise.resolve({
          // `DOM.getDocument` answering no `root`: a renamed field on a newer protocol.
          send: () => Promise.resolve({}),
          detach: () => {
            detached += 1;
            return Promise.resolve();
          },
        }),
    };
    const target = await targetOver(withSession);
    const thrown = await refusalOf(() => target.accessibility('#q', 25));
    // NOT re-labelled `X_SCRAPE_BROWSER_UNREACHABLE`: the browser answered, and attempt five
    // reads the same shape.
    expect(thrown.code).toBe('X_VALIDATION_FAILED');
    expect(detached).toBe(1);
  });
});
