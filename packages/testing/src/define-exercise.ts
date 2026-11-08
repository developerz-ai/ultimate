// `defineExercise({ publishPost: { input, actor }, sendInvoice: { off: 'why' } })`: an app's ONE
// declaration of each primitive's exercise. `x exercise` reads it, and so does every contract
// test — the whole value handed to `.contract({ exercise })` (action's `ExerciseDeclarations`).
// A blank `off` is refused here, at declaration; an unknown name when the pass runs. A key is a
// bare name or a kind-qualified one (`'job:eraseAccount'`), which wins over the bare for its kind.

import type { ExerciseOptions } from '@ultimat3/action';
import { renderCauseValue, renderFixLiteral, UltimateError } from '@ultimat3/core';
import type { ExerciseSetup } from './exercise-setup';
import type { SeedFactory } from './seed-graph-plan';

/** 39's option type, exactly: `{ actor, input?, runs? }` or `{ off: '<reason>' }`. */
export type ExerciseOverride = ExerciseOptions;

/**
 * What `defineExercise` returns: the overrides, by primitive name. Read by `runExercisePass` and,
 * structurally, by `.contract({ exercise })` (`define-exercise.test.ts` pins the assignability).
 */
export interface ExerciseOverrides {
  readonly kind: 'exercise-overrides';
  readonly entries: ReadonlyMap<string, ExerciseOverride>;
  /** The entity an actor is a row of, by name: its id is bound to a seeded row. */
  readonly actorEntity?: string;
  /** The column of that entity whose value IS the actor's id (`memberships.userId`); else its key. */
  readonly actorColumn?: string;
  /** By entity name: the pass's graph builds those rows with them (`seedGraph`'s `factories`). */
  readonly factories?: Readonly<Record<string, SeedFactory>>;
  /** The app's hooks, run once each, in order, inside the pass's sealed room (`exercise-setup.ts`). */
  readonly setup?: ExerciseSetup | readonly ExerciseSetup[];
}

/** The three kinds an entry may be qualified by. */
export type ExerciseKind = 'action' | 'query' | 'job';

/** `'job:eraseAccount'`: the key that names one kind's primitive when another shares its name. */
export const exerciseEntryKey = (kind: ExerciseKind, name: string): string => `${kind}:${name}`;

/**
 * The entry `kind` `name` runs with: its qualified key's, else its bare name's. An action and a job
 * sharing a name each read their own — the bare key alone fed one's input to the other.
 */
export function overrideFor(
  overrides: ExerciseOverrides | undefined,
  kind: ExerciseKind,
  name: string,
): ExerciseOverride | undefined {
  return overrides?.entries.get(exerciseEntryKey(kind, name)) ?? overrides?.entries.get(name);
}

/** What the whole pass needs to know of the app, beside the per-primitive entries. */
export interface ExerciseAppOptions {
  /**
   * The entity whose rows ARE the app's actors (`members`, `users`): each actor's id becomes a
   * seeded row's key in its own tenant, so a handler writing `ctx.actor.id` into a foreign key
   * writes a row that exists. `{ entity, column }` names the column that holds the user instead
   * (`{ entity: membership, column: 'userId' }`). Omitted, a deterministic uuid per role and tenant.
   */
  readonly actor?:
    | { readonly $name: string }
    | { readonly entity: { readonly $name: string }; readonly column: string };
  /**
   * By entity name, `seedGraph`'s own option: a table whose rows a generated value cannot satisfy
   * (an `invariant` across columns) is built by the app's `defineFactory`. An unknown name is
   * refused when the pass runs.
   */
  readonly factories?: Readonly<Record<string, SeedFactory>>;
  /**
   * Run in the exercise process once the network is sealed, before the first row: install the
   * `mockFetch` routes or `cassette()` your vendor-calling handlers need, so they run for real.
   * What it returns (a cassette, any `Disposable`) is disposed after the pass. `allowHost` here is
   * `X_EXERCISE_SETUP_UNSEALED` — the pass never sends a call out. An array runs in order and is
   * disposed in reverse; one that throws disposes those that already ran.
   */
  readonly setup?: ExerciseSetup | readonly ExerciseSetup[];
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
    ...(app.actor === undefined
      ? {}
      : 'entity' in app.actor
        ? { actorEntity: app.actor.entity.$name, actorColumn: app.actor.column }
        : { actorEntity: app.actor.$name }),
    ...(app.factories === undefined ? {} : { factories: app.factories }),
    ...(app.setup === undefined ? {} : { setup: app.setup }),
  });
}

/**
 * Every override names a registered action, query or job — bare, or qualified by the kind it is
 * registered as — checked when the pass runs, because that is when the registries are full.
 * `X_DECLARATION_UNKNOWN`, the code an unknown name answers everywhere else; the cause lists what
 * IS registered so the typo is visible.
 */
export function assertOverridesKnown(
  overrides: ExerciseOverrides | undefined,
  registered: readonly { readonly kind: ExerciseKind; readonly name: string }[],
): void {
  const keys = new Set(
    registered.flatMap(({ kind, name }) => [name, exerciseEntryKey(kind, name)]),
  );
  const unknown = [...(overrides?.entries.keys() ?? [])].filter((key) => !keys.has(key)).sort();
  if (unknown.length === 0) return;
  const known = new Set(registered.map(({ name }) => name));
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
