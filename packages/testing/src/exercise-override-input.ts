// An override's `input`, as the exercise pass applies it: AWAITED, and run inside the request the
// call itself runs in — so `useContext().actor` is the seated actor that call acts as. That is how
// an input the draw cannot forge (a signed passkey answer, a challenge issued to THIS actor) is
// computed from the pass's own state, by one mechanism and no per-primitive case.

import type { Actor } from '@ultimat3/core';
import { bindDrawn } from '@ultimat3/core';
import type { ExerciseOverride } from './define-exercise';
import { withExerciseRequest } from './exercise-request';

/** `(drawn, actor) => input`, or `undefined` when the override binds nothing. */
export type OverrideInput = (drawn: unknown, actor: Actor | null) => Promise<unknown>;

export function overrideInput(
  name: string,
  override: ExerciseOverride | undefined,
): OverrideInput | undefined {
  const bind = bindDrawn(
    override !== undefined && 'actor' in override ? override.input : undefined,
  );
  if (bind === undefined) return undefined;
  return (drawn, actor) => withExerciseRequest(name, actor, async () => bind(drawn));
}

/**
 * Whether an override's input is declared `async` — state the pass computes, which a load that
 * draws with no pass behind it (`x drill`) cannot reproduce. The function's own tag, never a call:
 * a plain function RETURNING a promise passes it, and `drill-writes.ts` catches that one at its draw.
 */
export const isAsyncInput = (override: ExerciseOverride | undefined): boolean =>
  override !== undefined &&
  'actor' in override &&
  override.input !== undefined &&
  Object.prototype.toString.call(override.input) === '[object AsyncFunction]';
