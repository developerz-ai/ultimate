// Client navigation in a real Chrome: back and forward — an entry the app pushed shows its own
// page, and the scroll position is where the visitor left it, both ways.
//
//   bun test packages/cli/e2e/client-navigation-history.e2e.test.ts

import { describe, expect, test } from 'bun:test';
import {
  click,
  currentTab,
  noBrowser,
  read,
  sameDocument,
  start,
  TIMEOUT_MS,
  useBrowser,
} from './client-navigation-fixture';

describe.skipIf(noBrowser)('client navigation · history and scroll', () => {
  useBrowser();

  test(
    "back to an entry the app pushed shows that entry's page, not the one on screen",
    async () => {
      await start('/a');
      await read(`history.pushState({ app: 1 }, '', '/a?tab=2')`);
      await click('to-b');
      await currentTab().waitFor('document.title === "B"', 'B');
      await read('history.back()');
      await currentTab().waitFor('document.title === "A"', 'A back');
      expect(await read('location.pathname + location.search')).toBe('/a?tab=2');
      expect(await sameDocument()).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    'scroll: top on a new page, back restores it, and so does forward',
    async () => {
      await start('/a');
      // Through the CSSOM on <html>, which every swap keeps: an inline <style> is refused by the CSP.
      await read('document.documentElement.style.minHeight = "6000px"');
      await read('scrollTo(0, 1200)');
      await click('to-b');
      await currentTab().waitFor('document.title === "B"', 'B');
      expect(await read('scrollY')).toBe(0);
      await read('scrollTo(0, 700)');
      await Bun.sleep(400);
      await read('history.back()');
      await currentTab().waitFor('document.title === "A" && scrollY === 1200', 'A, where it was');
      await read('history.forward()');
      await currentTab().waitFor('document.title === "B" && scrollY === 700', 'B, where it was');
    },
    TIMEOUT_MS,
  );
});
