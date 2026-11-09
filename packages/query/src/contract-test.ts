/**
 * A read's generated contract suite, `orgFeed.contract()`: what the `contract` step runs for a
 * query. Today one assertion — the read survives generated legal input — beside which other
 * claims a read owes (its declared refusals) are appended here, never in a second suite.
 */

import type { Ctx } from '@ultimat3/core';
import { admitsAnonymous } from '@ultimat3/policy';
import { declaredErrorsContract } from './declared-errors-contract';
import { exerciseQuery, queryExerciseTestName, queryExerciseUndeclared } from './exercise';
import type { QueryContractExercise } from './exercise-declarations';
import { isQueryExerciseDeclarations, resolveQueryExercise } from './exercise-declarations';
import type { AnyQuery } from './query';
import { queryName } from './read';

/** One generated assertion: a name to register under `test()`, and its body. */
export interface QueryContractTest {
  readonly name: string;
  run(): Promise<void>;
}

export interface QueryContractTestOptions {
  /**
   * Who the generated runs read as. In an app, the `exercise` export of `apps/web/exercise.ts` —
   * the `defineExercise()` value `x exercise` reads — and this query's entry in it is the one
   * used: one declaration, both runners. One entry inline (`{ actor }`, `{ off: '<reason>' }`) is
   * for a test binding rows of its own world. Required unless the policy admits an anonymous reader.
   */
  readonly exercise?: QueryContractExercise;
  /** The context each run starts from; the actor is swapped in, the rest kept. */
  readonly ctx?: Ctx;
}

export function queryContractTestsFor(
  target: AnyQuery,
  options: QueryContractTestOptions = {},
): readonly QueryContractTest[] {
  return [exerciseContract(target, options), ...declaredErrorsContract(target)];
}

function exerciseContract(target: AnyQuery, options: QueryContractTestOptions): QueryContractTest {
  const name = queryName(target);
  const exercise = resolveQueryExercise(name, options.exercise);
  if (exercise !== undefined && 'off' in exercise) {
    const reason = exercise.off.trim();
    if (reason.length > 0) {
      return { name: `${name}: read exercise off: ${reason}`, run: () => Promise.resolve() };
    }
    return {
      name: queryExerciseTestName(name),
      run: () => Promise.reject(queryExerciseUndeclared(name, 'blank')),
    };
  }
  const chosen = exercise ?? (admitsAnonymous(target.policy) ? { actor: null } : undefined);
  return {
    name: queryExerciseTestName(name),
    run: async () => {
      if (chosen === undefined) {
        const declared = options.exercise;
        const why =
          declared !== undefined && isQueryExerciseDeclarations(declared)
            ? 'no-entry'
            : 'undeclared';
        throw queryExerciseUndeclared(name, why);
      }
      await exerciseQuery(target, chosen, options.ctx);
    },
  };
}
