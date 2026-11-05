// The registration. One call from an app's test preload turns the declared `page` fixture into a
// browser-backed one and gives `e2eTest` a driver — and nothing here runs unless that call is
// made, which is what keeps a CI box with no Chrome answering `hasE2eDriver() === false`.

import { test as bunTest } from 'bun:test';
import type { A11yOptions, A11yRun } from './e2e-a11y-run';
import { checkAllow, startA11yRun } from './e2e-a11y-run';
import type { E2eBrowserPage, E2ePageOptions } from './e2e-page';
import { e2ePage } from './e2e-page';
import { FixtureUnavailableError } from './errors';
import { withFailureContext } from './failure-context';
import { unavailableFixture } from './fixture-drivers';
import { defineFixtures } from './fixtures';
import { paced } from './test-pace';
import type { E2eBody, E2eFixtures, PageLike } from './test-types';
import { resetE2eDriver, useE2eDriver } from './test-types';

export interface E2eDriverOptions extends E2ePageOptions {
  /**
   * Switch the running app to a new build — the SERVER half no page port can speak for. Given, it
   * becomes the `deploy` fixture's `newBuild()` and `e2eTest`'s `update()`; absent, both refuse by
   * name. The gate's e2e preload passes the spawned app's `restart({ BUILD_ID })`.
   */
  readonly newBuild?: (() => Promise<void>) | undefined;
}

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
export const e2eFixtures = (
  page: PageLike,
  browser: E2eBrowserPage,
  newBuild?: () => Promise<void>,
): E2eFixtures => ({
  page,
  ...networkFixtures(browser),
  // A new build id is a fact about the SERVER, which no page port can speak for — so it is
  // forwarded when whoever spawned the app can restart it, and refused by name otherwise.
  update:
    newBuild ??
    refuse(
      'update',
      'a second build served under a new immutable build id, which is a server fact',
    ),
});

/** One suite's page and the way it runs an `e2eTest` body — audited, with the app's log on failure. */
export interface E2eRunner {
  readonly page: PageLike;
  run(body: E2eBody, a11y?: A11yOptions): Promise<void>;
}

/**
 * What `installE2eDriver` registers, without the registering: the page, and one body's run.
 *
 * The audit runs after every settled navigation and once more after the body — so a dialog the
 * body opened counts — and fails the test only then, with every finding at once. A body that threw
 * fails on its own error: the page it left is not the page it meant to show. `reported` is the
 * suite's, so a finding one test failed on is not told again by the next (`e2e-a11y-run.ts`).
 */
export function e2eRunner(options: E2eDriverOptions): E2eRunner {
  // The running test's audit, which every settled navigation feeds; none outside a test body.
  let audit: A11yRun | undefined;
  const page = e2ePage({ ...options, afterNavigate: () => audit?.check() ?? Promise.resolve() });
  const reported = new Set<string>();
  return {
    page,
    async run(body, a11y) {
      // Through `withFailureContext`, as `fixtureTest` is: the failing test carries the app's log.
      try {
        const current = startA11yRun(options.page, checkAllow(a11y), reported);
        audit = current;
        await body(e2eFixtures(page, options.page, options.newBuild));
        await current.check();
        current.verdict();
      } catch (error) {
        throw withFailureContext(error);
      } finally {
        audit = undefined;
      }
    },
  };
}

/**
 * Install the browser-backed driver for this process.
 *
 * Two seams, deliberately, because they are two questions. `defineFixtures({ page })` replaces the
 * declaration `driverFixtures()` registered — the ordinary way a driver arrives, last registration
 * wins — so every `test('…', async ({ page }) => …)` in the suite gets a browser. `useE2eDriver`
 * is the other half: it is what makes `hasE2eDriver()` answer true and stops `e2eTest` becoming a
 * `test.skip` — which the gate now reports as a SKIPPED step rather than the green check it
 * printed until #434, and which a repo whose `x.verify.json` names `e2e` gets red for.
 *
 * `budget` and `signIn` are deliberately NOT registered here, and `deploy` only with `newBuild`. Each needs something a
 * page cannot supply — byte counts off a built `dist/`, an app's own sign-in route, a second build
 * — so each keeps refusing with `X_TEST_FIXTURE_UNAVAILABLE` naming what it waits for.
 *
 * Returns the undo. `bun test` is one process, so a driver installed and never removed reaches
 * every later file in the run.
 */
export function installE2eDriver(options: E2eDriverOptions): () => void {
  const { page, run } = e2eRunner(options);
  const newBuild = options.newBuild;
  defineFixtures({
    page: () => page,
    ...(newBuild === undefined ? {} : { deploy: () => ({ newBuild }) }),
  });
  useE2eDriver((name, body: E2eBody, test) => {
    bunTest(
      name,
      () => run(body, test?.a11y),
      test?.timeoutMs === undefined ? undefined : paced(test.timeoutMs),
    );
  });
  return () => {
    // Both halves, because both were installed. Putting the DECLARATION back — rather than
    // deleting the key — is what keeps a later file's `{ page }` failing as
    // `X_TEST_FIXTURE_UNAVAILABLE` (a driver is missing) instead of `X_TEST_FIXTURE_UNKNOWN`
    // (register it), which is the wrong instruction for a name the framework declares.
    defineFixtures({
      page: unavailableFixture('page'),
      ...(newBuild === undefined ? {} : { deploy: unavailableFixture('deploy') }),
    });
    resetE2eDriver();
  };
}
