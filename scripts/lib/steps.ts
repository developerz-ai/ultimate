// Named steps with their own pass/fail and duration — the same shape `x verify` reports, so the
// framework repo's gate and a generated app's gate print the same thing.

import type { Finding } from './log';

export interface StepOutcome {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly output?: string;
}

export interface Step {
  readonly name: string;
  readonly summary: string;
  run(): Promise<StepOutcome>;
}

export interface StepReport {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly findings: readonly Finding[];
  readonly output?: string;
}

export interface RunStepsOptions {
  readonly only?: readonly string[];
  readonly skip?: readonly string[];
}

/** Never bails early: one run should surface every failure, not the first one. */
export async function runSteps(
  steps: readonly Step[],
  options: RunStepsOptions = {},
): Promise<readonly StepReport[]> {
  const only = options.only ?? [];
  const skip = options.skip ?? [];
  const chosen = steps.filter(
    (step) => (only.length === 0 || only.includes(step.name)) && !skip.includes(step.name),
  );
  const reports: StepReport[] = [];
  for (const step of chosen) {
    const started = performance.now();
    const outcome = await step.run().catch(
      (error: unknown): StepOutcome => ({
        ok: false,
        findings: [
          {
            code: 'X_VERIFY_FAILED',
            cause: `step "${step.name}" threw: ${error instanceof Error ? error.message : String(error)}`,
            fix: `bun run verify --only ${step.name} --json`,
          },
        ],
      }),
    );
    reports.push({
      name: step.name,
      ok: outcome.ok,
      durationMs: Math.round(performance.now() - started),
      findings: outcome.findings,
      ...(outcome.output === undefined ? {} : { output: outcome.output }),
    });
  }
  return reports;
}

export const stepLines = (reports: readonly StepReport[], verbose: boolean): readonly string[] => {
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(`  ${report.ok ? '✓' : '✗'} ${report.name.padEnd(14)} ${report.durationMs}ms`);
    if (report.output !== undefined && (verbose || !report.ok)) {
      for (const line of report.output.split('\n').slice(0, 40)) lines.push(`      | ${line}`);
    }
  }
  return lines;
};
