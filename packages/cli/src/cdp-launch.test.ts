// Which browser a run gets, and what the launcher does when there is none. The launch itself is
// proved by `e2e/cdp-browser.e2e.test.ts` against a real Chrome; what is testable without one is
// the candidate order and the refusal.

import { describe, expect, test } from 'bun:test';
import { CHROME_CANDIDATES, CHROME_PATH_ENV, findChrome, launchFoundChrome } from './cdp-launch';

const NOWHERE = '/nonexistent/definitely-not-a-browser';

describe('findChrome', () => {
  test('CHROME_PATH wins outright, and nothing else is tried', async () => {
    // `bun` is a file that exists and is not a browser — this asks WHICH path is answered, which
    // is the whole question, and never runs it.
    const bun = process.execPath;

    expect(await findChrome({ [CHROME_PATH_ENV]: bun })).toBe(bun);
  });

  test('an empty CHROME_PATH falls back to the candidate list rather than answering it', async () => {
    // The empty string is what an unset variable becomes in a shell that exported it anyway, and
    // `Bun.file('').exists()` is false — so a rule spelled `!== undefined` would answer undefined
    // on a machine that really does have a browser.
    const found = await findChrome({ [CHROME_PATH_ENV]: '' });

    if (found !== undefined) expect(CHROME_CANDIDATES).toContain(found);
  });

  test('a CHROME_PATH pointing at nothing answers undefined, and does not silently search on', async () => {
    expect(await findChrome({ [CHROME_PATH_ENV]: NOWHERE })).toBeUndefined();
  });

  test('the candidate list is ordered, and google-chrome comes before chromium', () => {
    const order = [...CHROME_CANDIDATES];

    expect(order[0]).toBe('/usr/bin/google-chrome');
    // A guard on the needle's presence, because `indexOf` answers -1 for an absent name and -1 is
    // less than every real index — the assertion below would hold on a list that lost the entry.
    expect(order).toContain('/usr/bin/chromium');
    expect(order.indexOf('/usr/bin/google-chrome')).toBeLessThan(
      order.indexOf('/usr/bin/chromium'),
    );
  });
});

describe('launchFoundChrome', () => {
  test('refuses by name when there is no browser, naming every path it tried', async () => {
    const thrown = await launchFoundChrome({ [CHROME_PATH_ENV]: NOWHERE }, 1_000).catch(
      (error: unknown) => error,
    );

    expect((thrown as { code?: string }).code).toBe('X_CDP_BROWSER_MISSING');
    expect((thrown as { cause?: string }).cause).toContain('/usr/bin/google-chrome');
    expect((thrown as { fix?: string }).fix).toContain(CHROME_PATH_ENV);
  });
});
