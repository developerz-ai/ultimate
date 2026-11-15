// `press`, `focus` and `accessibility` on the real driver's target, over a hand-built CDP page.
// A launcher missing any of the three no longer reaches here: `CdpPageLike` requires each, and
// `port-complete.test.ts` pins that as a type. What is left is how each verb reaches the browser.
//
// Its own file because `cdp-target.test.ts` is at the 500-line ceiling.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { fakeCdpBrowser } from './cdp-fake-fixture';
import { fakeBrowserTarget } from './cdp-fake-target-fixture';
import type { CdpBrowserLike, CdpFrameLike, CdpPageLike } from './cdp-port';
import { stubCookieJar, stubPageVerbs } from './cdp-port-stubs-fixture';
import { cdpTarget } from './cdp-target';
import type { ScrapeTarget } from './target';

/** A page whose required verbs are no-ops, and one frame. */
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
    ...stubPageVerbs(),
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
  ...stubCookieJar(),
  newPage: () => Promise.resolve(page),
  target: () => fakeBrowserTarget().target,
  close: () => Promise.resolve(),
  process: () => null,
});

const targetOver = (page: CdpPageLike): Promise<ScrapeTarget> =>
  cdpTarget({
    page,
    browser: browserOver(page),
    rules: { allowHosts: ['shop.test'] },
    clock: frozenClock(),
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

describe('unit · the chord is parsed before the keyboard is touched', () => {
  test('a bad chord is X_SCRAPE_KEY_INVALID, never re-labelled by guard()', async () => {
    const target = await targetOver(barePage().page);
    expect((await refusalOf(() => target.press('Cmd+K'))).code).toBe('X_SCRAPE_KEY_INVALID');
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
      ...stubPageVerbs(),
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
