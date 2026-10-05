// Client navigation in a real Chrome, driven by REAL input (`pointerClick`: the pointer moved,
// pressed, released, hit-tested by the browser): a click during the view transition that follows a
// swap still navigates, a press during one leaves it running (#621), and a fast click — no resting
// hover first — sends exactly one request.
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

  /**
   * #621: the router skipped any running view transition on every press, so a named element
   * gliding to its place snapped there the moment the visitor touched the page — a touch that
   * scrolls, a long press. Only a click the overlay swallowed may skip it now: Chrome hit-tests
   * every press to `<html>` during a transition whatever `pointer-events` its overlay has, and
   * only a skipped transition hit-tests the page. The transition is slowed to seconds — the
   * default 250 ms is over before a press could prove anything — and watched through its own
   * animation, whose `playState` a skip turns `idle`.
   */
  const slowTransition = async (): Promise<void> => {
    await start('/a');
    await read(`(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: 6s }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      document.addEventListener('ultimate:navigated', () => { window.__landed = location.pathname; });
    })()`);
    await currentTab().pointerClick('#to-b');
    await currentTab().waitFor('window.__landed === "/b"', 'B swapped in');
    await currentTab().waitFor(
      `(window.__glide = document.getAnimations().find((a) => String(a.effect && a.effect.pseudoElement).startsWith('::view-transition'))) !== undefined`,
      'the view transition to be animating',
    );
  };
  const gliding = (): Promise<unknown> => read('window.__glide.playState === "running"');

  test(
    'a press mid-transition that is no click (a touch that scrolls) keeps the transition running',
    async () => {
      await slowTransition();
      // The port has no press without its release, so the press is dispatched as Chrome would
      // send a touch-scroll's: down on a non-link, then cancelled — no click follows.
      await read(`(() => {
        const at = document.getElementById('below');
        at.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
        at.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch' }));
      })()`);
      // A frame for a skip to land, were one sent.
      await read('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      expect(await gliding()).toBe(true);
      expect(await read('document.title')).toBe('B');
    },
    TIMEOUT_MS,
  );

  test(
    'a click on a link mid-transition still lands — the overlay never swallows it',
    async () => {
      await slowTransition();
      expect(await gliding()).toBe(true);
      await currentTab().pointerClick('#to-a');
      await currentTab().waitFor('document.title === "A"', 'the click mid-transition', 5_000);
      expect(await sameDocument()).toBe(true);
    },
    TIMEOUT_MS,
  );
});
