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
import type { E2ePageOptions } from './e2e-page';
import { e2ePage } from './e2e-page';

export type E2eDriverOptions = E2ePageOptions;

/**
 * The three `E2eFixtures` members this driver cannot build, and why each is a REFUSAL rather than
 * a no-op. A fixture that silently did nothing would make the assertion after it read as proof:
 * `offline()` followed by "the fallback rendered" is the app's ONLINE page passing an offline test.
 *
 * All three are genuinely out of reach of the shipped port, not merely unimplemented:
 * `CdpPageLike` (`packages/scraping/src/cdp-port.ts`) declares twelve methods and none of them is
 * `setOfflineMode`, and a new build id is a fact about the SERVER, which no page port has ever
 * been able to speak for.
 */
const refuse =
  (name: string, needs: string): (() => Promise<void>) =>
  () =>
    Promise.reject(new FixtureUnavailableError({ name, needs }));

/** What `e2eTest` hands its body: a real page, and three members that say what they are missing. */
export const e2eFixtures = (page: PageLike): E2eFixtures => ({
  page,
  offline: refuse(
    'offline',
    "a CDP method for the browser's own network state — the shipped CdpPageLike has no setOfflineMode",
  ),
  online: refuse('online', 'the same CDP method offline() needs, in order to undo it'),
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
    bunTest(name, () => body(e2eFixtures(page)));
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
