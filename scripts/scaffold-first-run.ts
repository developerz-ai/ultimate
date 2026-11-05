#!/usr/bin/env bun

// EVERY GENERATOR, run over an app whose `bun run setup` has already run. `bun run setup` is the
// documented first run and CI now runs the real script (`scripts/scaffold-gate.ts`), so the three
// database commands and the manifest write that used to be re-spelled here are gone: they were an
// approximation of a script nobody executed, and two spellings of one sequence is the second path
// axiom 1 forbids. What is left is the half `bun run setup` does not do and no other check reaches
// — `x g` for every kind the CLI offers, then the migration the entities they emit earn.
//
// The generators all exit 0 even when what they emit cannot resolve an import, so this sweep is not
// itself the catch: the `bun run verify` that follows it is (`TS2307: Cannot find module '../repo'`
// was invisible to every exit code in this job). This is what gives that gate something to
// typecheck.
//
// Takes a scaffolded app whose `bun run setup` has run and is not idempotent against a used one:
// `x g` never clobbers, so a second run over the same directory is fourteen `X_GENERATE_CONFLICT`s.
//
//   bun run scripts/scaffold-first-run.ts <app dir> [--json]

import { resolve } from 'node:path';
import { GENERATORS } from '@ultimat3/cli';
import { renderFixShellArg } from '../packages/core/src/error-render';
import { parseScriptArgs } from './lib/args';
import { localBin } from './lib/local-bin';
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
 * The app's own `x`, resolved through its `node_modules`, not this repo's — `x.exe` on Windows,
 * where `bun install` links no extensionless `x`. A scaffolded app is the
 * thing under test, and `bun run x` here would run the CLI out of the checkout — proving the
 * workspace works, which is the claim the job already cannot make.
 */
export const appBin = (dir: string): string => localBin(resolve(dir), 'x');

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
 * `x g query` and `x g backfill` read a table and never create one (`X_FEATURE_REQUIRED`), so both
 * run into the slice `x g resource` wrote: first in `GENERATORS`, which a test here holds.
 */
const READ_A_SLICE: ReadonlySet<string> = new Set(['query', 'backfill']);
const RESOURCE_SLICE = generatorName('resource');
const SOLO_SLICE = 'smoke-solo';

/**
 * A slice single-tenant by the edit `x g entity`'s own comment describes, written by hand because no
 * generator writes one: no `tenant`, no `orgId`. What `SECOND_SHAPES` generates into it must hold
 * no `orgId` and still gate, so the `bun run verify` after this sweep is what proves it.
 */
export const SOLO_SLICE_FILES: Readonly<Record<string, string>> = {
  [`apps/web/app/${SOLO_SLICE}/entity.ts`]: `// A table with no tenant, so \`x g action\` and \`x g mutator\` read this file and write no org.
import { entity, text, uuid } from '@ultimat3/entity';

export const smokeSolo = entity('smoke_solos', {
  columns: { id: uuid().primaryKey(), title: text({ max: 200 }) },
});

export type SmokeSolo = typeof smokeSolo.$row;
`,
  [`apps/web/app/${SOLO_SLICE}/entity.test.ts`]: `// The table names no tenant: what the generators read.
import { expect, unitTest } from '@ultimat3/testing';
import { smokeSolo } from './entity';

unitTest('smokeSolo is not tenant-scoped', () => {
  expect(smokeSolo.$tenantColumn).toBeNull();
});
`,
  [`apps/web/app/${SOLO_SLICE}/repo.test.ts`]: `// The one export: the app's coverage floor counts every source file a sweep plants.
import { expect, unitTest } from '@ultimat3/testing';
import { smokeSoloCount } from './repo';

unitTest('smokeSoloCount answers', () => {
  expect(smokeSoloCount()).toBe(0);
});
`,
  [`apps/web/app/${SOLO_SLICE}/repo.ts`]: `// No \`byId\`: the generated body reads no row, so this slice needs no typed handle to gate.
export const smokeSoloCount = (): number => 0;
`,
};

/**
 * The shapes a bare \`g <kind>\` never reaches, each a generated file the \`lint\` and \`typecheck\`
 * after this sweep refuse if a template breaks it. Into the resource's slice: its \`policy.ts\` is on
 * disk by then and reads as an author's, so the contract test must hold no constant it leaves
 * unread. Into the single-tenant slice: no org anywhere.
 */
const SECOND_SHAPES: readonly FirstRunStep[] = (['action', 'mutator'] as const).flatMap((kind) =>
  [RESOURCE_SLICE, SOLO_SLICE].map((slice) => ({
    name: `g ${kind} --feature ${slice}`,
    args: ['g', kind, `${generatorName(kind)}-${slice}`, '--feature', slice, '--json'],
  })),
);

/** The hand-written half of `SECOND_SHAPES`, on disk before the first step runs. */
export const plantHandWrittenSlices = async (dir: string): Promise<void> => {
  for (const [path, contents] of Object.entries(SOLO_SLICE_FILES)) {
    await Bun.write(resolve(dir, path), contents);
  }
};

/**
 * The generators are projected from `GENERATORS`, never a hand-written list: the defect was four of
 * thirteen, so a sample would likely have missed it — and a new generator is covered the day
 * it lands rather than the day someone remembers this file.
 *
 * | # | Step | What only this step can tell you |
 * |---|---|---|
 * | 1 | `g <kind>` x 14 | every generator runs |
 * | 2 | `db gen "generated"` | `x db gen` against entities from every generator that emits one, in one diff — the only migration in CI written from generator output rather than from the scaffold's own example entity |
 *
 * Nothing APPLIES that migration here, deliberately: `bun run setup` runs `x db migrate`, and the
 * `scripts/scaffold-gate.ts` run after this sweep runs `bun run setup` again — which is also what
 * makes the script's own "idempotent, safe to re-run" claim a measurement rather than a comment.
 *
 * What is NOT here, and where it went: `x db migrate` over the empty migrations directory, the
 * `x db gen "initial"` that follows it, and `x manifest` are `bun run setup`'s own lines, run from
 * `bun run setup` itself by `scripts/scaffold-gate.ts` before this sweep starts. The
 * empty-directory migrate in particular was never a step of the documented first run —
 * `bun run setup` generates the initial migration BEFORE it migrates — so re-spelling it here
 * tested a path no app takes.
 */
export const firstRunPlan = (): readonly FirstRunStep[] => [
  ...GENERATORS.map((kind) => ({
    name: `g ${kind}`,
    // An app has one sign-in, named by the flag that picks its shape and never by a `<name>`.
    args:
      kind === 'sign-in'
        ? ['g', kind, '--password', '--json']
        : [
            'g',
            kind,
            generatorName(kind),
            ...(READ_A_SLICE.has(kind) ? ['--feature', RESOURCE_SLICE] : []),
            '--json',
          ],
  })),
  ...SECOND_SHAPES,
  { name: 'db gen generated', args: ['db', 'gen', 'generated', '--json'] },
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
  cause: `${step.name} ${result.timedOut ? 'was killed at its deadline' : `exited ${result.code}`} in the scaffolded app: ${verdict(result.output)}`,
  fix: `cd ${renderFixShellArg(dir, '<the scaffolded app directory>')} && ${appBin(dir)} ${step.args.join(' ')}`,
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
            fix: `cd ${renderFixShellArg(dir, '<the scaffolded app directory>')} && bun install`,
            at: dir,
          },
        ],
      },
      args.json,
    );
  }
  const steps = firstRunPlan();
  await plantHandWrittenSlices(dir);
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
