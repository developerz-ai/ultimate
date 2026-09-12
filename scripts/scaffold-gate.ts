#!/usr/bin/env bun
// A freshly scaffolded app's OWN `bin/setup && bin/check`, run as CI's check — the two commands a
// dz-runner box runs on an Ubuntu VM with bun and git and nothing else, and the contract the
// platform depends on. Nothing here re-spells them: the scripts under test are the ones `x new`
// wrote, so a change to either is measured on the next push rather than discovered on a box.
//
// NO WAIVER AND NO FIX-FOLLOW, and both absences are the point:
//
//   * The ratchet this file used to carry allowed `budgets` to stay red, because `x verify` weighs
//     `.x/build-stats.json` and nothing in the gate wrote one. `bin/check` builds BEFORE it
//     verifies, which is what makes the step measurable — so the allowance had nothing left to
//     excuse, and an allowance nobody needs is a hole waiting for the next red step to fall into.
//   * The fix-follow loop asked a weaker question than the contract does. "Red, then green after
//     running the printed `fix:`" is not what a box gets: it runs the two commands once. The FIRST
//     `bin/check` is the one that has to be green, and a gate that repairs the tree it is measuring
//     cannot tell you whether it was.
//
//   bun run scripts/scaffold-gate.ts <app dir> [--json]

// why: Bun has no path join — the two scripts are spawned by absolute path so that neither depends
// on the cwd a caller happens to have, and a runner's temp directory is not this process's.
import { join } from 'node:path';
import type { Runner } from '@ultimat3/cli';
import { exec, quoteArg, VERIFY_STEP_NAMES } from '@ultimat3/cli';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import type { GateStep } from './reference-app-gate';
import { declaredStepIssues, parseSteps, redSteps } from './reference-app-gate';

const SCRIPT = 'scaffold-gate';

/** The two scripts `x new` writes and a bare VM runs, named once. */
export const SETUP_SCRIPT = 'bin/setup';
export const CHECK_SCRIPT = 'bin/check';

/**
 * Steps that must be GREEN, not merely not-red. A skipped step satisfies every other rule here,
 * and `budgets` is the one where that would be a silent regression: `bin/check` spends a whole
 * static build ahead of the gate for no other reason than to make this step measurable, so a
 * `budgets` that reports `skipped` means the build bought nothing and nobody would see it.
 */
export const MEASURED_STEPS: readonly string[] = ['budgets'];

/**
 * Runnable in the scaffolded app itself, which is the only place the contract can be reproduced.
 * `quoteArg` because the directory is the runner's, not ours: `x new --dir` accepts a path with a
 * space in it, and `cd /tmp/my app` enters `/tmp/my` or nothing at all.
 */
export const reproduce = (dir: string): string =>
  `cd ${quoteArg(dir)} && ${SETUP_SCRIPT} && ${CHECK_SCRIPT} --json`;

/** The first half alone, for a finding raised before the gate could run. */
export const reproduceSetup = (dir: string): string => `cd ${quoteArg(dir)} && ${SETUP_SCRIPT}`;

/** Absolute, so neither script depends on the cwd a caller happens to have. Both `cd` themselves. */
export const appScript = (dir: string, script: string): string => join(dir, script);

/** Wall time per command, in the order a box runs them — what the PR body's table is made of. */
export interface ScaffoldTiming {
  readonly name: string;
  readonly ms: number;
  readonly ok: boolean;
}

export interface ScaffoldGateInput {
  /** The scaffolded app's root, as given — a temp directory on a runner, a path on a laptop. */
  readonly dir: string;
  readonly steps: readonly GateStep[] | undefined;
  /**
   * The complete step set a real run reports against — `VERIFY_STEP_NAMES` at the real call site.
   * A parameter and not a hardcoded import, the same shape `GateInput` uses, so a test pins a
   * small closed world instead of asserting against every step this repo declares today.
   */
  readonly declaredSteps: readonly string[];
}

/** Enough of a failure to read in a CI log without the finding swallowing the step table. */
const TAIL_LINES = 6;

export const lastLines = (output: string): string =>
  output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-TAIL_LINES)
    .join(' | ');

/**
 * What `bin/setup` failing looks like. Its own code, and not the gate's: a scaffold that cannot
 * install, migrate, seed or write its manifest never reaches a gate, and reporting it as a red
 * step table would name steps that never ran.
 */
export const setupFinding = (dir: string, output: string): Finding => ({
  code: 'X_SCAFFOLD_FIRST_RUN_FAILED',
  cause: `${SETUP_SCRIPT} exited non-zero in the scaffolded app at ${dir}, so nothing downstream of a working first run is under test: ${lastLines(output)}`,
  fix: reproduceSetup(dir),
  at: dir,
});

/**
 * Pure, like `gateFindings`: the caller runs the subprocesses. Every declared step must be present
 * and every present step must be green or skipped — there is no allowance to consult, because the
 * contract a box runs has none.
 */
export const scaffoldFindings = (input: ScaffoldGateInput): readonly Finding[] => {
  const { dir, steps, declaredSteps } = input;
  if (steps === undefined || steps.length === 0) {
    return [
      {
        code: 'X_SCAFFOLD_VERIFY_UNREADABLE',
        cause: `${CHECK_SCRIPT} in the scaffolded app at ${dir} printed no step table this gate could parse, so no step's verdict is known — the build ahead of the gate is in the same output and fails the same way`,
        fix: reproduce(dir),
        at: dir,
      },
    ];
  }
  const findings: Finding[] = [];

  // Before red even gets a say, exactly as `gateFindings` does it: a step MISSING from the table is
  // neither red nor green, it is a step nobody checked — so a gate that crashes mid-run and prints
  // a short table passed this whole check, and `scaffold-smoke` reported it as a green scaffold. A
  // duplicate or an unknown name means the table cannot answer either question either.
  const shapeIssues = declaredStepIssues(steps, declaredSteps);
  if (shapeIssues.length > 0) {
    findings.push({
      code: 'X_SCAFFOLD_GATE_RED',
      cause: `the scaffolded app at ${dir} printed a step table that does not match the declared steps: ${shapeIssues.join('; ')}`,
      fix: reproduce(dir),
      at: dir,
    });
  }
  const red = redSteps(steps);
  if (red.length > 0) {
    findings.push({
      code: 'X_SCAFFOLD_GATE_RED',
      cause: `${red.join(', ')} ${red.length === 1 ? 'is' : 'are'} red on the FIRST ${CHECK_SCRIPT} in the scaffolded app at ${dir}, and this gate waives nothing: a box runs ${SETUP_SCRIPT} and ${CHECK_SCRIPT} once`,
      fix: reproduce(dir),
      at: dir,
    });
  }
  const unmeasured = MEASURED_STEPS.filter((name) =>
    steps.some((step) => step.name === name && step.skipped),
  );
  if (unmeasured.length > 0) {
    findings.push({
      code: 'X_SCAFFOLD_GATE_RED',
      cause: `${unmeasured.join(', ')} reported skipped rather than green in the scaffolded app at ${dir} — ${CHECK_SCRIPT} runs a static build ahead of the gate precisely so that step measures something`,
      fix: reproduce(dir),
      at: dir,
    });
  }
  return findings;
};

/** Per-step wall time off the same `{`-line `parseSteps` reads, so the table is the run's own. */
export const stepTimings = (stdout: string): readonly ScaffoldTiming[] => {
  const line = stdout
    .split('\n')
    .map((part) => part.trim())
    .findLast((part) => part.startsWith('{'));
  if (line === undefined) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return [];
  }
  const steps =
    typeof payload === 'object' && payload !== null
      ? (payload as { readonly steps?: unknown }).steps
      : undefined;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step: unknown) => {
    if (typeof step !== 'object' || step === null) return [];
    const { name, ok, durationMs } = step as Record<string, unknown>;
    if (typeof name !== 'string') return [];
    return [{ name, ms: typeof durationMs === 'number' ? durationMs : 0, ok: ok === true }];
  });
};

/** One row per command and per gate step, in run order — pasted into the PR body as measured. */
export const timingLines = (timings: readonly ScaffoldTiming[]): readonly string[] => [
  '  wall time',
  ...timings.map((timing) => `    ${timing.ok ? '✓' : '✗'} ${timing.name}  ${timing.ms}ms`),
];

export interface ScaffoldRun {
  readonly setupMs: number;
  readonly setupOk: boolean;
  readonly setupOutput: string;
  readonly checkMs: number;
  readonly steps: readonly GateStep[] | undefined;
  readonly timings: readonly ScaffoldTiming[];
}

/**
 * `bin/setup` then `bin/check --json` — the app's own scripts, in the app's own directory, once
 * each. `bin/check` forwards `--json` to the build AND to the gate, which is why the step table is
 * taken from the LAST `{`-line rather than the first.
 *
 * A failed `bin/setup` short-circuits: `bin/check` on an app whose database was never migrated
 * reports a red table describing the setup failure twice, in steps that have nothing to do with it.
 */
export const runScaffoldGate = async (dir: string, runner: Runner): Promise<ScaffoldRun> => {
  const setup = await runner([appScript(dir, SETUP_SCRIPT)], { cwd: dir });
  if (!setup.ok) {
    return {
      setupMs: setup.durationMs,
      setupOk: false,
      setupOutput: [setup.stdout, setup.stderr].filter((part) => part.trim().length > 0).join('\n'),
      checkMs: 0,
      steps: undefined,
      timings: [{ name: SETUP_SCRIPT, ms: setup.durationMs, ok: false }],
    };
  }
  const check = await runner([appScript(dir, CHECK_SCRIPT), '--json'], { cwd: dir });
  return {
    setupMs: setup.durationMs,
    setupOk: true,
    setupOutput: '',
    checkMs: check.durationMs,
    steps: parseSteps(check.stdout),
    timings: [
      { name: SETUP_SCRIPT, ms: setup.durationMs, ok: true },
      { name: CHECK_SCRIPT, ms: check.durationMs, ok: check.ok },
      ...stepTimings(check.stdout),
    ],
  };
};

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
            cause: 'no app directory given',
            fix: 'bun run scripts/scaffold-gate.ts /tmp/demoapp',
          },
        ],
      },
      args.json,
    );
  }
  const run = await runScaffoldGate(dir, exec);
  const findings = run.setupOk
    ? scaffoldFindings({ dir, steps: run.steps, declaredSteps: VERIFY_STEP_NAMES })
    : [setupFinding(dir, run.setupOutput)];
  const red = run.steps === undefined ? [] : redSteps(run.steps);
  const total = run.steps?.length ?? 0;
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${dir}: ${SETUP_SCRIPT} in ${run.setupMs}ms, ${CHECK_SCRIPT} green in ${run.checkMs}ms — ${total - red.length} of ${total} steps pass`
          : `${findings.length} scaffold finding(s) — ${total - red.length} of ${total} steps pass`,
      findings,
      lines: [
        ...(run.steps ?? []).map(
          (step) => `  ${step.skipped ? '-' : step.ok ? '✓' : '✗'} ${step.name}`,
        ),
        ...timingLines(run.timings),
      ],
      data: { dir, red, setupMs: run.setupMs, checkMs: run.checkMs, timings: run.timings },
    },
    args.json,
  );
}
