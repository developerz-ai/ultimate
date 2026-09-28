// Client navigation in a real Chrome, driven by REAL input (`pointerClick`: the pointer moved,
// pressed, released, hit-tested by the browser): a click during the view transition that follows a
// swap still navigates, and a fast click — no resting hover first — sends exactly one request.
//
//   bun test packages/cli/e2e/client-navigation-input.e2e.test.ts
import { describe, expect, test } from 'bun:test';
import {
  currentTab,
  MARK,
  noBrowser,
  read,
  requests,
  sameDocument,
  start,
  TIMEOUT_MS,
  useBrowser,
} from './client-navigation-fixture';

describe.skipIf(noBrowser)('client navigation · real input', () => {
  useBrowser();

  test.each([50, 150, 250])(
    'a click %d ms after a swap is answered — the transition overlay never swallows it',
    async (delay) => {
      await start('/a');
      await read(
        `document.addEventListener('ultimate:navigated', () => { window.__landed = location.pathname; })`,
      );
      await currentTab().pointerClick('#to-b');
      await currentTab().waitFor('window.__landed === "/b"', 'B swapped in');
      await Bun.sleep(delay);
      await currentTab().pointerClick('#to-a');
      await currentTab().waitFor(
        'document.title === "A"',
        `the click ${delay} ms after the swap`,
        5_000,
      );
      expect(await sameDocument()).toBe(true);
    },
    TIMEOUT_MS,
  );

  test.each([
    ['a page that did not opt into prefetch', '#to-b', '/b', 'B'],
    ['a page that did', '#to-eager', '/eager', 'Eager'],
  ])(
    'a fast click on %s sends exactly one request',
    async (_name, link, path, title) => {
      await start('/a');
      await read(MARK);
      requests.length = 0;
      await currentTab().pointerClick(link);
      await currentTab().waitFor(`document.title === ${JSON.stringify(title)}`, title);
      // Past the 65 ms rest a hover would have needed, and the focus the press gave the link.
      await Bun.sleep(500);
      expect(requests.filter((line) => line.startsWith(`GET ${path} `))).toHaveLength(1);
      expect(await sameDocument()).toBe(true);
    },
    TIMEOUT_MS,
  );
});
