#!/usr/bin/env bun
// A freshly scaffolded app's OWN `bun run setup && bun run verify`, run as CI's check — the two
// commands a dz-runner box runs on an Ubuntu VM with bun and git and nothing else, and the contract the
// platform depends on. Nothing here re-spells them: the scripts under test are the ones `x new`
// wrote, so a change to either is measured on the next push rather than discovered on a box.
//
// NO WAIVER AND NO FIX-FOLLOW, and both absences are the point:
//
//   * The ratchet this file used to carry allowed `budgets` to stay red, because `x verify` weighed
//     `.x/build-stats.json` and nothing in the gate wrote one. The step now builds when the stats
//     are missing (plan 101, 21), which is what makes it measurable — so the allowance has nothing
//     to excuse, and an allowance nobody needs is a hole waiting for the next red step to fall into.
//   * The fix-follow loop asked a weaker question than the contract does. "Red, then green after
//     running the printed `fix:`" is not what a box gets: it runs the two commands once. The FIRST
//     `bun run verify` is the one that has to be green, and a gate that repairs the tree it is
//     measuring cannot tell you whether it was.
//
//   bun run scripts/scaffold-gate.ts <app dir> [--json]

// why: Bun has no path resolve — both commands run with an ABSOLUTE cwd, and `resolve` is what
// makes that true for a relative `<app dir>` (`x new --dir` accepts one, so that spelling is a real
// caller). `bun run` finds the app's `package.json` from its cwd; a relative cwd resolved against a
// second relative path is how this gate once looked for `demoapp/demoapp/bin/setup`.
import { resolve } from 'node:path';
import type { Runner } from '@ultimat3/cli';
import { exec, quoteArg, VERIFY_STEP_NAMES } from '@ultimat3/cli';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { strangerOverlayAt } from './lib/stranger-env';
import type { GateStep } from './reference-app-gate';
import {
  declaredStepIssues,
  parseStepPayloads,
  parseSteps,
  redSteps,
  stepLines,
} from './reference-app-gate';

const SCRIPT = 'scaffold-gate';

/**
 * The two commands `x new`'s README opens with and a bare VM runs, named once. `bun run`, never a
 * `bin/` path: the scripts are `bin/*.ts` that Bun runs, the same on Linux, macOS and Windows.
 */
export const SETUP_COMMAND = 'bun run setup';
export const GATE_COMMAND = 'bun run verify';

/**
 * Steps that must be GREEN, not merely not-red. A skipped step satisfies every other rule here,
 * and `budgets` is the one where that would be a silent regression: on a fresh scaffold it spends
 * a whole static build for no other reason than to make itself measurable, so a
 * `budgets` that reports `skipped` means the build bought nothing and nobody would see it.
 */
export const MEASURED_STEPS: readonly string[] = ['budgets'];

/**
 * Runnable in the scaffolded app itself, which is the only place the contract can be reproduced.
 * `quoteArg` because the directory is the runner's, not ours: `x new --dir` accepts a path with a
 * space in it, and `cd /tmp/my app` enters `/tmp/my` or nothing at all.
 */
export const reproduce = (dir: string): string =>
  `cd ${quoteArg(dir)} && ${SETUP_COMMAND} && ${GATE_COMMAND} --json`;

/** The first half alone, for a finding raised before the gate could run. */
export const reproduceSetup = (dir: string): string => `cd ${quoteArg(dir)} && ${SETUP_COMMAND}`;

/** Absolute, so neither command depends on the cwd a caller happens to have. */
export const appDir = (dir: string): string => resolve(dir);

/** `bun run <script>` through the running Bun's own path: no shell and no PATH lookup decide it. */
export const appCommand = (script: 'setup' | 'verify', ...args: string[]): string[] => [
  process.execPath,
  'run',
  script,
  ...args,
];

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
 * What `bun run setup` failing looks like. Its own code, and not the gate's: a scaffold that cannot
 * install, migrate, seed or write its manifest never reaches a gate, and reporting it as a red
 * step table would name steps that never ran.
 */
export const setupFinding = (dir: string, output: string): Finding => ({
  code: 'X_SCAFFOLD_FIRST_RUN_FAILED',
  cause: `${SETUP_COMMAND} exited non-zero in the scaffolded app at ${dir}, so nothing downstream of a working first run is under test: ${lastLines(output)}`,
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
        cause: `${GATE_COMMAND} in the scaffolded app at ${dir} printed no step table this gate could parse, so no step's verdict is known — the build the budgets step runs is in the same output and fails the same way`,
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
      cause: `${red.join(', ')} ${red.length === 1 ? 'is' : 'are'} red on the FIRST ${GATE_COMMAND} in the scaffolded app at ${dir}, and this gate waives nothing: a box runs ${SETUP_COMMAND} and ${GATE_COMMAND} once`,
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
      cause: `${unmeasured.join(', ')} reported skipped rather than green in the scaffolded app at ${dir} — on a fresh scaffold that step runs a static build precisely so it measures something`,
      fix: reproduce(dir),
      at: dir,
    });
  }
  return findings;
};

/**
 * Per-step wall time off the SAME parsed payload the ratchet reads — `parseStepPayloads` is the one
 * place that decides which line is the table and whether it can be read at all. `asStep` drops
 * `durationMs` because the ratchet does not judge it, so the timings are mapped from the raw
 * payload rather than from `parseSteps`' result.
 */
export const stepTimings = (stdout: string): readonly ScaffoldTiming[] =>
  (parseStepPayloads(stdout) ?? []).flatMap((step: unknown) => {
    if (typeof step !== 'object' || step === null) return [];
    const { name, ok, durationMs } = step as Record<string, unknown>;
    if (typeof name !== 'string') return [];
    return [{ name, ms: typeof durationMs === 'number' ? durationMs : 0, ok: ok === true }];
  });

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
 * `bun run setup` then `bun run verify --json` — the app's own scripts, in the app's own directory,
 * once each. The step table is taken from the LAST `{`-line rather than the first, so an app whose
 * own script prints a document ahead of the gate's is read the same way.
 *
 * A failed `bun run setup` short-circuits: `bun run verify` on an app whose database was never
 * migrated reports a red table describing the setup failure twice, in steps that have nothing to do with it.
 */
export const runScaffoldGate = async (
  dir: string,
  runner: Runner,
  /** An `exec` overlay: `strangerOverlayAt` — the scaffold is not this repo's code. */
  env: Readonly<Record<string, string | undefined>>,
): Promise<ScaffoldRun> => {
  const setup = await runner(appCommand('setup'), { cwd: appDir(dir), env });
  if (!setup.ok) {
    return {
      setupMs: setup.durationMs,
      setupOk: false,
      setupOutput: [setup.stdout, setup.stderr].filter((part) => part.trim().length > 0).join('\n'),
      checkMs: 0,
      steps: undefined,
      timings: [{ name: SETUP_COMMAND, ms: setup.durationMs, ok: false }],
    };
  }
  const check = await runner(appCommand('verify', '--json'), { cwd: appDir(dir), env });
  return {
    setupMs: setup.durationMs,
    setupOk: true,
    setupOutput: '',
    checkMs: check.durationMs,
    steps: parseSteps(check.stdout),
    timings: [
      { name: SETUP_COMMAND, ms: setup.durationMs, ok: true },
      { name: GATE_COMMAND, ms: check.durationMs, ok: check.ok },
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
  // The scaffold's own scripts run code this checkout did not write, and this process holds
  // whatever Bun loaded from the repo's `.env` (`NPM_TOKEN`): an allowlist only.
  const run = await runScaffoldGate(dir, exec, strangerOverlayAt(repoRoot()));
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
          ? `${dir}: ${SETUP_COMMAND} in ${run.setupMs}ms, ${GATE_COMMAND} green in ${run.checkMs}ms — ${total - red.length} of ${total} steps pass`
          : `${findings.length} scaffold finding(s) — ${total - red.length} of ${total} steps pass`,
      findings,
      // The tracked apps' renderer: a red step brings its own findings and captured output, so a
      // CI log names WHY package-shape is red rather than only that it is. Nothing is pinned here.
      lines: [...stepLines(run.steps ?? [], {}), ...timingLines(run.timings)],
      data: { dir, red, setupMs: run.setupMs, checkMs: run.checkMs, timings: run.timings },
    },
    args.json,
  );
}
