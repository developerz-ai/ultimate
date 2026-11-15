#!/usr/bin/env bun
// `scaffold-gate.ts`'s one pass, plus the question it does not ask: did every step RUN a check?
// A green table can be green on skips; this reads the same `bun run verify --json` document and
// holds each of the gate's steps to a check that ran — a suite step to `tests.ran > 0` — unless the
// app's own `x.verify.json` excuses it in `skip` with a written why. One run of the gate, not two.
//
//   bun run scripts/scaffold-smoke-steps.ts <app dir> [--json]

// why: Bun has no path join; the floor file is read beside the app it gates.
import { join } from 'node:path';
import type { Runner } from '@ultimat3/cli';
import { exec, VERIFY_STEP_NAMES } from '@ultimat3/cli';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { strangerOverlayAt } from './lib/stranger-env';
import { parseStepPayloads, redSteps, stepLines } from './reference-app-gate';
import { reproduce, runScaffoldGate, scaffoldFindings, setupFinding } from './scaffold-gate';

const SCRIPT = 'scaffold-smoke-steps';

/** One step as this check reads it: whether it ran, and how many tests when it is a suite. */
export interface RanStep {
  readonly name: string;
  readonly skipped: boolean;
  /** `tests.ran` — absent for a step that spawned no test process (a check step). */
  readonly ran?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `--json` step payloads, read for `skipped` and `tests.ran` alone; a malformed one is dropped. */
export const ranSteps = (stdout: string): readonly RanStep[] =>
  (parseStepPayloads(stdout) ?? []).flatMap((payload): RanStep[] => {
    if (!isRecord(payload) || typeof payload['name'] !== 'string') return [];
    const tests = payload['tests'];
    const ran = isRecord(tests) && typeof tests['ran'] === 'number' ? tests['ran'] : undefined;
    return [
      {
        name: payload['name'],
        skipped: payload['skipped'] === true,
        ...(ran === undefined ? {} : { ran }),
      },
    ];
  });

/** A step ran a check: it was not skipped, and a suite step executed at least one test. */
export const ranACheck = (step: RanStep): boolean =>
  !step.skipped && (step.ran === undefined || step.ran > 0);

/** `skip` in an `x.verify.json` text: the steps it excuses with a non-blank why. */
export const excusedSteps = (floorText: string | undefined): readonly string[] => {
  if (floorText === undefined) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(floorText);
  } catch {
    return [];
  }
  const skip = isRecord(payload) ? payload['skip'] : undefined;
  if (!isRecord(skip)) return [];
  return Object.entries(skip).flatMap(([step, why]) =>
    typeof why === 'string' && why.trim() !== '' ? [step] : [],
  );
};

export interface RanInput {
  readonly dir: string;
  readonly steps: readonly RanStep[];
  readonly declared: readonly string[];
  readonly excused: readonly string[];
}

/** Pure: every declared step that ran no check and is not excused, as one finding. */
export const unrunFindings = (input: RanInput): readonly Finding[] => {
  const unrun = input.declared.filter((name) => {
    if (input.excused.includes(name)) return false;
    const step = input.steps.find((one) => one.name === name);
    return step === undefined || !ranACheck(step);
  });
  if (unrun.length === 0) return [];
  return [
    {
      code: 'X_SCAFFOLD_GATE_RED',
      cause: `${unrun.join(', ')} ran no check in the scaffolded app at ${input.dir} — skipped, or a suite of zero tests — and its x.verify.json "skip" gives no why: a fresh scaffold runs every step it does not excuse`,
      fix: reproduce(input.dir),
      at: input.dir,
    },
  ];
};

/** `N of M ran a check, K excused` — the job's one-line answer. */
export const ranSummary = (input: RanInput): string => {
  const ran = input.declared.filter((name) =>
    input.steps.some((step) => step.name === name && ranACheck(step)),
  ).length;
  const excused = input.excused.filter((name) => input.declared.includes(name));
  return `${String(ran)} of ${String(input.declared.length)} steps ran a check${excused.length === 0 ? '' : `, excused: ${excused.join(', ')}`}`;
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
            fix: 'bun run scripts/scaffold-smoke-steps.ts /tmp/demoapp',
          },
        ],
      },
      args.json,
    );
  }
  // The gate's own stdout, kept as it passes: `runScaffoldGate` parses the table for its verdict,
  // and this check reads the counts off the very same document.
  let verifyStdout = '';
  const recording: Runner = async (command, options) => {
    const result = await exec(command, options);
    if (command.includes('verify')) verifyStdout = result.stdout;
    return result;
  };
  const run = await runScaffoldGate(dir, recording, strangerOverlayAt(repoRoot()));
  const floor = Bun.file(join(dir, 'x.verify.json'));
  const input: RanInput = {
    dir,
    steps: ranSteps(verifyStdout),
    declared: VERIFY_STEP_NAMES,
    excused: excusedSteps((await floor.exists()) ? await floor.text() : undefined),
  };
  const findings = run.setupOk
    ? [
        ...scaffoldFindings({ dir, steps: run.steps, declaredSteps: VERIFY_STEP_NAMES }),
        ...unrunFindings(input),
      ]
    : [setupFinding(dir, run.setupOutput)];
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary: `${dir}: ${ranSummary(input)}`,
      findings,
      lines: stepLines(run.steps ?? [], {}),
      data: { dir, red: run.steps === undefined ? [] : redSteps(run.steps), steps: input.steps },
    },
    args.json,
  );
}
