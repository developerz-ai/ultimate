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
  /** The last step completed before the effect, in the clean run. */
  readonly after?: string;
  /** The step whose body made the effect, when it was made inside one. */
  readonly inside?: string;
}

/**
 * Where an effect was made, as the crash proof's two reporters phrase it — this error and the CLI's
 * finding (`@ultimat3/cli`'s `exercise-findings.ts`) — so the two cannot name different places.
 * `remedy` is prose for a `fix:`'s comment, after the call it pastes.
 */
export function crashEffectPlace(where: {
  readonly after?: string | undefined;
  readonly inside?: string | undefined;
}): { readonly place: string; readonly remedy: string } {
  if (where.inside !== undefined) {
    const step = renderCauseValue(where.inside);
    return {
      place: `it runs inside step ${step}, whose body runs again until the step completes`,
      remedy: `make the body of step ${step} idempotent: key its external call on \`\${jobId}:${where.inside}\`, or move the effect into a step of its own`,
    };
  }
  const at =
    where.after === undefined
      ? 'before the first step'
      : `after step ${renderCauseValue(where.after)}`;
  return {
    place: `it runs outside every step, ${at}`,
    remedy: `wrap the effect made ${at} in step.run('<name>', async () => …); key an external call on \`\${jobId}:<step>\``,
  };
}

const howOften = (killed: number, clean: number): string =>
  killed > clean ? 'so the retry makes it again' : 'so the crash skipped it';

export class JobCrashDivergedError extends UltimateError {
  constructor(input: CrashDivergedInput) {
    const { place, remedy } = crashEffectPlace(input);
    const name = input.inside ?? `${input.boundary}-effect`;
    super({
      code: 'X_JOB_CRASH_DIVERGED',
      cause: `job ${renderCauseValue(input.job)} killed at ${renderCauseValue(input.boundary)} made ${renderCauseValue(input.effect)} ${input.killed}× against ${input.clean}× in a clean run: ${place}, ${howOften(input.killed, input.clean)}`,
      fix: `step.run(${renderFixLiteral(name, '<name>')}, async () => …)   # in job(${renderFixLiteral(input.job, '<job>')}), for ${renderFixLiteral(input.effect, '<effect>')}: ${remedy}; then: x test job --filter <the test file>`,
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
