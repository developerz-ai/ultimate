// Who a primitive runs as in the exercise pass: the first actor `x policy explain` evaluates that
// the policy allows, minted in the primitive's own tenant. The actors are INJECTED (`RoleGrants`)
// because the set — anonymous plus one per declared role — is `@ultimat3/cli`'s `devActors()`,
// and a second "every role" builder here would drift from the one the policy panel shows.

import type { Actor } from '@ultimat3/core';
import type { NamedActor, Policy } from '@ultimat3/policy';
import { policyMatrix, rolesGranting } from '@ultimat3/policy';
import type { ExerciseOverride } from './define-exercise';

/**
 * The actors `x policy explain` evaluates, each a member of `tenant`: what `devActors()` answers,
 * with the org set. Injected by the caller (`x exercise` passes cli's own set).
 */
export type RoleGrants = (tenant: string) => readonly NamedActor[];

export type ActorChoice =
  | { readonly kind: 'actor'; readonly actor: Actor | null; readonly name: string }
  /** No actor the policy is evaluated for is allowed — refused by design, not by a guess. */
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * An override's actor, moved into the primitive's tenant: every primitive gets a fresh pair of
 * tenants, so an actor declared once in `exercise.ts` cannot know the org it will act in.
 */
export const inTenant = (actor: Actor | null, tenant: string): Actor | null =>
  actor === null ? null : Object.freeze({ ...actor, orgId: tenant });

/**
 * A role's actor id in one tenant: a uuid, as `ctx.actor.id` always is in production (an
 * `x_users` key), and the same one every time for that role in that tenant — so a rerun on a seed
 * replays byte for byte, and A's actor is never B's. Name-based (SHA-1, version 5 bits), never
 * random: nothing about it may depend on the order the pass asks.
 */
export function exerciseActorId(role: string, tenant: string): string {
  const digest = new Bun.CryptoHasher('sha1').update(`x-exercise-actor\0${role}\0${tenant}`);
  const bytes = digest.digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toHex();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Verdict = 'allowed' | 'denied' | 'undecidable';

/**
 * `policyMatrix` with no row and an empty input — the evaluation `x policy explain` prints. A
 * predicate that reads the input throws there; that actor is undecidable, decided again at run.
 */
const verdictFor = (policy: Policy, candidate: NamedActor): Verdict => {
  try {
    const row = policyMatrix(policy, { actors: [candidate], input: {} }).rows[0];
    return row?.allowed === true ? 'allowed' : 'denied';
  } catch {
    return 'undecidable';
  }
};

/** Whether `actor` holds every permission, directly or through a role — the grant, not the rule. */
const holds = (actor: Actor | null, permissions: readonly string[]): boolean =>
  actor !== null &&
  permissions.every(
    (permission) =>
      (actor.permissions ?? []).includes(permission) ||
      rolesGranting(permission).some((role) => (actor.roles ?? []).includes(role)),
  );

/**
 * The actor for one primitive. An override's actor wins; otherwise a signed-in actor before the
 * anonymous one (a tenant's rows are only reachable signed in). Allowed outright first; then one
 * that HOLDS every permission the policy names, whose predicate an empty input could not satisfy
 * (`x policy explain` evaluates with no row, and a row rule decides again on the real call); then
 * one the empty input could not even evaluate. None of the three is refused by design.
 */
export function chooseActor(
  policy: Policy | undefined,
  permissions: readonly string[],
  grants: RoleGrants,
  tenant: string,
  override: ExerciseOverride | undefined,
): ActorChoice {
  // An input-only entry (`{ input }`, no `actor`) keeps the pick below: only a DECLARED actor wins.
  if (override !== undefined && !('off' in override) && override.actor !== undefined) {
    return { kind: 'actor', actor: inTenant(override.actor, tenant), name: 'override' };
  }
  const candidates = grants(tenant);
  const ordered = [
    ...candidates.filter((c) => c.actor !== null),
    ...candidates.filter((c) => c.actor === null),
  ];
  // A job has no policy, and a served worker acts as nobody: the job's declared tenant is the
  // only org its body runs under, so the pass drains exactly as production does.
  if (policy === undefined) return { kind: 'actor', actor: null, name: 'worker' };
  const verdicts = ordered.map((candidate) => [candidate, verdictFor(policy, candidate)] as const);
  const pick =
    verdicts.find(([, verdict]) => verdict === 'allowed') ??
    verdicts.find(
      ([candidate, verdict]) =>
        verdict === 'denied' && permissions.length > 0 && holds(candidate.actor, permissions),
    ) ??
    verdicts.find(([, verdict]) => verdict === 'undecidable');
  if (pick === undefined) {
    return {
      kind: 'refused',
      reason:
        ordered.length === 0
          ? `no actor to evaluate ${policy.label} for: the role grants answered none`
          : `none of ${ordered.map((c) => c.name).join(', ')} is allowed by ${policy.label} or holds ${permissions.join(', ') || 'its grant'}`,
    };
  }
  const [{ actor, name }] = pick;
  return { kind: 'actor', actor: asRoleUser(actor, name, tenant), name };
}

/** A role's actor with the id a production actor has: `exerciseActorId(role, tenant)`. */
const asRoleUser = (actor: Actor | null, name: string, tenant: string): Actor | null =>
  actor === null ? null : Object.freeze({ ...actor, id: exerciseActorId(name, tenant) });

/** The seeded rows an actor can be one of: the pass's graph, read for one entity. */
export interface ActorRows {
  readonly entity: { readonly $name: string; readonly $primaryKey: readonly string[] };
  readonly rows: readonly {
    readonly tenant: string | null;
    readonly row: Readonly<Record<string, unknown>>;
  }[];
}

/**
 * The actor as a ROW of the entity the app named (`defineExercise(…, { actor: members })`): its
 * id becomes the key of a seeded row in its tenant, the one carrying one of its roles when any
 * does. Without it an actor's id is a role name, and every handler that writes `ctx.actor.id`
 * into a foreign key — `authorId` — is refused by the database.
 */
export function asSeededRow(actor: Actor | null, tenant: string, rows: ActorRows): Actor | null {
  const key = rows.entity.$primaryKey[0];
  if (actor === null || key === undefined || rows.entity.$primaryKey.length !== 1) return actor;
  const own = rows.rows.filter((row) => row.tenant === tenant || row.tenant === null);
  const roles = actor.roles ?? [];
  const row =
    own.find((candidate) =>
      Object.values(candidate.row).some((v) => roles.includes(v as string)),
    ) ?? own[0];
  const id = row?.row[key];
  return typeof id === 'string' ? Object.freeze({ ...actor, id }) : actor;
}
