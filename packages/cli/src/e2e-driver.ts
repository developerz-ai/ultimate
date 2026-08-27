// The registration. One call from an app's test preload turns the declared `page` fixture into a
// browser-backed one and gives `e2eTest` a driver — and nothing here runs unless that call is
// made, which is what keeps a CI box with no Chrome answering `hasE2eDriver() === false`.

import { test as bunTest } from 'bun:test';
import type { E2eBody, E2eFixtures, PageLike } from '@ultimat3/testing';
import {
  defineFixtures,
  FixtureUnavailableError,
  resetE2eDriver,
  unavailableFixture,
  useE2eDriver,
} from '@ultimat3/testing';
import type { E2eBrowserPage, E2ePageOptions } from './e2e-page';
import { e2ePage } from './e2e-page';

export type E2eDriverOptions = E2ePageOptions;

/**
 * A member this driver cannot build is a REFUSAL, never a no-op. A fixture that silently did
 * nothing would make the assertion after it read as proof: `offline()` followed by "the fallback
 * rendered" is the app's ONLINE page passing an offline test.
 */
const refuse =
  (name: string, needs: string): (() => Promise<void>) =>
  () =>
    Promise.reject(new FixtureUnavailableError({ name, needs }));

/**
 * `offline()`/`online()` FORWARD, `As of 2026-08-27`. They refused until then on a reason the tree
 * contradicted on the day it was written: this file said `CdpPageLike`
 * (`packages/scraping/src/cdp-port.ts`) "declares twelve methods and none of them is
 * `setOfflineMode`". It declares it at line 71 — optional, guarded, with a coded
 * `X_NOT_IMPLEMENTED` in `cdp-target.ts` for a launcher that lacks it — and `page-over-target.ts`
 * exposes it as `ScrapePage.offline()`. All of that landed in **the same commit as the comment**
 * (#351), so the refusal was never true, and it is the reason issue #390 records a real browser
 * check as out of reach.
 *
 * Optional on `E2eBrowserPage` rather than required, for the reason `CdpPageLike` gives about the
 * same method: this port is the shape of somebody ELSE's object, and a six-line test double must
 * still satisfy it. Absent, the refusal stands — and now it names the method the double is missing
 * rather than a capability the framework does not have.
 */
const networkFixtures = (browser: E2eBrowserPage): Pick<E2eFixtures, 'offline' | 'online'> => {
  const setOffline = browser.offline?.bind(browser);
  if (setOffline === undefined) {
    const needs =
      "a page whose driver implements offline(enabled) — @ultimat3/scraping's ScrapePage does; a hand-rolled E2eBrowserPage may not";
    return { offline: refuse('offline', needs), online: refuse('online', needs) };
  }
  return { offline: () => setOffline(true), online: () => setOffline(false) };
};

/** What `e2eTest` hands its body: a real page, the network condition, and one honest refusal. */
export const e2eFixtures = (page: PageLike, browser: E2eBrowserPage): E2eFixtures => ({
  page,
  ...networkFixtures(browser),
  // The one that is still genuinely out of reach, and it is not a port gap: a new build id is a
  // fact about the SERVER, which no page port has ever been able to speak for.
  update: refuse(
    'update',
    'a second build served under a new immutable build id, which is a server fact',
  ),
});

/**
 * Install the browser-backed driver for this process.
 *
 * Two seams, deliberately, because they are two questions. `defineFixtures({ page })` replaces the
 * declaration `driverFixtures()` registered — the ordinary way a driver arrives, last registration
 * wins — so every `test('…', async ({ page }) => …)` in the suite gets a browser. `useE2eDriver`
 * is the other half: it is what makes `hasE2eDriver()` answer true and stops `e2eTest` becoming a
 * `test.skip` a green gate reports over.
 *
 * `budget`, `signIn` and `deploy` are deliberately NOT registered here. Each needs something a
 * page cannot supply — byte counts off a built `dist/`, an app's own sign-in route, a second build
 * — so each keeps refusing with `X_TEST_FIXTURE_UNAVAILABLE` naming what it waits for.
 *
 * Returns the undo. `bun test` is one process, so a driver installed and never removed reaches
 * every later file in the run.
 */
export function installE2eDriver(options: E2eDriverOptions): () => void {
  const page = e2ePage(options);
  defineFixtures({ page: () => page });
  useE2eDriver((name, body: E2eBody) => {
    bunTest(name, () => body(e2eFixtures(page, options.page)));
  });
  return () => {
    // Both halves, because both were installed. Putting the DECLARATION back — rather than
    // deleting the key — is what keeps a later file's `{ page }` failing as
    // `X_TEST_FIXTURE_UNAVAILABLE` (a driver is missing) instead of `X_TEST_FIXTURE_UNKNOWN`
    // (register it), which is the wrong instruction for a name the framework declares.
    defineFixtures({ page: unavailableFixture('page') });
    resetE2eDriver();
  };
}
