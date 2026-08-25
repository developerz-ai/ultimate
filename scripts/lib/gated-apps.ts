// The apps this repo tracks and blocks on, and the steps each is allowed to fail today. Data only:
// `scripts/reference-app-gate.ts` owns what the ratchet does with it. Split out because the pins
// are the part a human edits — every landed fix deletes a line here, and nothing else.

import type { VerifyStepName } from '@ultimat3/cli';

/** Where the pin tables live, so `X_REFERENCE_APP_PIN_STALE` can name the file to edit. */
export const PINS_FILE = 'scripts/lib/gated-apps.ts';

export interface GatedApp {
  /** Repo-relative app root. Also how every finding names the app. */
  readonly dir: string;
  /** The root `tsconfig.json` `references` entry the app must join once it typechecks. */
  readonly reference: string;
  /**
   * Steps of this app's gate allowed to fail today, each naming the work that owns it. A step
   * absent from the table MUST pass — that is what makes the app blocking while it is still being
   * repaired. Lines are only ever deleted: a new red step is a regression, and a pinned step that
   * turns green fails the gate until its line goes. An empty table means the app asserts every step — the count is `VERIFY_STEP_NAMES.length`, never written here, because a number in prose beside a derived list is a number that goes stale.
   */
  readonly expectedRed: Readonly<Record<string, string>>;
}

/**
 * Both tracked apps, in the order the gate runs them: the curated reference app first, the demo
 * second. `satisfies` against the gate's own step names, so a pin for a step that does not exist
 * is a compile error rather than a line that quietly excuses nothing.
 */
export const GATED_APPS: readonly GatedApp[] = [
  {
    dir: 'examples/dummy',
    reference: './examples/dummy',
    expectedRed: {
      e2e:
        'RE-MEASURED 2026-08-24 and UNCHANGED — `bun test apps/web/e2e/offline-feed.e2e.test.ts` ' +
        'from the app root answers 0 pass, 6 fail. ' +
        'X_TEST_FIXTURE_UNAVAILABLE on all 6 tests: the `page` fixture is declared and nothing in ' +
        'this process drives it, so not one of them reaches a built page. NOT the data substrate ' +
        'this line used to blame — no repo, no query and no migration is involved in the failure. ' +
        'A SECOND defect underneath it was fixed on 2026-08-24 and did not change this count: all ' +
        'nine assertions were `await expect(locator).toBeVisible()`, and there is no `toBeVisible` ' +
        'matcher — `UltimateMatchers` (packages/testing/src/matcher-surface.ts) declares seven and ' +
        'that is not one, so every one of them would have been a TypeError the moment a driver ' +
        'made them reachable. They read `expect(await locator.isVisible()).toBe(true)` now, off ' +
        '`LocatorLike`, which is the shipped surface. It is point-in-time where the Playwright ' +
        'matcher retries, so a driver still owes a wait for the two assertions that follow a ' +
        'reconnect and a new build. ' +
        'Closed by installing a browser driver in scripts/test-setup.ts',
      drift: 'migrations predate the current entity set; regenerated with the schema',
      budgets:
        'X_BUDGET_UNMEASURED on 6 of the 8 routes that declare a `budget:`, and `.x/` is gitignored ' +
        'so no stats file is ever committed. `x build --target static` now COMPLETES here — the ' +
        '/offline page called useMutationQueue() at prerender with no LiveClient and took the ' +
        'whole build down, which is fixed — and it weighs 3 of the 8. The other 5 fail the ' +
        'in-memory measuring pass for two reasons no app can reach: /blog, /blog/:slug, /feed and ' +
        '/posts/:id raise X_ENV_MISSING because APP_URL is unset so the typed client has no ' +
        'origin, and /posts/new and /settings raise X_NO_CONTEXT because the app/ shell renders ' +
        'outside a request. Closing it means running the build with APP_URL set AND giving the ' +
        'app/ routes a request context — not merely running `x build` first, as this line used to say. ' +
        'A SEVENTH finding is a real app defect and not a never-run pass: X_LIVE_ROUTE_NO_ISLAND on ' +
        'apps/web/app/posts/ui/like-button.tsx — /posts/:id renders <LikeButton> server-side, the ' +
        'component calls useConnection() and useMutation(), and the route declares no island(), so ' +
        'no module of it ever runs in a browser: the like button is inert and the offline-queue ' +
        'indicator can never appear. The repair is precedented twice in this same app (/feed, ' +
        'which fixed exactly this in #271, and /settings) and does NOT move this pin, because the ' +
        'six above still need APP_URL and a request context',
    } satisfies Partial<Record<VerifyStepName, string>>,
  },
  {
    // The deployed demo (.github/workflows/deploy-social-demo.yml publishes its image on every
    // push to main). It was tracked, deployed and gated by nothing until 2026-08 — 237 files whose
    // only claim to working was that someone had once run them. It entered the ratchet at 3 red,
    // went to 2 when `typecheck` came off the pin, back to 3 when `drift` learned to read the
    // entity registry and found what the source-text hash could not, and to 2 again when the
    // migration that answers it landed — not because it is the reference app, but because an image
    // this repo ships to a live URL is a claim, and axiom 3 says a claim that is not a build error
    // does not exist.
    dir: 'dummy/social-media-clone',
    reference: './dummy/social-media-clone',
    expectedRed: {
      boundaries:
        'X_BOUNDARY_SITE_TO_APP ×3 — apps/web/site/feed/page.tsx imports ' +
        'apps/web/app/posts/service.ts, which drags policy.ts and repo.ts across the static/app ' +
        'line with it. The static feed needs a query, not the authed service',

      budgets:
        'X_BUDGET_UNMEASURED on every route that declares a `budget:` — the same never-run half ' +
        'of the step pinned on examples/dummy above, for the same reason: no `.x/build-stats.json` ' +
        'has ever existed here. Closed by running `x build` ahead of this gate',
    } satisfies Partial<Record<VerifyStepName, string>>,
  },
];
