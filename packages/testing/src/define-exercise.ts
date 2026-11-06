// `defineExercise({ publishPost: { input, actor }, sendInvoice: { off: 'why' } })`: an app's
// overrides for the exercise pass, one entry per primitive. Each value IS 39's `.contract({
// exercise })` option, re-exported rather than restated, so one shape answers both questions.
// A blank `off` is refused here, at declaration; an unknown name when the pass runs.

import type { ExerciseOptions } from '@ultimat3/action';
import { renderCauseValue, renderFixLiteral, UltimateError } from '@ultimat3/core';

/** 39's option type, exactly: `{ actor, input?, runs? }` or `{ off: '<reason>' }`. */
export type ExerciseOverride = ExerciseOptions;

/** What `defineExercise` returns: the overrides, by primitive name. Read by `runExercisePass`. */
export interface ExerciseOverrides {
  readonly kind: 'exercise-overrides';
  readonly entries: ReadonlyMap<string, ExerciseOverride>;
  /** The entity an actor is a row of, by name: its id is bound to a seeded row. */
  readonly actorEntity?: string;
}

/** What the whole pass needs to know of the app, beside the per-primitive entries. */
export interface ExerciseAppOptions {
  /**
   * The entity whose rows ARE the app's actors (`members`, `users`): each actor's id becomes a
   * seeded row's key in its own tenant, so a handler writing `ctx.actor.id` into a foreign key
   * writes a row that exists. Omitted, an actor's id is its role's name.
   */
  readonly actor?: { readonly $name: string };
}

/** `X_CONTRACT_EXERCISE_UNDECLARED`, 39's code for the same silence: an `off` with no reason. */
const blankReason = (name: string): UltimateError =>
  new UltimateError({
    code: 'X_CONTRACT_EXERCISE_UNDECLARED',
    cause: `defineExercise() turns ${renderCauseValue(name)} off with a blank reason, so the skip is silent`,
    fix: `defineExercise({ ${renderFixLiteral(name, '<name>')}: { off: '<why this primitive cannot run in the exercise pass>' } })   # in apps/web/exercise.ts`,
  });

export function defineExercise(
  overrides: Readonly<Record<string, ExerciseOverride>>,
  app: ExerciseAppOptions = {},
): ExerciseOverrides {
  const entries = new Map<string, ExerciseOverride>();
  // `Object.entries`, never `for in`: an inherited key is not a declaration.
  for (const [name, override] of Object.entries(overrides)) {
    if ('off' in override && override.off.trim().length === 0) throw blankReason(name);
    entries.set(name, override);
  }
  return Object.freeze({
    kind: 'exercise-overrides',
    entries,
    ...(app.actor === undefined ? {} : { actorEntity: app.actor.$name }),
  });
}

/**
 * Every override names a registered action, query or job — checked when the pass runs, because
 * that is when the registries are full. `X_DECLARATION_UNKNOWN`, the code an unknown name answers
 * everywhere else; the cause lists what IS registered so the typo is visible.
 */
export function assertOverridesKnown(
  overrides: ExerciseOverrides | undefined,
  known: ReadonlySet<string>,
): void {
  const unknown = [...(overrides?.entries.keys() ?? [])].filter((name) => !known.has(name)).sort();
  if (unknown.length === 0) return;
  throw unknownDeclaration(unknown, known, 'defineExercise() overrides');
}

/** One unknown-name refusal for an override and for `only`, so both read the same. */
export function unknownDeclaration(
  names: readonly string[],
  known: ReadonlySet<string>,
  where: string,
): UltimateError {
  const listed = [...known].sort();
  return new UltimateError({
    code: 'X_DECLARATION_UNKNOWN',
    cause: `${where} name ${names.map((name) => renderCauseValue(name)).join(', ')}, which no registered action, query or job is called (registered: ${listed.length === 0 ? 'none' : renderCauseValue(listed.join(', '))})`,
    fix: 'x actions list --json   # or x queries list --json / x jobs list --json; rename or remove the entry in apps/web/exercise.ts',
    meta: { unknown: names, registered: listed },
  });
}
