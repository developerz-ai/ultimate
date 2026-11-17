// The entry an unreached primitive's record says to paste into `exercise.ts`: valid TS, naming
// exactly what the pass ran with — the actor (its grants, or the one the entry declared) and each
// id field's seeded row — so pasting it compiles and holds no value that changes from run to run.

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
   * `null`: the pass ran signed out (or as a job's worker) — `actor: null`. Absent (and no
   * `declared`): the entry declares an actor no builder call spells (`onBehalfOf`, facts JSON
   * cannot carry); the line leaves `actor` out, so the author keeps theirs.
   */
  readonly actor?: OverrideActor | null | undefined;
  /**
   * The actor the entry DECLARED, spelled back as the builder that minted it (`userActor({ … })`):
   * pasting the line over the entry keeps it. Wins over `actor`.
   */
  readonly declared?: Actor | undefined;
  /** Each id field's value where the pass bound it to a seeded row: the line binds that row. */
  readonly ids?: Readonly<Record<string, string>> | undefined;
  /**
   * Fields the pass binds itself on every run (a tenant column, to the run's fresh tenant): the
   * line leaves them to `...drawn`, since any literal it printed is the wrong tenant next run.
   */
  readonly perRun?: readonly string[] | undefined;
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

/** `userActor({ id: "member", orgId: "…", permissions: ["invoice:write"] })`: the declared one. */
function declaredSource(actor: Actor): string {
  if (actor.kind === 'anonymous') return 'anonymousActor()';
  const init = [
    `id: ${quoted(actor.id)}`,
    ...(actor.orgId === undefined ? [] : [`orgId: ${quoted(actor.orgId)}`]),
    ...(actor.roles.length === 0 ? [] : [`roles: ${list(actor.roles)}`]),
    ...(actor.scopes.length === 0 ? [] : [`scopes: ${list(actor.scopes)}`]),
    ...(actor.permissions.length === 0 ? [] : [`permissions: ${list(actor.permissions)}`]),
    ...(isEmpty(actor.facts) ? [] : [`facts: ${JSON.stringify(actor.facts)}`]),
    ...(actor.locale === undefined ? [] : [`locale: ${quoted(actor.locale)}`]),
    ...(actor.tz === undefined ? [] : [`tz: ${quoted(actor.tz)}`]),
  ];
  return `${actor.kind}Actor({ ${init.join(', ')} })`;
}

const isEmpty = (facts: object | undefined): boolean =>
  facts === undefined || Object.keys(facts).length === 0;

/** What the line's actor slot reads, and the one import that needs (`undefined`: none). */
function actorSlot(hint: OverrideHint): { source: string; from?: string } | undefined {
  const { actor, declared } = hint;
  if (declared !== undefined) {
    const builder = declared.kind === 'anonymous' ? 'anonymousActor' : `${declared.kind}Actor`;
    return { source: declaredSource(declared), from: `${builder}: @ultimat3/core` };
  }
  if (actor === undefined) return undefined;
  if (actor === null) return { source: 'null' };
  return { source: actorSource(actor), from: 'testActor: @ultimat3/policy' };
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
    .filter((field) => hint.perRun?.includes(field) !== true)
    .map((field) => `, ${renderExerciseKey(field)}: ${quoted(hint.ids?.[field] ?? UNBOUND_ID)}`)
    .join('');
  const slot = actorSlot(hint);
  const actor = slot === undefined ? '' : `actor: ${slot.source}, `;
  const line = `${renderExerciseKey(name)}: { ${actor}input: (drawn) => ({ ...drawn${bound} }) },`;
  return slot?.from === undefined ? line : `${line} // ${slot.from}`;
}

/** Who the pass ran as, for the line: the pick by its grants, or the entry's declared actor. */
export type HintActor = OverrideHint['actor'] | { readonly declared: Actor };

/**
 * The pick, spelled: the entry's own actor when it declares one (pasting the line over the entry
 * must not drop it — the pass's pick would be refused where the declared member is not), `null`
 * for a signed-out run or a job's worker, else the grants the picked actor was minted with.
 * `undefined` only for a declared actor no builder call reproduces.
 */
export function actorHintOf(
  chosen: { readonly actor: Actor | null; readonly name: string },
  override: ExerciseOverride | undefined,
): HintActor {
  const declared = override === undefined || 'off' in override ? undefined : override.actor;
  if (declared === null) return null;
  if (declared !== undefined) return spellable(declared) ? { declared } : undefined;
  if (chosen.actor === null) return null;
  return {
    name: chosen.name,
    roles: chosen.actor.roles ?? [],
    permissions: chosen.actor.permissions ?? [],
  };
}

/** A builder call mints the same actor: no impersonation, and facts JSON carries unchanged. */
function spellable(actor: Actor): boolean {
  if (actor.onBehalfOf !== undefined) return false;
  if (isEmpty(actor.facts)) return true;
  try {
    return Bun.deepEquals(JSON.parse(JSON.stringify(actor.facts)), actor.facts, true);
  } catch {
    // A cycle or a BigInt: JSON cannot carry it, so no line can.
    return false;
  }
}

/**
 * What the line binds, from the input the pass last sent: each id field holding a seeded row, and
 * each tenant field — that one as the declared actor's org (the pass re-homes it, as it does the
 * generated entry's literal), or left to the pass when the actor declares none.
 */
export function hintFor(
  actor: HintActor,
  input: unknown,
  lookups: readonly IdLookup[],
): OverrideHint {
  const who = actor !== undefined && actor !== null && 'declared' in actor ? actor : { actor };
  if (typeof input !== 'object' || input === null) return who;
  const org = 'declared' in who ? who.declared.orgId : undefined;
  const ids: Record<string, string> = {};
  const perRun: string[] = [];
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;
    const hits = lookups.map((lookup) => lookup(field)).filter((hit) => hit?.value === value);
    if (hits.length === 0) continue;
    if (hits.some((hit) => hit?.tenant === true)) {
      if (org === undefined) perRun.push(field);
      else ids[field] = org;
    } else ids[field] = value;
  }
  return { ...who, ids, perRun };
}
