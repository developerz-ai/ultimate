/**
 * A read's generated contract suite, `orgFeed.contract()`: what the `contract` step runs for a
 * query. Today one assertion — the read survives generated legal input — beside which other
 * claims a read owes (its declared refusals) are appended here, never in a second suite.
 */

import type { Ctx } from '@ultimat3/core';
import { admitsAnonymous } from '@ultimat3/policy';
import { declaredErrorsContract } from './declared-errors-contract';
import type { QueryExerciseOptions } from './exercise';
import { exerciseQuery, queryExerciseTestName, queryExerciseUndeclared } from './exercise';
import type { AnyQuery } from './query';
import { queryName } from './read';

/** One generated assertion: a name to register under `test()`, and its body. */
export interface QueryContractTest {
  readonly name: string;
  run(): Promise<void>;
}

export interface QueryContractTestOptions {
  /**
   * Who the generated runs read as — required unless the policy admits an anonymous reader — or
   * `{ off: '<reason>' }`, which skips the runs out loud: the reason is in the test's name.
   */
  readonly exercise?: QueryExerciseOptions;
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
  const exercise = options.exercise;
  if (exercise !== undefined && 'off' in exercise) {
    const reason = exercise.off.trim();
    if (reason.length > 0) {
      return { name: `${name}: read exercise off: ${reason}`, run: () => Promise.resolve() };
    }
    return {
      name: queryExerciseTestName(name),
      run: () => Promise.reject(queryExerciseUndeclared(name, true)),
    };
  }
  const chosen = exercise ?? (admitsAnonymous(target.policy) ? { actor: null } : undefined);
  return {
    name: queryExerciseTestName(name),
    run: async () => {
      if (chosen === undefined) throw queryExerciseUndeclared(name, false);
      await exerciseQuery(target, chosen, options.ctx);
    },
  };
}
