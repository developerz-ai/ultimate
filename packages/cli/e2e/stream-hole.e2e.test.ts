// `<Hole>` in a real Chrome, over the real page handler and the real pipeline, under the ENFORCED
// policy a container sends. The proof the generated `stream` default rests on: an inline module is
// deferred until parsing ends and a document with a hole open is still parsing, so without `async`
// on the runtime the press below reaches a dead button. The server, not a clock, holds the hole open.
// What a soft visit does when the line or the visitor moves on: `stream-hole-recovery.e2e.test.ts`.
//
//   bun test packages/cli/e2e/stream-hole.e2e.test.ts

import { describe, expect, test } from 'bun:test';
import {
  aborted,
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

describe.skipIf(noBrowser)('stream · a hole open, in a browser, under the enforced policy', () => {
  const run = useStreamHole();

  test(
    'a shell island answers a press while the hole is open; the hole then fills and hydrates',
    async () => {
      const { tab, base } = run();
      holdHole();
      // Not `goto`: it waits for the load event, and that is the very thing a hole holds back.
      await tab.evaluate(`location.href = ${JSON.stringify(`${base}/streamed`)}`);
      await tab.waitFor(
        'document.getElementById("press") !== null && document.getElementById("waiting") !== null',
        'the first flush to arrive with the hole still open',
        WAIT_MS,
      );
      expect(await tab.evaluate('document.readyState')).toBe('loading');

      await tab.waitFor(
        'document.querySelector("[data-x-island] button") !== null && document.querySelector("[data-x-mounted]") !== null',
        'the shell island to mount while the document is still parsing',
        WAIT_MS,
      );
      await tab.pointerClick('#press');
      await tab.waitFor(
        'document.getElementById("press").textContent === "answered"',
        'the shell island to answer the press',
        WAIT_MS,
      );
      // Before the reveal, or the runtime waited for the hole and this proves nothing.
      expect(await tab.evaluate('document.getElementById("waiting") !== null')).toBe(true);
      expect(await tab.evaluate('document.querySelector("x-hole") !== null')).toBe(true);

      closeHole();
      await tab.waitFor('document.getElementById("filled") !== null', 'the hole to fill', WAIT_MS);
      expect(await tab.evaluate('document.getElementById("waiting") === null')).toBe(true);
      await tab.waitFor(
        'document.getElementById("filled").textContent === "late island mounted"',
        'the island the first flush never knew of to hydrate from its chunk',
        WAIT_MS,
      );
      await tab.waitFor('document.readyState === "complete"', 'the document to close', WAIT_MS);
    },
    TIMEOUT_MS,
  );

  // was: "a soft visit waits for the whole answer, then its holes fill and its islands hydrate"
  test(
    'a soft visit paints its shell while the hole is open; the hole then fills and hydrates',
    async () => {
      const { tab, base } = run();
      holdHole();
      await freshBefore(run());
      await tab.evaluate(`document.addEventListener('ultimate:navigated', (e) => {
        window.__navigated = { url: e.detail.url, open: document.getElementById('waiting') !== null };
      }, { once: true })`);
      await tab.pointerClick('#go');
      await tab.waitFor(
        'document.title === "streamed" && document.getElementById("waiting") !== null',
        'the shell to be swapped in with the hole still open',
        WAIT_MS,
      );
      // The event says the page landed while its hole is still held, not once the stream ended:
      // the hole stays held until `closeHole()` below, so waiting for it here proves just that.
      await tab.waitFor('window.__navigated !== undefined', 'ultimate:navigated', WAIT_MS);
      expect(await tab.evaluate('window.__navigated')).toEqual({
        url: `${base}/streamed`,
        open: true,
      });
      expect(await tab.evaluate('document.getElementById("filled") === null')).toBe(true);
      await tab.pointerClick('#press');
      await tab.waitFor(
        'document.getElementById("press").textContent === "answered"',
        'the shell island to answer while the hole is open',
        WAIT_MS,
      );

      closeHole();
      await tab.waitFor('document.getElementById("filled") !== null', 'the hole to fill', WAIT_MS);
      expect(await tab.evaluate('document.getElementById("waiting") === null')).toBe(true);
      expect(await tab.evaluate('document.querySelector("template[data-x-hole]") === null')).toBe(
        true,
      );
      await tab.waitFor(
        'document.getElementById("filled").textContent === "late island mounted"',
        'the hole’s island to hydrate after the swap',
        WAIT_MS,
      );
      // The same document all along: a full load would have proved none of the above.
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
    },
    TIMEOUT_MS,
  );

  test(
    'a failed hole shows its error branch after a soft visit, not a blank box',
    async () => {
      const { tab } = run();
      holdHole();
      wire.failing = true;
      await freshBefore(run());
      await tab.pointerClick('#go');
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      closeHole();
      await tab.waitFor(
        'document.getElementById("failed")?.textContent === "could not load"',
        'the hole’s error branch',
        WAIT_MS,
      );
      expect(await tab.evaluate('document.getElementById("waiting") === null')).toBe(true);
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
    },
    TIMEOUT_MS,
  );

  test(
    'a second navigation cancels the first one’s open holes: nothing of it lands',
    async () => {
      const { tab } = run();
      holdHole();
      await freshBefore(run());
      await tab.pointerClick('#go');
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      const cut = cancelOf('/streamed');
      await tab.pointerClick('#back');
      await tab.waitFor('document.title === "before"', 'the second page', WAIT_MS);
      // The server hears it: the open hole's request is cancelled, so its work stops. Never
      // cancelled, this waits out the test's own deadline, which names it.
      await cut;
      // And the read under the hole is told while it is still held: its signal is what stops it.
      // Never aborted, this too waits out the test's own deadline.
      await aborted(wire.heldSignal);
      // By the cancel, not by the hole's own deadline (`X_TIMEOUT`), which would abort it too.
      expect(wire.heldSignal?.aborted).toBe(true);
      expect((wire.heldSignal?.reason as { code?: string } | undefined)?.code).not.toBe(
        'X_TIMEOUT',
      );
      closeHole();
      expect(await tab.evaluate('document.getElementById("filled") === null')).toBe(true);
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
    },
    TIMEOUT_MS,
  );

  test(
    'the policy is enforced, so what ran above ran because its hash is listed',
    async () => {
      const { base, pipeline } = run();
      wire.gate = Promise.resolve();
      const response = await pipeline.fetch(new Request(`${base}/streamed`));
      expect(response.headers.get('content-security-policy')).toContain('script-src');
      expect(response.headers.get('content-security-policy-report-only')).toBeNull();
      await response.text();
    },
    TIMEOUT_MS,
  );
});
