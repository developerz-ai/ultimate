#!/usr/bin/env bun
// A freshly scaffolded app's own `x verify`, held to a ratchet instead of waived. The CI step ran
// `continue-on-error: true`, so the job that answers "can a stranger scaffold an app that gates"
// could not fail on any of the 17 steps — a waiver justified by ONE pinned typecheck gap that
// covered all of them.
//
// THE RATCHET SHRINKS ITSELF, and that is the half worth stating: the `stale` rule fails the job
// when an allowed step starts PASSING, so removing the allowance is mandatory rather than tidy
// housekeeping somebody gets to. It has already been load-bearing twice — `typecheck`, then `lint`
// and `errors` — each of which would otherwise have kept excusing whatever landed behind it. The
// example below is `budgets` for exactly that reason: `typecheck` is green in a scaffolded app now,
// so pasting the OLD example from an earlier copy of this line reports `stale` immediately — which
// is why `scaffold-gate.test.ts` holds every example in this file to what `ci.yml` actually allows.
//
//   bun run scripts/scaffold-gate.ts <app dir> [--allow-red budgets] [--fix-follow] [--json]

import type { Runner } from '@ultimat3/cli';
import { exec, VERIFY_STEP_NAMES } from '@ultimat3/cli';
import { flagBool, flagList, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import type { GateStep } from './reference-app-gate';
import { declaredStepIssues, parseSteps, redSteps } from './reference-app-gate';
import { fixFollowFindings, followFixes, staticBuildFindings } from './scaffold-fix-follow';

/** Where the allowance is declared, so a stale waiver's `fix:` names the file that carries it. */
export const WAIVER_FILE = '.github/workflows/ci.yml';

const SCRIPT = 'scaffold-gate';

/** Runnable in the scaffolded app itself, which is the only place the gate can be reproduced. */
export const reproduce = (dir: string): string => `cd ${dir} && bun run verify --json`;

export interface ScaffoldGateInput {
  /** The scaffolded app's root, as given — a temp directory on a runner, a path on a laptop. */
  readonly dir: string;
  readonly steps: readonly GateStep[] | undefined;
  /** Steps allowed to fail today. Every entry must STILL fail, exactly as `expectedRed` does. */
  readonly allowRed: readonly string[];
  /**
   * The complete step set a real run reports against — `VERIFY_STEP_NAMES` at the real call site.
   * A parameter and not a hardcoded import, the same shape `GateInput` uses, so a test pins a
   * small closed world instead of asserting against every step this repo declares today.
   */
  readonly declaredSteps: readonly string[];
}

/**
 * Pure, like `gateFindings`: the caller runs the subprocess. The ratchet is the same shape the
 * tracked apps get and it fails in both directions — a red step nobody allowed is a regression, and
 * an allowed step that has started passing is a waiver that has to go, or the one known gap the
 * waiver was written for keeps excusing whatever lands behind it.
 */
export const scaffoldFindings = (input: ScaffoldGateInput): readonly Finding[] => {
  const { dir, steps, allowRed, declaredSteps } = input;
  if (steps === undefined || steps.length === 0) {
    return [
      {
        code: 'X_SCAFFOLD_GATE_RED',
        cause: `the scaffolded app at ${dir} printed no step table, so not one step could be checked`,
        fix: reproduce(dir),
        at: dir,
      },
    ];
  }
  const findings: Finding[] = [];

  // Before red and stale even get a say, exactly as `gateFindings` does it: a step MISSING from the
  // table is neither red nor allowed, it is a step nobody checked — so a gate that crashes mid-run
  // and prints a short table passed this whole check, and `scaffold-smoke` reported it as a green
  // scaffold. A duplicate or an unknown name means the table cannot answer either question either.
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
  const unexpected = red.filter((name) => !allowRed.includes(name));
  if (unexpected.length > 0) {
    findings.push({
      code: 'X_SCAFFOLD_GATE_RED',
      cause: `${unexpected.join(', ')} ${unexpected.length === 1 ? 'is' : 'are'} red in the scaffolded app and allowed to fail by nothing`,
      fix: reproduce(dir),
      at: dir,
    });
  }
  const stale = allowRed.filter((name) => !red.includes(name));
  if (stale.length > 0) {
    findings.push({
      code: 'X_SCAFFOLD_GATE_RED',
      cause: `${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} allowed to fail in the scaffolded app and no longer ${stale.length === 1 ? 'does' : 'do'}`,
      fix: `drop --allow-red ${stale.join(',')} from the scaffold-smoke verify step in ${WAIVER_FILE}`,
      at: WAIVER_FILE,
    });
  }
  return findings;
};

/** `bun run verify` is the script `x new` writes, so this runs the app's gate and not a copy. */
export const runScaffoldGate = async (
  dir: string,
  runner: Runner,
): Promise<readonly GateStep[] | undefined> =>
  parseSteps((await runner(['bun', 'run', 'verify', '--json'], { cwd: dir })).stdout);

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
            // `budgets`, not `typecheck`: a fix line is pasted verbatim, and `typecheck` passes in
            // a scaffolded app now — so the old example produced an instant `stale` finding for a
            // step that was already green. The example must be a step the ratchet actually allows.
            fix: 'bun run scripts/scaffold-gate.ts /tmp/demoapp --allow-red budgets',
          },
        ],
      },
      args.json,
    );
  }
  // `flagList` is the parser every other script's comma flag already goes through.
  const allowRed = flagList(args, 'allow-red');
  /**
   * OFF by default, and that is deliberate: the loop RUNS commands inside the app directory, so a
   * caller opts in. `scaffold-smoke` is the one caller that should — it owns a throwaway checkout
   * outside this repo, which is the only place a gate may repair the tree it is measuring.
   */
  const follow = flagBool(args, 'fix-follow');
  const followed = follow ? await followFixes(dir, exec) : undefined;
  const steps = followed === undefined ? await runScaffoldGate(dir, exec) : followed.steps;
  const findings = [
    ...scaffoldFindings({ dir, steps, allowRed, declaredSteps: VERIFY_STEP_NAMES }),
    ...(followed === undefined ? [] : fixFollowFindings(dir, followed)),
    // Only after the loop reached green: a build over an app that is already red says nothing
    // about whether the BUILD is what broke `lint`.
    ...(followed?.green === true ? await staticBuildFindings(dir, exec) : []),
  ];
  const red = steps === undefined ? [] : redSteps(steps);
  const total = steps?.length ?? 0;
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${dir}: ${total - red.length} of ${total} pass, ${red.length} red (all allowed)`
          : `${findings.length} scaffold finding(s) — ${total - red.length} of ${total} pass`,
      findings,
      lines: (steps ?? []).map(
        (step) => `  ${step.skipped ? '-' : step.ok ? '✓' : '✗'} ${step.name}`,
      ),
      data: { dir, red, allowRed },
    },
    args.json,
  );
}
