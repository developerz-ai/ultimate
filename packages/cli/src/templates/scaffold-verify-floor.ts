// `x new`'s `x.verify.json`: the suite floor and the coverage bar every scaffolded app starts on.
// Split from `scaffold-repo.ts` (the repo's root files), which had reached the 500-line ceiling.

import { STATEMENTS_MAX } from '@ultimat3/testing';
import type { CoverageExclude } from '../coverage-floor';
import { COVERAGE_BAR } from '../coverage-floor';
import type { VerifyStepName } from '../verify-step';

/**
 * The suite ratchet, committed on day one, naming ALL of the gate: every step is either required in
 * `steps` or excused in `skip` with a written why (`verify-strict.ts`), and
 * `scaffold-verify-floor.test.ts` refuses a scaffold that leaves one in neither. Without a floor
 * `readVerifyFloor` answers "no file is no floor" and a deleted suite turns its step from green into
 * skipped-and-green. Typed as `VerifyStepName`, so a name the gate does not run is a compile error.
 *
 * `live` and `e2e` are required of every scaffold with the files that make them run
 * (`scaffold-suites.ts`): the production driver against the test Postgres `x verify` starts, the
 * landing page in a real browser. No browser is red with the command that locates one, never a
 * green step that checked nothing. `contract-diff` applies once `bun run setup` has written
 * `x.manifest.json`, which is the first command the README gives.
 *
 * And `strict: true`: a step that ran nothing is red unless `skip` carries its why
 * (`X_VERIFY_STRICT_UNRUN`). Measured on a fresh `x new` / `--no-example`: `roadmap` everywhere,
 * `job` without the example slice, `e2e` in the `api` shape — exactly the `WHY` rows below.
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
  // `packages/db/src/client.live.test.ts`, in every scaffold — and the example's live query.
  'live',
  // Every app has an `app.config.ts` and primitives to run: `x new` writes `apps/web/exercise.ts`.
  'exercise',
  // `apps/web/site/page.e2e.test.ts` — dropped, with this name, by a shape that serves no page.
  'e2e',
  'eval',
  'drift',
  'contract-diff',
  'budgets',
  'seo',
  'i18n',
  // Always applicable to a scaffolded app — it has an `app.config.ts`, roles and two guarded
  // routes — so a run that reports it skipped is a gate that lost the step, not an app with
  // nothing to check. It is the step that would have caught the 500 `x new` used to ship.
  'policy',
  'manifest',
];

/** Each step a scaffold may not run, with the why its `skip` carries. */
const WHY = {
  roadmap:
    'a framework-repository step: it checks docs/idea/14-roadmap.md, which only the Ultimate monorepo ships',
  job: 'this app declares no job yet: x g job <name> writes one with its .job.test.ts, and then job moves from "skip" to "steps"',
  e2e: 'this app serves no page for a browser to load: x g route <name> --surface site writes one, and then e2e moves from "skip" to "steps"',
} as const satisfies Partial<Record<VerifyStepName, string>>;

/** What a scaffold ships suites for: a job (the example slice) and a page (every shape but `api`). */
export interface FloorSuites {
  readonly jobs: boolean;
  readonly pages: boolean;
}

/** The floor's `steps` and `skip` for one scaffold, derived from the suites it ships. */
export function floorSteps(suites: FloorSuites): {
  readonly steps: readonly VerifyStepName[];
  readonly skip: Readonly<Partial<Record<VerifyStepName, string>>>;
} {
  const steps = SCAFFOLD_FLOOR.filter((step) => step !== 'e2e' || suites.pages);
  return {
    steps: suites.jobs ? [...steps, 'job'] : steps,
    skip: {
      ...(suites.jobs ? {} : { job: WHY.job }),
      ...(suites.pages ? {} : { e2e: WHY.e2e }),
      roadmap: WHY.roadmap,
    },
  };
}

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
export const verifyFloor = (suites: FloorSuites): string =>
  `${JSON.stringify(
    {
      ...floorSteps(suites),
      strict: true,
      coverage: {
        lines: COVERAGE_BAR,
        funcs: COVERAGE_BAR,
        exclude: SCAFFOLD_COVERAGE_EXCLUDE,
      },
      // The rolling rail judges from the first migration: a new app has nothing to grandfather.
      rollingSince: '0',
      // Nor does the exercise pass: every proof must ask, and one call sends the default ceiling
      // at most. An app scaffolded before this key reads warnings instead (`exercise-floor.ts`).
      exercise: { unprovenMax: 0, statementsMax: STATEMENTS_MAX },
    },
    null,
    2,
  )}\n`;
