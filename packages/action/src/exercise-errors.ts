/**
 * The exercise assertion's refusals. Off the socket: each is raised inside `bun test` by the
 * contract step and never served, so none has an HTTP status. `@ultimat3/query` raises the same
 * three codes from its own twin (it cannot import this tier), borrowing the titles registered here.
 */

import { isUltimateError, renderFixShellArg, UltimateError } from '@ultimat3/core';
import './error-titles';
import { ContractDriftError } from './errors';

/** A generated legal input made the handler fail: an uncoded throw, a bad output, a coded 5xx. */
export class ContractDefectError extends UltimateError {
  constructor(input: {
    name: string;
    run: number;
    input: unknown;
    defect: string;
    replay: string;
    /** What the handler threw: kept whole as `sourceError`, its code and cause in `meta.failure`. */
    error: unknown;
  }) {
    super({
      code: 'X_CONTRACT_DEFECT',
      cause: `${input.name} ${input.defect} on generated run ${input.run}, for input its own schema accepts (meta.input, meta.failure)`,
      fix: `${input.replay}   # replays the run; fix the ${input.name} handler or tighten its input: first`,
      meta: {
        run: input.run,
        input: input.input,
        ...(isUltimateError(input.error)
          ? { failure: { code: input.error.code, cause: input.error.cause } }
          : {}),
      },
      sourceError: input.error,
    });
  }
}

/** Not one run got as far as the handler: the assertion would have proven nothing. */
export class ExerciseUnreachedError extends UltimateError {
  constructor(name: string, outcomes: readonly string[]) {
    const call = renderFixShellArg(name, '<name>');
    super({
      code: 'X_CONTRACT_EXERCISE_UNREACHED',
      cause: `none of ${outcomes.length} generated runs of ${name} reached its handler (meta.outcomes lists what each one hit)`,
      fix: `${call}.contract({ exercise: { actor } }) with an actor the policy permits — or bind a real row: { exercise: { actor, input: (drawn) => ({ ...drawn, id }) } }`,
      meta: { outcomes },
    });
  }
}

/** A guarded handler with no `exercise` said, or an opt-out with no reason. */
export class ExerciseUndeclaredError extends UltimateError {
  constructor(name: string, blankReason: boolean) {
    const call = renderFixShellArg(name, '<name>');
    super({
      code: 'X_CONTRACT_EXERCISE_UNDECLARED',
      cause: blankReason
        ? `${name}.contract({ exercise: { off } }) gives a blank reason, so the skip is silent`
        : `${name} refuses an anonymous caller and its .contract() names no actor to exercise its handler as`,
      fix: `${call}.contract({ exercise: { actor } }) — or ${call}.contract({ exercise: { off: '<why this handler cannot run in a test>' } })`,
    });
  }
}

/**
 * Every draw failed the schema it was drawn from — a provider refinement the IR does not carry.
 * `X_CONTRACT_DRIFT`, the code the policy assertion already raises for the same gap.
 */
export function everyDrawRefused(name: string): ContractDriftError {
  return new ContractDriftError(
    `${name}: its input schema refused every generated value, so the handler was never exercised`,
    `${renderFixShellArg(name, '<name>')}.contract({ exercise: { actor, input: (drawn) => ({ ...drawn, field: '<a value the refinement accepts>' }) } })`,
  );
}
