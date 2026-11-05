/**
 * A read's adapter over `@ultimat3/core`'s exercise loop (`runExercise`, shared with `action`):
 * run the read with inputs its own schema accepts, seeded by its name, and see whether `sql()` and
 * its execution survive. A read writes nothing, so no transaction wraps it. The codes are action's.
 */

import type { Actor, Ctx, ExerciseReport } from '@ultimat3/core';
import {
  ctxOf,
  exerciseReplay,
  isUltimateError,
  renderFixShellArg,
  runExercise,
  tryUseContext,
  UltimateError,
} from '@ultimat3/core';
import { statusFor } from '@ultimat3/http';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { validateAsync } from '@ultimat3/schema';
import { arbitrary } from '@ultimat3/schema/sample';
import { QueryAuditSinkMissingError } from './audit-errors';
import { QueryDeniedError } from './errors';
import type { AnyQuery } from './query';
import { queryName, sourceFor } from './read';

/** Who reads, and what binds the parts a generated value cannot. Same shape as an action's. */
export interface QueryExerciseActorOptions {
  readonly actor: Actor | null;
  readonly input?: (drawn: unknown) => unknown;
  readonly runs?: number;
}

export interface QueryExerciseOffOptions {
  readonly off: string;
}

export type QueryExerciseOptions = QueryExerciseActorOptions | QueryExerciseOffOptions;

export type QueryExerciseReport = ExerciseReport;

export const queryExerciseTestName = (name: string): string =>
  `${name}: read survives generated input`;

/**
 * Whether a refusal came from the front half every surface shares — the policy, the parse, the
 * declared limit, a missing audit sink — rather than from `sql()` or its execution. Read off the
 * refusal itself because `read.ts` keeps no counter: anything else was thrown past the front half.
 */
function beforeSql(error: unknown): boolean {
  if (error instanceof QueryDeniedError || error instanceof QueryAuditSinkMissingError) return true;
  return isUltimateError(error) && FRONT_HALF_CODES.has(error.code);
}

const FRONT_HALF_CODES: ReadonlySet<string> = new Set(['X_INPUT_INVALID', 'X_RATE_LIMITED']);

const accepts = async (schema: StandardSchemaV1, input: unknown): Promise<boolean> =>
  (await validateAsync(schema, input)).issues === undefined;

/**
 * Exercise `target`. "Reached" is `sql()` having built a source: everything before it — the
 * policy, the declared limit, the parse — is the front half every surface shares.
 *
 * A test-time call: refused in `staging`/`production` (`X_CONTRACT_EXERCISE_ENVIRONMENT`). Nothing
 * is rolled back, because a read writes nothing; what it touches anyway (a rate-limit counter, an
 * audit record, an outbound fetch — sealed under the test preload) is kept.
 */
export async function exerciseQuery(
  target: AnyQuery,
  options: QueryExerciseActorOptions,
  ctx?: Ctx,
): Promise<QueryExerciseReport> {
  const name = queryName(target);
  const base = ctx ?? tryUseContext() ?? ctxOf({});
  const verdict = await runExercise({
    name,
    runs: options.runs,
    stoppedLabel: 'stopped before sql()',
    draw: (seed, run) => arbitrary(target.input, { seed, run }),
    bind: options.input,
    accepts: (input) => accepts(target.input, input),
    attempt: async (input) => {
      try {
        const source = await sourceFor(target, input, {
          ctx: base,
          actor: options.actor,
          surface: 'http',
        });
        await source.execute();
        return { ok: true, reached: true };
      } catch (error) {
        return { ok: false, reached: !beforeSql(error), error };
      }
    },
    statusOf: statusFor,
  });
  switch (verdict.kind) {
    case 'pass':
      return verdict.report;
    case 'drift':
      throw queryDrawsRefused(name);
    case 'unreached':
      throw queryUnreached(name, verdict.outcomes);
    case 'defect':
      throw queryDefect(name, verdict.run, verdict.input, verdict.defect, verdict.error);
  }
}

function queryDefect(
  name: string,
  run: number,
  input: unknown,
  defect: string,
  error: unknown,
): UltimateError {
  return new UltimateError({
    code: 'X_CONTRACT_DEFECT',
    cause: `query ${name} ${defect} on generated run ${run}, for input its own schema accepts (meta.input, meta.failure)`,
    fix: `${exerciseReplay(name, queryExerciseTestName(name))}   # replays the run; fix the ${name} read or tighten its input: first`,
    meta: {
      run,
      input,
      ...(isUltimateError(error) ? { failure: { code: error.code, cause: error.cause } } : {}),
    },
    sourceError: error,
  });
}

function queryUnreached(name: string, outcomes: readonly string[]): UltimateError {
  return new UltimateError({
    code: 'X_CONTRACT_EXERCISE_UNREACHED',
    cause: `none of ${outcomes.length} generated runs of query ${name} reached its sql() (meta.outcomes lists what each one hit)`,
    fix: `${renderFixShellArg(name, '<name>')}.contract({ exercise: { actor } }) with an actor the policy permits`,
    meta: { outcomes },
  });
}

function queryDrawsRefused(name: string): UltimateError {
  return new UltimateError({
    code: 'X_CONTRACT_DRIFT',
    cause: `query ${name}: its input schema refused every generated value, so the read was never exercised`,
    fix: `${renderFixShellArg(name, '<name>')}.contract({ exercise: { actor, input: (drawn) => ({ ...drawn, field: '<a value the refinement accepts>' }) } })`,
  });
}

/** A guarded read with no exercise said, or an opt-out with a blank reason. */
export function queryExerciseUndeclared(name: string, blankReason: boolean): UltimateError {
  const call = renderFixShellArg(name, '<name>');
  return new UltimateError({
    code: 'X_CONTRACT_EXERCISE_UNDECLARED',
    cause: blankReason
      ? `${name}.contract({ exercise: { off } }) gives a blank reason, so the skip is silent`
      : `query ${name} refuses an anonymous reader and its .contract() names no actor to read as`,
    fix: `${call}.contract({ exercise: { actor } }) — or ${call}.contract({ exercise: { off: '<why this read cannot run in a test>' } })`,
  });
}
