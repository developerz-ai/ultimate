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
//   bun run scripts/scaffold-gate.ts <app dir> [--allow-red budgets] [--json]

import type { Runner } from '@ultimat3/cli';
import { exec } from '@ultimat3/cli';
import { flagList, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import type { GateStep } from './reference-app-gate';
import { parseSteps, redSteps } from './reference-app-gate';

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
}

/**
 * Pure, like `gateFindings`: the caller runs the subprocess. The ratchet is the same shape the
 * tracked apps get and it fails in both directions — a red step nobody allowed is a regression, and
 * an allowed step that has started passing is a waiver that has to go, or the one known gap the
 * waiver was written for keeps excusing whatever lands behind it.
 */
export const scaffoldFindings = (input: ScaffoldGateInput): readonly Finding[] => {
  const { dir, steps, allowRed } = input;
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
  const steps = await runScaffoldGate(dir, exec);
  const findings = scaffoldFindings({ dir, steps, allowRed });
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
