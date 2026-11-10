// `x new`'s `x.verify.json`: the suite floor and the coverage bar every scaffolded app starts on.
// Split from `scaffold-repo.ts` (the repo's root files), which had reached the 500-line ceiling.

import type { CoverageExclude } from '../coverage-floor';
import { COVERAGE_BAR } from '../coverage-floor';
import type { VerifyStepName } from '../verify-step';

/**
 * The suite ratchet, committed on day one. Without it `readVerifyFloor` answers "no file is no
 * floor" and a deleted suite turns its step from green into skipped-and-green — so
 * `X_VERIFY_SUITE_VANISHED` was unreachable in every generated app, in the one repo shape that
 * grows suites fastest.
 *
 * Every name here is a step this scaffold has proved it can run: the SIX that declare no `applies`
 * at all — typecheck, lint, boundaries, filesize, errors, manifest — plus `package-shape` (five
 * workspace packages), `unit` (every generator emits a `<file>.test.ts`; like every suite step it
 * applies on its own file list, `verify-tests.ts`), and `eval`, `drift` and `budgets`, which apply
 * to any root with an `app.config.ts`. Typed as `VerifyStepName`, so a name the gate does not run
 * is a compile error rather than a floor that covers nothing.
 *
 * Plus `contract`, which every variant now ships a file for — `apps/web/api/health.contract.test.ts`
 * — and, with the example slice, `live` and `job`: its query is a `liveTest` and its job a
 * `jobTest`, and both were written into plain `<name>.test.ts` files that the `unit` step ran while
 * `x test live` and `x test job` answered X_TEST_NO_FILES. This is the commit that makes the app's
 * own gate run them, which is what the paragraph below always said the condition was.
 *
 * Two remain absent. `e2e` has a scaffolded file and it is an `e2eTest` — `test.skip` until the app
 * registers a browser driver, so the step would run zero tests and fail the ratchet on the
 * scaffold's own placeholder. Its absence is visible rather than silent: a suite that executed
 * nothing reports as a SKIPPED step, not the green check it printed until #434, so the app's own
 * gate line says `- e2e` and names it in the summary until a driver makes it run. `contract-diff` needs a committed `x.manifest.json`, which
 * `x manifest` writes later. Each joins the list in the commit that makes the app's gate run it.
 */
const SCAFFOLD_FLOOR: readonly VerifyStepName[] = [
  'typecheck',
  'lint',
  'boundaries',
  'filesize',
  'package-shape',
  'errors',
  'unit',
  'contract',
  // Every app has an `app.config.ts` and primitives to run: `x new` writes `apps/web/exercise.ts`.
  'exercise',
  'eval',
  'drift',
  'budgets',
  // Always applicable to a scaffolded app — it has an `app.config.ts`, roles and two guarded
  // routes — so a run that reports it skipped is a gate that lost the step, not an app with
  // nothing to check. It is the step that would have caught the 500 `x new` used to ship.
  'policy',
  'manifest',
];

/** The two suites only the example slice writes a file for — a floor step with no file is red. */
const EXAMPLE_FLOOR: readonly VerifyStepName[] = ['live', 'job'];

/**
 * What a unit test cannot execute in a scaffolded app, each with its reason — `x doctor` prints
 * them. Two kinds and no more: a file here is a file the floor does not see, so the list is not
 * a place to put code that merely has no test yet.
 */
export const SCAFFOLD_COVERAGE_EXCLUDE: readonly CoverageExclude[] = [
  {
    glob: 'apps/**/*.island.tsx',
    why: 'an island runs in a browser: its test mounts a BUILT chunk (mountIsland), and Bun cannot map that chunk back to this source — its states are held by guards/island-without-states.ts and photographed by x shot --island',
  },
  {
    glob: 'apps/*/server.ts',
    why: 'the container entry point: it boots the roles and lives as long as the process — bun run dev and the image exercise it',
  },
  {
    glob: 'apps/*/prerender.ts',
    why: "the static build's entry point: x build --target static runs it, and the budgets step weighs what it writes",
  },
];

/**
 * The coverage floor every scaffolded app starts on: the bar the framework holds its own packages
 * to (`COVERAGE_BAR`), not a softer one for apps. `scaffold-smoke` runs the app's own `x verify`,
 * so the scaffold is green at it on what it generates or the job is red.
 */
export const verifyFloor = (example: boolean): string =>
  `${JSON.stringify(
    {
      steps: example ? [...SCAFFOLD_FLOOR, ...EXAMPLE_FLOOR] : SCAFFOLD_FLOOR,
      coverage: {
        lines: COVERAGE_BAR,
        funcs: COVERAGE_BAR,
        exclude: SCAFFOLD_COVERAGE_EXCLUDE,
      },
      // The rolling rail judges from the first migration: a new app has nothing to grandfather.
      rollingSince: '0',
    },
    null,
    2,
  )}\n`;
