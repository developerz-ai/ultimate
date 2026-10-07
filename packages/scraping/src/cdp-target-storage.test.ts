// `restore()`'s storage half, run as the page would run it. The expression travels as text, so the
// test executes that text against a recording `localStorage`: a key spelled `__proto__` is legal
// storage (`browser-record.ts` reads it back as an own key), and an object literal built from it
// sets the literal's prototype instead of filing the key — the token silently never restored.

import { describe, expect, test } from 'bun:test';
import { browserRecord } from './browser-record';
import { fakeBrowserTarget } from './cdp-fake-target-fixture';
import type { CdpBrowserLike, CdpPageLike } from './cdp-port';
import { cdpTarget } from './cdp-target';
import { testScrapeClock } from './clock';
import type { SessionSnapshot } from './session-state';

const ORIGIN = 'https://shop.test';

/** A page on `ORIGIN` that RUNS each evaluated expression against its own `localStorage`. */
const storagePage = (): { readonly page: CdpPageLike; readonly stored: Map<string, string> } => {
  const stored = new Map<string, string>();
  const localStorage = { setItem: (key: string, value: string) => stored.set(key, value) };
  const page: CdpPageLike = {
    url: () => `${ORIGIN}/account`,
    goto: () => Promise.resolve(undefined),
    content: () => Promise.resolve(''),
    // The page's own engine, standing in for the browser's: the language rule under test (what
    // an object literal does with `"__proto__"`) is the same in both.
    evaluate: (expression: string) =>
      Promise.resolve(new Function('localStorage', `return ${expression};`)(localStorage)),
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    select: () => Promise.resolve([]),
    screenshot: () => Promise.resolve(new Uint8Array()),
    pdf: () => Promise.resolve(new Uint8Array()),
    setRequestInterception: () => Promise.resolve(),
    on: () => undefined,
    frames: () => [],
    close: () => Promise.resolve(),
  };
  return { page, stored };
};

describe('unit · restore() writes every stored key back, whatever it is called', () => {
  test('a key spelled __proto__ is restored as a key, beside an ordinary one', async () => {
    const { page, stored } = storagePage();
    const browser: CdpBrowserLike = {
      newPage: () => Promise.resolve(page),
      target: () => fakeBrowserTarget().target,
      close: () => Promise.resolve(),
      process: () => null,
    };
    const target = await cdpTarget({
      page,
      browser,
      rules: { allowHosts: ['shop.test'] },
      clock: testScrapeClock(),
    });
    // Built the way `session()` builds one read OUT of a page: `JSON.parse` files `__proto__` as
    // an own key, and `browserRecord` keeps it on a null prototype.
    const storage = browserRecord(JSON.parse('{"__proto__":"bearer-1","theme":"dark"}'));
    const session: SessionSnapshot = {
      cookies: [],
      headers: {},
      storage,
      userAgent: 'test',
      origin: ORIGIN,
    };
    await target.restore(session);
    expect([...stored.entries()].sort()).toEqual([
      ['__proto__', 'bearer-1'],
      ['theme', 'dark'],
    ]);
  });
});
