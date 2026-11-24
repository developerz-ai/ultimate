// A streamed soft visit when something moves before its holes land, in a real Chrome: the router
// is stopped from a listener, the visitor's fragment is inside a hole, the line dies under the page
// (a GET, a GET whose URL only differs by its fragment, a POST), or it dies while the visitor's next
// page is still on its way. The fixture and the plain fill: `stream-hole.e2e.test.ts`.
//
//   bun test packages/cli/e2e/stream-hole-recovery.e2e.test.ts

import { describe, expect, test } from 'bun:test';
import {
  cancelOf,
  closeHole,
  freshBefore,
  holdHole,
  noBrowser,
  TIMEOUT_MS,
  useStreamHole,
  WAIT_MS,
  wire,
} from './stream-hole-fixture';

/** How long a negative claim watches Chrome for the load it says never comes. */
const QUIET_MS = 300;

describe.skipIf(noBrowser)('stream · a soft visit when the page or the line moves on', () => {
  const run = useStreamHole();

  test(
    'stop() from an ultimate:navigated listener: the stopped router fills nothing',
    async () => {
      const { tab } = run();
      holdHole();
      await freshBefore(run());
      await tab.evaluate(
        "document.addEventListener('ultimate:navigated', () => window.__xNavigation.stop(), { once: true })",
      );
      const cut = cancelOf('/streamed');
      await tab.pointerClick('#go');
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      // The stopped router cancels the answer it was still reading. Never cancelled, this waits
      // out the test's own deadline, which names it. Cancelled, no chunk can arrive after it.
      await cut;
      closeHole();
      expect(await tab.evaluate('document.getElementById("filled") === null')).toBe(true);
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
    },
    TIMEOUT_MS,
  );

  test(
    'a fragment inside a hole is scrolled to when the hole lands',
    async () => {
      const { tab } = run();
      holdHole();
      await freshBefore(run());
      await tab.pointerClick('#go-late');
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      expect(await tab.evaluate('window.scrollY')).toBe(0);
      closeHole();
      await tab.waitFor('document.getElementById("filled") !== null', 'the hole to fill', WAIT_MS);
      await tab.waitFor(
        'window.scrollY > 0 && document.getElementById("filled").getBoundingClientRect().top < innerHeight',
        'the fragment the hole carried to be scrolled to',
        WAIT_MS,
      );
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
    },
    TIMEOUT_MS,
  );

  test(
    'a GET whose body dies after the shell is loaded for real, a fragment URL too',
    async () => {
      const { tab } = run();
      holdHole();
      await freshBefore(run());
      wire.breakNext = true;
      await tab.pointerClick('#go-broken');
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
      // The real load asks for the hole again: it is answered at once.
      wire.gate = Promise.resolve();
      wire.breakBody();
      await tab.waitFor(
        'window.__kept === undefined && document.getElementById("filled") !== null',
        'a full load of the page, whose URL only differs by its fragment',
        WAIT_MS,
      );
      expect(await tab.evaluate('location.pathname + location.search + location.hash')).toBe(
        '/streamed?break#filled',
      );
    },
    TIMEOUT_MS,
  );

  test(
    'a POST whose body dies after the shell: ultimate:navigation-error, and never sent again',
    async () => {
      const { tab, base } = run();
      holdHole();
      await freshBefore(run());
      wire.posts.length = 0;
      await tab.evaluate(`document.addEventListener('ultimate:navigation-error', (e) => {
        e.preventDefault();
        window.__failed = e.detail;
      }, { once: true })`);
      wire.breakNext = true;
      await tab.evaluate(
        `window.__xNavigation.navigate(${JSON.stringify(`${base}/streamed?break`)}, { method: 'POST', body: new FormData() })`,
      );
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      wire.breakBody();
      await tab.waitFor('window.__failed !== undefined', 'the error event', WAIT_MS);
      expect(await tab.evaluate('window.__failed.method')).toBe('POST');
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
      expect(wire.posts).toEqual(['/streamed']);
      closeHole();
    },
    TIMEOUT_MS,
  );

  test(
    'a body that dies while the next visit is still on its way leaves that visit alone',
    async () => {
      const { tab } = run();
      holdHole();
      await freshBefore(run());
      wire.breakNext = true;
      await tab.pointerClick('#go-broken-plain');
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      await tab.pointerClick('#held');
      wire.breakBody();
      // A load NOT started has no event to await: the claim is watched for a bounded window.
      // real-clock: only Chrome, another process, could start that load.
      await Bun.sleep(QUIET_MS);
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
      wire.release();
      await tab.waitFor('document.title === "before"', 'the next page', WAIT_MS);
      // real-clock: as above — the recovery that must not run once the next page took the tab.
      await Bun.sleep(QUIET_MS);
      expect(await tab.evaluate('location.pathname')).toBe('/before');
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
      closeHole();
    },
    TIMEOUT_MS,
  );
});
