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
   * turns green fails the gate until its line goes. An empty table means 17 of 17.
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
      typecheck:
        '137 errors as of `bunx tsc -b --pretty false` — 136 inside examples/dummy, 1 leaking ' +
        'through project refs from packages/mcp/src/transport-stdio.ts:35 (a ReadableStream ' +
        'missing [Symbol.asyncIterator]). NOT the builder-method/tenancy-escape-hatch pair this ' +
        'line used to blame: the posts repo was rewritten onto the real @ultimat3/entity surface ' +
        'and the query client landed, which is what took the count from 227 to here. What ' +
        'remains: apps/web/app/orgs/repo.ts still chains the same phantom .update().returning() ' +
        '/ .insert().returning() the posts repo used to; every *.contract/.live/.job.test.ts ' +
        'calling `seed`/`actorFor` has no type augmentation for the fixtures ' +
        'scripts/test-setup.ts wires in only at runtime; `Actor` is missing `memberId`/`tz` ' +
        "(named, not new, in this app's own CLAUDE.md); and a scatter of UI prop drift " +
        '(`SpaceStep`, `DateTimeFormatter`) plus a Date/Instant brand mismatch on every toZoned ' +
        'call in packages/core/src/digest-schedule.ts. The count moved 136 → 137 with ' +
        'previousDigestAt and its digestPreview caller, which are two more instances of those ' +
        "same two classes, not new ones. Still the data-substrate work's to close",
      contract:
        "X_TENANCY_UNSCOPED on every post write, and on the read that publishPost's `row:` " +
        'loader makes before its policy runs — data substrate',
      live: 'the live suite reads through the same unscoped repo — data substrate',
      job: 'the digest job writes through the same unscoped repo — data substrate',
      e2e:
        'X_TEST_FIXTURE_UNAVAILABLE on all 6 tests: the `page` fixture is declared and nothing in ' +
        'this process drives it, so not one of them reaches a built page. NOT the data substrate ' +
        'this line used to blame — no repo, no query and no migration is involved in the failure. ' +
        'Closed by installing a browser driver in scripts/test-setup.ts',
      drift: 'migrations predate the current entity set; regenerated with the schema',
      budgets:
        'X_BUDGET_UNMEASURED on all 8 routes that declare a `budget:`. The step used to skip its ' +
        'per-route half whenever `.x/build-stats.json` was absent — and `.x/` is gitignored, so ' +
        'that half has never run here or in CI while the step reported green. It now reports ' +
        'every declared budget the build never weighed. Closing it means running `x build` ' +
        'before the app gate so the stats file exists, which is milestone 11 work',
    } satisfies Partial<Record<VerifyStepName, string>>,
  },
  {
    // The deployed demo (.github/workflows/deploy-social-demo.yml publishes its image on every
    // push to main). It was tracked, deployed and gated by nothing until 2026-08 — 237 files whose
    // only claim to working was that someone had once run them. It entered the ratchet at 3 red of
    // 17 and sits at 2 since `typecheck` came off the pin, not because it is the reference app, but
    // because an image this repo ships to a live URL is a claim, and axiom 3 says a claim that is
    // not a build error does not exist.
    dir: 'dummy/social-media-clone',
    reference: './dummy/social-media-clone',
    expectedRed: {
      boundaries:
        'X_BOUNDARY_SITE_TO_APP ×3 — apps/web/site/feed/page.tsx imports ' +
        'apps/web/app/posts/service.ts, which drags policy.ts and repo.ts across the static/app ' +
        'line with it. The static feed needs a query, not the authed service',
      drift:
        'migrations predate the current entity set: the schema hashes to 0141d780fa37711d and ' +
        'the newest migration recorded 164f6d3add24dcd0. Regenerate with `x db gen`',
      budgets:
        'X_BUDGET_UNMEASURED on every route that declares a `budget:` — the same never-run half ' +
        'of the step pinned on examples/dummy above, for the same reason: no `.x/build-stats.json` ' +
        'has ever existed here. Closed by running `x build` ahead of this gate',
    } satisfies Partial<Record<VerifyStepName, string>>,
  },
];
