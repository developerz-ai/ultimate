#!/usr/bin/env bun

// What a stranger does in the first ten minutes after `x new`, run as a check: the documented
// first-run sequence, then EVERY generator the CLI offers, then the migration those generators
// earn. The scaffold-smoke job proved `x new` → `bun install` → `x verify` and nothing else, so it
// invoked no generator and opened no database, and three shipped defects sat in that blind spot.
//
// Takes a FRESHLY scaffolded app and is not idempotent against a used one: `x g` never clobbers,
// so a second run over the same directory is thirteen `X_GENERATE_CONFLICT`s. `x new` first.
//
//   bun run scripts/scaffold-first-run.ts <app dir> [--json]

import { join } from 'node:path';
import { GENERATORS } from '@ultimat3/cli';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import type { RunResult } from './lib/run';
import { run } from './lib/run';

const SCRIPT = 'scaffold-first-run';

// One code for every step here — a first-run command the scaffolded app cannot complete — and
// spelled as a LITERAL at each site, the way `scaffold-gate.ts` and `scaffold-smoke-overrides.ts`
// spell theirs. `collectErrorCodes` (scripts/manifest.ts) reads literals; behind a constant the
// code is invisible to `framework.manifest.json` and to the wiki check that keeps it documented,
// which is a code that ships enforced by nothing.

/**
 * The app's own `x`, resolved through its `node_modules`, not this repo's. A scaffolded app is the
 * thing under test, and `bun run x` here would run the CLI out of the checkout — proving the
 * workspace works, which is the claim the job already cannot make.
 */
export const appBin = (dir: string): string => join(dir, 'node_modules', '.bin', 'x');

export interface FirstRunStep {
  /** Names the step in the log and in the `fix:`, so a red run says WHICH generator broke. */
  readonly name: string;
  readonly args: readonly string[];
}

/**
 * `:` is legal in a generator kind (`admin:page`) and illegal in a path segment every generator
 * writes, so the emitted name is the kind with the colon flattened.
 */
export const generatorName = (kind: string): string => `smoke-${kind.replace(/:/g, '-')}`;

/**
 * Six phases, and every one of them earns its line. The generators are projected from `GENERATORS`,
 * never a hand-written list: the defect was four of thirteen, so a sample would likely have missed
 * it — and a fourteenth generator is covered the day it lands rather than the day someone remembers
 * this file.
 *
 * | # | Step | What only this step can tell you |
 * |---|---|---|
 * | 1 | `db migrate` (empty) | `packages/db/migrations` does not exist on a fresh scaffold and an apply over nothing is `applied 0`, not an error. This is the regression guard for the cycle #121 fixed: the scaffold used to hand-write `0000_initial.sql` with no snapshot sidecar, and a second writer coming back turns this green step red on `X_DB_DRIFT` before anything else has run |
 * | 2 | `db gen "initial"` | the app's documented first command — `bin/setup` runs exactly this line (`templates/scaffold-docs.ts`). It is what makes `x verify`'s `drift` step green, and a scaffold that reached `x verify` without it is red on `drift` by construction |
 * | 3 | `db migrate` (initial) | what step 2 wrote actually applies — a generator that emits SQL Postgres rejects is invisible to a check that only reads the file |
 * | 4 | `g <kind>` × 13 | every generator runs. They all exit 0 even when broken, so this step is not the catch: the `x verify` that follows is, and this is what gives it something to typecheck |
 * | 5 | `db gen "generated"` | `x db gen` against entities from EIGHT different generators in one diff — the only migration in CI written from generator output rather than from the scaffold's own example entity |
 * | 6 | `db migrate` (generated) | step 5's migration applies too |
 *
 * Step 1 looks like it duplicates step 3 and costs almost nothing: measured, it is 4.8s against
 * 2.9s for step 3, and the difference is PGlite's cold start on `.x/pgdata` — a boot the sequence
 * pays exactly once whichever step goes first. Its marginal cost is ~2s.
 */
export const firstRunPlan = (): readonly FirstRunStep[] => [
  { name: 'db migrate (empty)', args: ['db', 'migrate', '--json'] },
  { name: 'db gen initial', args: ['db', 'gen', 'initial', '--json'] },
  { name: 'db migrate (initial)', args: ['db', 'migrate', '--json'] },
  ...GENERATORS.map((kind) => ({
    name: `g ${kind}`,
    args: ['g', kind, generatorName(kind), '--json'],
  })),
  { name: 'db gen generated', args: ['db', 'gen', 'generated', '--json'] },
  { name: 'db migrate (generated)', args: ['db', 'migrate', '--json'] },
];

/** Enough of the failure to read in a CI log without the finding swallowing the step table. */
const CAUSE_LIMIT = 500;

/**
 * The one line worth putting in a `cause:`. Every step passes `--json`, so its VERDICT is the JSON
 * object on the last line — and the head of the output is the migrator's own info logging, which is
 * what a naive `slice(0, 500)` reported for a red `x db migrate`: "applied 1 migration", from the
 * finding that says it failed. A step that died before printing a verdict has nothing better than
 * its first bytes, so that is the fallback.
 */
export const verdict = (output: string): string => {
  const lines = output.split('\n').filter((line) => line.trim().length > 0);
  const last = lines.at(-1) ?? '';
  return (last.startsWith('{') ? last : output).slice(0, CAUSE_LIMIT);
};

/**
 * The `fix:` is the one command that reproduces this step and nothing else — pasted verbatim it
 * runs, which a `cd <dir> && bun run verify` would not do for a generator that never got that far.
 */
export const stepFinding = (dir: string, step: FirstRunStep, result: RunResult): Finding => ({
  code: 'X_SCAFFOLD_FIRST_RUN_FAILED',
  cause: `${step.name} exited ${result.code} in the scaffolded app: ${verdict(result.output)}`,
  fix: `cd ${dir} && ${appBin(dir)} ${step.args.join(' ')}`,
  at: dir,
});

export interface StepOutcome {
  readonly step: FirstRunStep;
  readonly result: RunResult;
}

export type Runner = (
  command: readonly string[],
  options: { readonly cwd: string },
) => Promise<RunResult>;

/**
 * Every step runs, and a failure never stops the sweep: the human who found this reported FOUR
 * broken generators, and a loop that exits on the first one turns four fixes into four CI rounds.
 */
export const runFirstRun = async (
  dir: string,
  steps: readonly FirstRunStep[],
  runner: Runner,
): Promise<readonly StepOutcome[]> => {
  const bin = appBin(dir);
  const outcomes: StepOutcome[] = [];
  for (const step of steps) {
    outcomes.push({ step, result: await runner([bin, ...step.args], { cwd: dir }) });
  }
  return outcomes;
};

export const firstRunFindings = (
  dir: string,
  outcomes: readonly StepOutcome[],
): readonly Finding[] =>
  outcomes.flatMap((outcome) =>
    outcome.result.ok ? [] : [stepFinding(dir, outcome.step, outcome.result)],
  );

/**
 * The whole output of every FAILING step, in full — the finding's cause is truncated so the summary
 * stays readable, and a truncated stack is what makes a red CI run a second local reproduction
 * instead of an answer.
 */
export const firstRunLines = (outcomes: readonly StepOutcome[]): readonly string[] =>
  outcomes.flatMap((outcome) => [
    `  ${outcome.result.ok ? '✓' : '✗'} ${outcome.step.name} (${outcome.result.durationMs}ms)`,
    ...(outcome.result.ok
      ? []
      : outcome.result.output.split('\n').map((line) => `      | ${line}`)),
  ]);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const dir = args.positionals[0];
  if (dir === undefined) {
    report(
      {
        ok: false,
        script: SCRIPT,
        summary: 'a scaffolded app directory is required',
        findings: [
          {
            code: 'X_CLI_BAD_FLAG',
            cause: 'no app directory given, so there is no scaffolded app to run the first run in',
            fix: 'bun run scripts/scaffold-first-run.ts /tmp/demoapp --json',
          },
        ],
      },
      args.json,
    );
  }
  const bin = appBin(dir);
  // A missing `x` is not a failed generator, and reporting it as sixteen failed steps would bury
  // the one thing wrong: `bun install` never ran, or never linked the CLI.
  if (!(await Bun.file(bin).exists())) {
    report(
      {
        ok: false,
        script: SCRIPT,
        summary: `no x binary at ${bin}`,
        findings: [
          {
            code: 'X_SCAFFOLD_FIRST_RUN_FAILED',
            cause: `${bin} does not exist, so no command can be run in the scaffolded app`,
            fix: `cd ${dir} && bun install --linker=hoisted`,
            at: dir,
          },
        ],
      },
      args.json,
    );
  }
  const steps = firstRunPlan();
  const outcomes = await runFirstRun(dir, steps, run);
  const findings = firstRunFindings(dir, outcomes);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${dir}: ${steps.length} of ${steps.length} first-run commands pass`
          : `${findings.length} of ${steps.length} first-run commands failed in ${dir}`,
      findings,
      lines: firstRunLines(outcomes),
      data: {
        dir,
        steps: outcomes.map((outcome) => ({
          name: outcome.step.name,
          ok: outcome.result.ok,
          code: outcome.result.code,
          durationMs: outcome.result.durationMs,
        })),
      },
    },
    args.json,
  );
}
