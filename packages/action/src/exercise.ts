/**
 * The contract step's fourth assertion: call the handler with inputs its own schema accepts and
 * see whether it survives. Seeded by the action's name, so a red run replays from the test name;
 * each run inside a rolled-back transaction, so nothing it writes outlives it.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import {
  assert,
  ctxOf,
  fnv1a,
  isFixShellSafe,
  isUltimateError,
  renderThrowable,
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
import { inRolledBackScope } from './tx-scope';
import { parseActionInput } from './validate';

/** Runs per action by default: sixteen invocations, four of them on the IR's bounds. */
export const EXERCISE_RUNS = 16;
/** The most a caller may raise `runs` to: every run is a real invocation in a transaction. */
export const EXERCISE_RUNS_MAX = 64;

/** Who the handler runs as, and what binds the parts a generated value cannot (a real row's id). */
export interface ExerciseActorOptions {
  /** The caller each run is invoked as. `null` is the signed-out caller. */
  readonly actor: Actor | null;
  /** `(drawn) => ({ ...drawn, postId })`: the generated value, with what must resolve bound in. */
  readonly input?: (drawn: unknown) => unknown;
  /** 1 to `EXERCISE_RUNS_MAX`; `EXERCISE_RUNS` when omitted. */
  readonly runs?: number;
}

/** No exercise, said out loud: the reason is listed in the assertion's name. */
export interface ExerciseOffOptions {
  readonly off: string;
}

export type ExerciseOptions = ExerciseActorOptions | ExerciseOffOptions;

/** What a passing exercise saw: how many runs reached the handler, and what each one hit. */
export interface ExerciseReport {
  readonly runs: number;
  readonly reached: number;
  readonly refused: number;
  readonly outcomes: readonly string[];
}

/** The name the assertion runs under — also the `-t` that replays it. */
export const exerciseTestName = (name: string): string =>
  `${name}: handler survives generated input`;

/**
 * `bun test <this file> -t '<name>: handler survives generated input'` when a test file is
 * running — the seed is the name, so that replays the exact run — and the step otherwise. Single
 * quotes are safe only around a name `isFixShellSafe` already carries verbatim.
 */
export function replayCommand(name: string): string {
  const main = Bun.main;
  const file = main.replace(`${process.cwd()}/`, '');
  if (!main.includes('.test.') || !isFixShellSafe(file) || !isFixShellSafe(name)) {
    return 'x verify --only contract';
  }
  return `bun test ${file} -t '${exerciseTestName(name)}'`;
}

/** The host a sealed-network refusal names, read off its cause (`GET https://host/... was ...`). */
export function sealedHost(cause: string): string {
  const url = /^\S+ (\S+) was not mocked/.exec(cause)?.[1];
  if (url === undefined || !URL.canParse(url)) return 'an unnamed host';
  return new URL(url).host;
}

/** A thrown value's verdict: `null` is a pass (a coded refusal under 500), else what was wrong. */
export function defectOf(error: unknown): string | null {
  if (!isUltimateError(error)) return `threw an uncoded ${renderThrowable(error)}`;
  if (error.code === 'X_OUTPUT_INVALID') return 'returned a value its output schema rejects';
  const status = statusFor(error.code);
  return status >= 500 ? `answered ${error.code}, a ${status}` : null;
}

/**
 * Exercise `target`. Throws `X_CONTRACT_DEFECT` on the first defect, `X_CONTRACT_EXERCISE_UNREACHED`
 * when no run got to the handler, and `X_CONTRACT_DRIFT` when the schema refused every draw.
 */
export async function exerciseAction(
  target: AnyAction,
  options: ExerciseActorOptions,
  ctx?: Ctx,
): Promise<ExerciseReport> {
  const name = actionName(target);
  const runs = options.runs ?? EXERCISE_RUNS;
  assert(
    Number.isInteger(runs) && runs >= 1 && runs <= EXERCISE_RUNS_MAX,
    `${name}: exercise runs must be a whole number from 1 to ${EXERCISE_RUNS_MAX}`,
    `${name}.contract({ exercise: { actor, runs: ${EXERCISE_RUNS} } })`,
  );
  const seed = fnv1a(name);
  const base = ctx ?? tryUseContext() ?? ctxOf({});
  const outcomes: string[] = [];
  let reached = 0;
  let refused = 0;
  for (let run = 0; run < runs; run += 1) {
    const drawn = arbitrary(target.input, { seed, run });
    const input = options.input === undefined ? drawn : await options.input(drawn);
    if (!(await acceptedBy(target, input, name))) {
      refused += 1;
      outcomes.push(`run ${run}: input refused by its own schema`);
      continue;
    }
    const before = handlerReached(target);
    const settled = await inRolledBackScope(() =>
      invoke(target, input, { ctx: base, actor: options.actor, surface: 'http' }),
    );
    const got = handlerReached(target) > before;
    if (settled.ok) {
      reached += got ? 1 : 0;
      outcomes.push(`run ${run}: answered`);
      continue;
    }
    // Before the verdict: the sealed network is the test's wall, not the handler's failure, and
    // its code maps to no status, so `defectOf` would read it as a 500.
    if (isUltimateError(settled.error) && settled.error.code === 'X_TEST_NETWORK_SEALED') {
      outcomes.push(`run ${run}: network sealed (${sealedHost(settled.error.cause)})`);
      continue;
    }
    const defect = defectOf(settled.error);
    if (defect !== null) throw defectError(name, run, input, defect, settled.error);
    const code = isUltimateError(settled.error) ? settled.error.code : 'uncoded';
    reached += got ? 1 : 0;
    outcomes.push(`run ${run}: ${got ? 'refused' : 'stopped before the handler'} with ${code}`);
  }
  if (refused === runs) throw everyDrawRefused(name);
  if (reached === 0) throw new ExerciseUnreachedError(name, outcomes);
  return { runs, reached, refused, outcomes };
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

function defectError(
  name: string,
  run: number,
  input: unknown,
  defect: string,
  error: unknown,
): ContractDefectError {
  return new ContractDefectError({ name, run, input, defect, replay: replayCommand(name), error });
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
