/**
 * The contract step's fourth assertion, as an action needs it: `@ultimat3/core`'s exercise loop
 * (`runExercise`) over `invoke`, each run inside a rolled-back transaction, "reached" read off the
 * handler counter. The verdict, the seed and the replay are the loop's, shared with `query`.
 */

import type { Actor, Ctx, DrawnInput, ExerciseAttempt, ExerciseReport } from '@ultimat3/core';
import {
  bindDrawn,
  ctxOf,
  exerciseReplay,
  isUltimateError,
  runExercise,
  tryUseContext,
} from '@ultimat3/core';
import { statusFor } from '@ultimat3/http';
import { admitsAnonymous } from '@ultimat3/policy';
import { arbitrary } from '@ultimat3/schema/sample';
import type { AnyAction } from './action';
import type { ContractTest } from './contract-test';
import {
  ContractDefectError,
  ExerciseUndeclaredError,
  ExerciseUnreachedError,
  everyDrawRefused,
} from './exercise-errors';
import { actionName, handlerReached, invoke } from './invoke';
import { inRolledBackScope, rollbackAvailable } from './tx-scope';
import { parseActionInput } from './validate';

export type { ExerciseReport };

/** Who the handler runs as, and what binds the parts a generated value cannot (a real row's id). */
export interface ExerciseActorOptions {
  /** The caller each run is invoked as. `null` is the signed-out caller. */
  readonly actor: Actor | null;
  /**
   * `(drawn) => ({ ...drawn, postId })`: the generated value, with what must resolve bound in.
   * May be `async`: `x exercise` awaits it inside the call's own request, so `useContext().actor`
   * is the actor the call runs as (a token issued to that actor, a passkey it registered).
   */
  readonly input?: (drawn: DrawnInput) => unknown;
  /** 1 to `EXERCISE_RUNS_MAX`; `EXERCISE_RUNS` when omitted. */
  readonly runs?: number;
}

/** No exercise, said out loud: the reason is listed in the assertion's name. */
export interface ExerciseOffOptions {
  readonly off: string;
}

export type ExerciseOptions = ExerciseActorOptions | ExerciseOffOptions;

/** The name the assertion runs under — also the `-t` that replays it. */
export const exerciseTestName = (name: string): string =>
  `${name}: handler survives generated input`;

/**
 * Exercise `target`: call its handler with generated input its own schema accepts. Throws
 * `X_CONTRACT_DEFECT` on the first defect, `X_CONTRACT_EXERCISE_UNREACHED` when no run got to the
 * handler, `X_CONTRACT_DRIFT` when the schema refused every draw.
 *
 * A test-time call: refused in `staging`/`production` (`X_CONTRACT_EXERCISE_ENVIRONMENT`). Each
 * run's transaction rolls back the handler's SQL writes, its memory-store writes (`test` with no
 * client installed, `tx` passed or not), the post-commit cache bust (either store) and, when a SQL
 * transaction is open, the outbox stage. NOT rolled back: a write on a second client or
 * `outsideTransaction`, a job enqueued with `outbox: false`, every job enqueue when no SQL
 * transaction is open (the memory store: the jobs facade enqueues straight to the job driver),
 * storage puts, mail, outbound fetch (sealed under the test preload) and rate-limit counters.
 */
export async function exerciseAction(
  target: AnyAction,
  options: ExerciseActorOptions,
  ctx?: Ctx,
): Promise<ExerciseReport> {
  const name = actionName(target);
  const base = ctx ?? tryUseContext() ?? ctxOf({});
  const verdict = await runExercise({
    name,
    runs: options.runs,
    stoppedLabel: 'stopped before the handler',
    scoped: rollbackAvailable(),
    draw: (seed, run) => arbitrary(target.input, { seed, run }),
    bind: bindDrawn(options.input),
    accepts: (input) => acceptedBy(target, input, name),
    attempt: async (input): Promise<ExerciseAttempt> => {
      const before = handlerReached(target);
      const settled = await inRolledBackScope(() =>
        invoke(target, input, { ctx: base, actor: options.actor, surface: 'http' }),
      );
      const reached = handlerReached(target) > before;
      return settled.ok ? { ok: true, reached } : { ok: false, reached, error: settled.error };
    },
    statusOf: statusFor,
  });
  switch (verdict.kind) {
    case 'pass':
      return verdict.report;
    case 'drift':
      throw everyDrawRefused(name);
    case 'unreached':
      throw new ExerciseUnreachedError(name, verdict.outcomes);
    case 'defect':
      throw new ContractDefectError({
        name,
        run: verdict.run,
        input: verdict.input,
        defect: verdict.defect,
        replay: exerciseReplay(name, exerciseTestName(name)),
        error: verdict.error,
      });
  }
}

async function acceptedBy(target: AnyAction, input: unknown, name: string): Promise<boolean> {
  try {
    await parseActionInput(target.input, input, name);
    return true;
  } catch (error) {
    if (isUltimateError(error) && error.code === 'X_INPUT_INVALID') return false;
    throw error;
  }
}

/**
 * The assertion `.contract()` appends. A public action exercises as the signed-out caller unless
 * told otherwise; a guarded one must say who acts or why not — there is no bypass and none is
 * added, so a policy that denies the named actor is an unreached run, not a skipped one.
 */
export function exerciseContract(
  target: AnyAction,
  exercise: ExerciseOptions | undefined,
  ctx: Ctx | undefined,
): ContractTest {
  const name = actionName(target);
  if (exercise !== undefined && 'off' in exercise) {
    const reason = exercise.off.trim();
    return reason.length === 0
      ? {
          name: exerciseTestName(name),
          run: () => Promise.reject(new ExerciseUndeclaredError(name, true)),
        }
      : { name: `${name}: handler exercise off: ${reason}`, run: () => Promise.resolve() };
  }
  const options = exercise ?? (admitsAnonymous(target.policy) ? { actor: null } : undefined);
  return {
    name: exerciseTestName(name),
    run: async () => {
      if (options === undefined) throw new ExerciseUndeclaredError(name, false);
      await exerciseAction(target, options, ctx);
    },
  };
}
