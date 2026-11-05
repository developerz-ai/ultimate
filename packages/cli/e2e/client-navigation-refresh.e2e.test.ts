// Client navigation in a real Chrome: `refresh()` re-reads the page on screen for the SAME visitor.
// The document is swapped (a marker on the old `<main>` is gone), yet focus stays on the control the
// visitor was in, found by its `id` or its `name` in the same form, and nothing is announced.
//
//   bun test packages/cli/e2e/client-navigation-refresh.e2e.test.ts

import { describe, expect, test } from 'bun:test';
import {
  currentTab,
  noBrowser,
  read,
  sameDocument,
  start,
  TIMEOUT_MS,
  useBrowser,
} from './client-navigation-fixture';

/** Marks the `<main>` on screen, refreshes, and waits until a new `<main>` replaced it. */
async function refreshed(): Promise<void> {
  await read('document.querySelector("main").dataset.before = "1"');
  await read('void window.__xNavigation.refresh().then(() => { window.__refreshed = true; })');
  await currentTab().waitFor(
    'window.__refreshed === true && document.querySelector("main").dataset.before === undefined',
    'the page swapped in again',
  );
}

describe.skipIf(noBrowser)('client navigation · refresh', () => {
  useBrowser();

  test(
    'focus stays on a control with an id across a refresh, and the announcer stays silent',
    async () => {
      await start('/a');
      await read('document.getElementById("to-b").focus()');
      expect(await read('document.activeElement.id')).toBe('to-b');
      await refreshed();
      expect(await read('document.activeElement.id')).toBe('to-b');
      expect(await read('document.activeElement.isConnected')).toBe(true);
      expect(await read('document.querySelector("[aria-live]").textContent')).toBe('');
      expect(await sameDocument()).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    'a field with no id is found by its name in the same form',
    async () => {
      await start('/a');
      await read('document.querySelector("#post input").focus()');
      await refreshed();
      expect(await read('document.activeElement.name + "@" + document.activeElement.form.id')).toBe(
        'name@post',
      );
    },
    TIMEOUT_MS,
  );
});
