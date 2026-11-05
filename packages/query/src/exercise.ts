/**
 * A read's twin of `@ultimat3/action`'s exercise (this tier cannot import it): run the read with
 * inputs its own schema accepts, seeded by its name, and see whether `sql()` and its execution
 * survive. A read writes nothing, so no transaction wraps it. The codes are action's, borrowed.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import {
  assert,
  ctxOf,
  fnv1a,
  isFixShellSafe,
  isUltimateError,
  renderFixShellArg,
  renderThrowable,
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

/** The same numbers `@ultimat3/action` runs: sixteen by default, sixty-four at most. */
export const QUERY_EXERCISE_RUNS = 16;
export const QUERY_EXERCISE_RUNS_MAX = 64;

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

export interface QueryExerciseReport {
  readonly runs: number;
  readonly reached: number;
  readonly refused: number;
  readonly outcomes: readonly string[];
}

export const queryExerciseTestName = (name: string): string =>
  `${name}: read survives generated input`;

/** `bun test <file> -t '<name>…'` from inside a test file, the step otherwise. */
function replayCommand(name: string): string {
  const main = Bun.main;
  const file = main.replace(`${process.cwd()}/`, '');
  if (!main.includes('.test.') || !isFixShellSafe(file) || !isFixShellSafe(name)) {
    return 'x verify --only contract';
  }
  return `bun test ${file} -t '${queryExerciseTestName(name)}'`;
}

/** `null` passes (a coded refusal under 500); otherwise what the read did wrong. */
function defectOf(error: unknown): string | null {
  if (!isUltimateError(error)) return `threw an uncoded ${renderThrowable(error)}`;
  if (error.code === 'X_OUTPUT_INVALID') return 'answered rows its schema rejects';
  const status = statusFor(error.code);
  return status >= 500 ? `answered ${error.code}, a ${status}` : null;
}

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
 */
export async function exerciseQuery(
  target: AnyQuery,
  options: QueryExerciseActorOptions,
  ctx?: Ctx,
): Promise<QueryExerciseReport> {
  const name = queryName(target);
  const runs = options.runs ?? QUERY_EXERCISE_RUNS;
  assert(
    Number.isInteger(runs) && runs >= 1 && runs <= QUERY_EXERCISE_RUNS_MAX,
    `${name}: exercise runs must be a whole number from 1 to ${QUERY_EXERCISE_RUNS_MAX}`,
    `${name}.contract({ exercise: { actor, runs: ${QUERY_EXERCISE_RUNS} } })`,
  );
  const seed = fnv1a(name);
  const base = ctx ?? tryUseContext() ?? ctxOf({});
  const outcomes: string[] = [];
  let reached = 0;
  let refused = 0;
  for (let run = 0; run < runs; run += 1) {
    const drawn = arbitrary(target.input, { seed, run });
    const input = options.input === undefined ? drawn : await options.input(drawn);
    if (!(await accepts(target.input, input))) {
      refused += 1;
      outcomes.push(`run ${run}: input refused by its own schema`);
      continue;
    }
    try {
      const source = await sourceFor(target, input, {
        ctx: base,
        actor: options.actor,
        surface: 'http',
      });
      await source.execute();
      reached += 1;
      outcomes.push(`run ${run}: answered`);
    } catch (error) {
      if (isUltimateError(error) && error.code === 'X_TEST_NETWORK_SEALED') {
        outcomes.push(`run ${run}: network sealed`);
        continue;
      }
      const defect = defectOf(error);
      if (defect !== null) throw queryDefect(name, run, input, defect);
      const built = !beforeSql(error);
      reached += built ? 1 : 0;
      const code = isUltimateError(error) ? error.code : 'uncoded';
      outcomes.push(`run ${run}: ${built ? 'refused' : 'stopped before sql()'} with ${code}`);
    }
  }
  if (refused === runs) throw queryDrawsRefused(name);
  if (reached === 0) throw queryUnreached(name, outcomes);
  return { runs, reached, refused, outcomes };
}

function queryDefect(name: string, run: number, input: unknown, defect: string): UltimateError {
  return new UltimateError({
    code: 'X_CONTRACT_DEFECT',
    cause: `query ${name} ${defect} on generated run ${run}, for input its own schema accepts (meta.input)`,
    fix: `${replayCommand(name)}   # replays the run; fix the ${name} read or tighten its input: first`,
    meta: { run, input },
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
