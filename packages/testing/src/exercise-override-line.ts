// The entry an unreached primitive's record says to paste into `exercise.ts`: valid TS, naming
// exactly what the pass ran with — the actor's grants and each id field's seeded row — so pasting
// it compiles, and the author edits a working line instead of filling `<…>` holes in a broken one.

import type { Actor } from '@ultimat3/core';
import { renderExerciseKey } from '@ultimat3/core';
import type { ExerciseOverride } from './define-exercise';
import type { IdLookup } from './exercise-input';

/** The actor the pass ran as, by its grants: `testActor(name, { roles, permissions }).actor`. */
export interface OverrideActor {
  readonly name: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface OverrideHint {
  /**
   * `null`: the pass ran signed out (or as a job's worker) — `actor: null`. Absent: the entry
   * already declares its actor, or the pass's pick cannot be spelled; the line leaves `actor` out
   * and the pass picks as it did.
   */
  readonly actor?: OverrideActor | null | undefined;
  /** Each id field's value where the pass bound it to a seeded row: the line binds that row. */
  readonly ids?: Readonly<Record<string, string>> | undefined;
}

/** What an id field the pass could not bind is left as: a string, so the line still compiles. */
export const UNBOUND_ID = '<a real id>';

/** A string literal by `JSON.stringify`: a newline, a quote, a backslash each escaped right. */
const quoted = (text: string): string => JSON.stringify(text);
const list = (items: readonly string[]): string => `[${items.map(quoted).join(', ')}]`;

function actorSource(actor: OverrideActor): string {
  const init = [
    ...(actor.roles.length === 0 ? [] : [`roles: ${list(actor.roles)}`]),
    ...(actor.permissions.length === 0 ? [] : [`permissions: ${list(actor.permissions)}`]),
  ];
  const second = init.length === 0 ? '' : `, { ${init.join(', ')} }`;
  return `testActor(${quoted(actor.name)}${second}).actor`;
}

/**
 * `publishPost: { actor: testActor("editor", { roles: ["editor"] }).actor, input: (drawn) => ({
 * ...drawn, postId: "<seeded id>" }) }, // testActor: @ultimat3/policy` — the trailing comment is
 * the one import the line needs, there only when the line uses it.
 */
export function overrideLine(
  name: string,
  idFields: readonly string[],
  hint: OverrideHint = {},
): string {
  const bound = idFields
    .map((field) => `, ${renderExerciseKey(field)}: ${quoted(hint.ids?.[field] ?? UNBOUND_ID)}`)
    .join('');
  const actor =
    hint.actor === undefined
      ? ''
      : `actor: ${hint.actor === null ? 'null' : actorSource(hint.actor)}, `;
  const line = `${renderExerciseKey(name)}: { ${actor}input: (drawn) => ({ ...drawn${bound} }) },`;
  return hint.actor === undefined || hint.actor === null
    ? line
    : `${line} // testActor: @ultimat3/policy`;
}

/**
 * The pick, spelled: absent when the entry declares its actor (the author's line already has it);
 * `null` for a signed-out run or a job's worker; else the grants the picked actor was minted with.
 */
export function actorHintOf(
  chosen: { readonly actor: Actor | null; readonly name: string },
  override: ExerciseOverride | undefined,
): OverrideHint['actor'] {
  if (override !== undefined && !('off' in override) && override.actor !== undefined) {
    return undefined;
  }
  if (chosen.actor === null) return null;
  return {
    name: chosen.name,
    roles: chosen.actor.roles ?? [],
    permissions: chosen.actor.permissions ?? [],
  };
}

/** Each top-level id field of `input` holding the seeded row either lookup bound it to. */
export function seededIn(
  input: unknown,
  lookups: readonly IdLookup[],
): Readonly<Record<string, string>> {
  if (typeof input !== 'object' || input === null) return {};
  const ids: Record<string, string> = {};
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;
    if (lookups.some((lookup) => lookup(field)?.value === value)) ids[field] = value;
  }
  return ids;
}
