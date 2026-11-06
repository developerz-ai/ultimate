// The job proofs' refusals: a killed run that diverged from a clean one, a seed that broke the
// app's invariant, a seed that would not replay. Apart from ./errors, which owns the codes and the
// one registration, because that catalogue is at its ceiling. Every fix replays the exact case.

import {
  renderCauseValue,
  renderFixLiteral,
  renderFixShellArg,
  UltimateError,
} from '@ultimat3/core';
import './errors';

export interface CrashDivergedInput {
  readonly job: string;
  /** The boundary the run was killed at: `charge`, `send (started)`, `ack`. */
  readonly boundary: string;
  readonly effect: string;
  readonly clean: number;
  readonly killed: number;
  /** The last step written before the effect, in the clean run. */
  readonly after?: string;
}

export class JobCrashDivergedError extends UltimateError {
  constructor(input: CrashDivergedInput) {
    const where =
      input.after === undefined ? 'before the first step' : `after step "${input.after}"`;
    super({
      code: 'X_JOB_CRASH_DIVERGED',
      cause: `job ${renderCauseValue(input.job)} killed at ${renderCauseValue(input.boundary)} made ${renderCauseValue(input.effect)} ${input.killed}× against ${input.clean}× in a clean run: it runs outside every step, ${where}, so the retry makes it again`,
      fix: `step.run(${renderFixLiteral(`${input.boundary}-effect`, '<name>')}, async () => …)   # in job(${renderFixLiteral(input.job, '<job>')}): wrap the ${renderFixLiteral(input.effect, '<effect>')} made ${where}; key an external call on \`\${jobId}:<step>\`; then: x test job --filter <the test file>`,
      meta: { ...input },
    });
  }
}

export interface SimInvariantInput {
  readonly seed: number;
  readonly faults: readonly string[];
  readonly reason: string;
}

export class JobSimInvariantError extends UltimateError {
  constructor(input: SimInvariantInput) {
    const faults = input.faults.length === 0 ? 'no fault' : input.faults.join(', ');
    super({
      code: 'X_JOB_SIM_INVARIANT',
      cause: `seed ${input.seed} broke the invariant (${renderCauseValue(input.reason)}) under ${renderCauseValue(faults)}`,
      fix: `x test job --seed ${renderFixShellArg(String(input.seed), '<n>')} --filter <the test file>   # replays that one seed and its faults`,
      meta: { seed: input.seed, faults: [...input.faults] },
    });
  }
}

export interface SimNondeterministicInput {
  readonly seed: number;
  /** The index of the first event the two traces disagree on. */
  readonly at: number;
  readonly first: string;
  readonly second: string;
}

export class JobSimNondeterministicError extends UltimateError {
  constructor(input: SimNondeterministicInput) {
    super({
      code: 'X_JOB_SIM_NONDETERMINISTIC',
      cause: `seed ${input.seed} ran twice and the traces differ at event ${input.at}: ${renderCauseValue(input.first)} then ${renderCauseValue(input.second)} — a body reads the wall clock, real I/O or state an earlier run left`,
      fix: `x test job --seed ${renderFixShellArg(String(input.seed), '<n>')} --filter <the test file>   # read time through Date (frozen) and ids through the job's input`,
      meta: { ...input },
    });
  }
}
