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
  // Any entry but `off` may bind: `{ input }` alone keeps the pass's own actor and still binds.
  const bind = bindDrawn(override === undefined || 'off' in override ? undefined : override.input);
  if (bind === undefined) return undefined;
  const declared = override === undefined || 'off' in override ? undefined : override.actor;
  return async (drawn, actor) =>
    rehomed(
      await withExerciseRequest(name, actor, async () => bind(drawn)),
      declared?.orgId,
      actor?.orgId,
    );
}

/**
 * The bound input, re-homed with its actor: the pass seats a declared actor in each tenant it
 * seeds, so a top-level value equal to the org the entry DECLARED (`orgId: '<org>'`, the same
 * literal the contract test runs with) is that tenant's. Without it A's own call names an org its
 * actor is not in, and a policy comparing the two denies every run.
 */
function rehomed(input: unknown, from: string | undefined, to: string | undefined): unknown {
  if (from === undefined || to === undefined || from === to || !isPlainObject(input)) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value === from ? to : value]),
  );
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether an override's input is declared `async` — state the pass computes, which a load that
 * draws with no pass behind it (`x drill`) cannot reproduce. The function's own tag, never a call:
 * a plain function RETURNING a promise passes it, and `drill-writes.ts` catches that one at its draw.
 */
export const isAsyncInput = (override: ExerciseOverride | undefined): boolean =>
  override !== undefined &&
  !('off' in override) &&
  override.input !== undefined &&
  Object.prototype.toString.call(override.input) === '[object AsyncFunction]';
