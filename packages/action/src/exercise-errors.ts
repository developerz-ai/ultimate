/**
 * The exercise assertion's refusals. Off the socket: each is raised inside `bun test` by the
 * contract step and never served, so none has an HTTP status. `@ultimat3/query` raises the same
 * three codes from its own twin (it cannot import this tier), borrowing the titles registered here.
 */

import {
  isUltimateError,
  renderDrawnInput,
  renderExerciseKey,
  renderFixShellArg,
  sampleGapBinding,
  UltimateError,
} from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { describeSampleGap, sampleGaps } from '@ultimat3/schema/sample';
import './error-titles';
import { ContractDriftError } from './errors';
import { EXERCISE_DECLARATIONS_FILE } from './exercise-declarations';

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
      fix: `defineExercise({ ${call}: { actor } })   # in ${EXERCISE_DECLARATIONS_FILE}, an actor the policy permits — or bind a real row: { actor, input: (drawn) => ({ ...drawn, id }) }`,
      meta: { outcomes },
    });
  }
}

/**
 * Why no exercise could run: an `off` with no reason, nothing declared, no entry by this name, or
 * an entry with no `actor` on a guarded handler — `x exercise` picks one its policy allows, a
 * contract test has no role set to pick from.
 */
export type ExerciseUndeclaredWhy = 'blank' | 'undeclared' | 'no-entry' | 'no-actor';

/**
 * A guarded handler with no exercise. The fix is the paste in the ONE home, `apps/web/exercise.ts`
 * — the file `x exercise` reads and `.contract({ exercise })` is handed — never an inline option:
 * an entry declared only in a test is one `x exercise` cannot see. `@ultimat3/query` twins it.
 */
export class ExerciseUndeclaredError extends UltimateError {
  constructor(name: string, why: ExerciseUndeclaredWhy) {
    const call = renderFixShellArg(name, '<name>');
    const refuses = `${name} refuses an anonymous caller`;
    const causes: Record<ExerciseUndeclaredWhy, string> = {
      blank: `${name}.contract({ exercise: { off } }) gives a blank reason, so the skip is silent`,
      'no-entry': `${refuses} and ${EXERCISE_DECLARATIONS_FILE} declares no entry for it, so no actor to exercise its handler as is known`,
      undeclared: `${refuses} and its .contract() names no actor to exercise its handler as`,
      'no-actor': `${refuses} and its exercise entry names no actor: x exercise picks one its policy allows, a contract test has none to pick from`,
    };
    super({
      code: 'X_CONTRACT_EXERCISE_UNDECLARED',
      cause: causes[why],
      fix: `defineExercise({ ${call}: { actor } })   # in ${EXERCISE_DECLARATIONS_FILE}, then ${call}.contract({ exercise }) with that file's export — or { off: '<why this handler cannot run in a test>' } there`,
    });
  }
}

/**
 * Every draw failed the schema it was drawn from. `X_CONTRACT_DRIFT`, the code the policy
 * assertion already raises for the same gap. A field whose `pattern` (or item count) the sampler
 * cannot meet is named in the cause and bound in the fix's `input:`; a provider refinement the IR
 * does not carry leaves only the placeholder field, honestly.
 */
export function everyDrawRefused(name: string, schema: StandardSchemaV1): ContractDriftError {
  const gaps = sampleGaps(schema);
  const described = gaps.map((path) => describeSampleGap(schema, path));
  const input =
    gaps.length === 0
      ? "(drawn) => ({ ...drawn, field: '<a value the refinement accepts>' })"
      : renderDrawnInput(gaps.map((path, i) => sampleGapBinding(path, described[i] ?? path)));
  return new ContractDriftError(
    gaps.length === 0
      ? `${name}: its input schema refused every generated value, so the handler was never exercised`
      : `${name}: its input schema refused every generated value — no value can be generated for ${described.join(', ')} — so the handler was never exercised`,
    `defineExercise({ ${renderExerciseKey(name)}: { input: ${input} } })   # in ${EXERCISE_DECLARATIONS_FILE}`,
  );
}
