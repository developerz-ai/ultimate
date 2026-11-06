// The tenant proof, one primitive at a time: tenant B calls with A's ids before A's own call and
// again after it, and the call is crossed if anything of A's — a canary, an id B was not handed —
// came back in the output or an effect, or if one of A's rows changed. Order B, A, B: a deleting
// action would leave B nothing to reach, and the second B catches a cache entry A filled.

import type { Actor } from '@ultimat3/core';
import type { Policy } from '@ultimat3/policy';
import { policyMatrix } from '@ultimat3/policy';
import type {
  EffectPayload,
  ExerciseRecord,
  TenantFinding,
  TenantLeg,
  TenantProof,
} from './exercise-report';
import type { SeedRow } from './seed-graph-plan';
import type { TenantTaint } from './tenant-canary';
import { findTaint, huntedMarks } from './tenant-canary';

export type { TenantFinding, TenantLeg, TenantProof } from './exercise-report';

/**
 * `@ultimat3/entity`'s `CROSS_TENANT_SCOPE`, restated: this module stays off entity at run time.
 * `tenant-proof-legs.test.ts` holds the two equal, so a rename there fails here.
 */
export const CROSS_TENANT_SCOPE = 'tenancy:cross';

/**
 * B's actor: the role that grants the policy's permission, never the capability that lifts the
 * tenant guard. An A actor holding `tenancy:cross` legitimately reads across; B attacking with it
 * would prove only that the escape works.
 */
export const withoutCrossTenant = (actor: Actor | null): Actor | null =>
  actor === null || !actor.scopes.includes(CROSS_TENANT_SCOPE)
    ? actor
    : Object.freeze({ ...actor, scopes: actor.scopes.filter((s) => s !== CROSS_TENANT_SCOPE) });

/**
 * Why the read half is skipped, or `undefined`: a policy that admits an anonymous caller with an
 * empty input is public by its own declaration — what it returns, anyone may read. A job has no
 * policy and a predicate the empty input cannot answer is not an admission: both are proven.
 */
export function publicReason(policy: Policy | undefined): string | undefined {
  if (policy === undefined) return undefined;
  try {
    const row = policyMatrix(policy, { actors: [{ name: 'anonymous', actor: null }], input: {} })
      .rows[0];
    return row?.allowed === true
      ? `${policy.label} admits an anonymous caller, so what it returns is public: read half skipped, write half kept`
      : undefined;
  } catch {
    // A predicate that reads the input throws on the empty one: undecided, so not public.
    return undefined;
  }
}

/** What one B call answered and what the room saw it do. */
export interface LegAnswer {
  readonly output: unknown;
  readonly payloads: readonly EffectPayload[];
}

export interface TenantAttack {
  readonly taint: TenantTaint;
  /** B's input: A's own first input, A's ids bound — both legs send exactly this. */
  readonly input: unknown;
  /** From `publicReason`: set, the read half is skipped and the verdict at best `public`. */
  readonly public: string | undefined;
  /**
   * A read (a query): A's own answer must hold one of A's rows, or B's empty answer proves
   * nothing — a cache shared across tenants that B filled first hands A the same nothing.
   */
  readonly read: boolean;
  attack(leg: TenantLeg): Promise<LegAnswer>;
  /** A's positive control: today's exercise of the primitive, and what A's last answer was. */
  control(): Promise<{ readonly record: ExerciseRecord; readonly output: unknown }>;
  snapshot(rows: readonly SeedRow[]): Promise<readonly (string | null)[]>;
}

/** A's rows whose digest moved across one B leg — changed, or gone. */
export function crossedWrites(
  leg: TenantLeg,
  taint: Pick<TenantTaint, 'rows' | 'ids'>,
  before: readonly (string | null)[],
  after: readonly (string | null)[],
): readonly TenantFinding[] {
  return taint.rows.flatMap((row, i): TenantFinding[] =>
    before[i] === after[i]
      ? []
      : [{ code: 'X_TENANT_WRITE_CROSSED', leg, table: row.table, id: taint.ids[i] ?? '' }],
  );
}

/** Every path in B's answer holding a mark of A's that B was not handed. */
export function leaksIn(
  leg: TenantLeg,
  answer: LegAnswer,
  marks: readonly string[],
): readonly TenantFinding[] {
  const paths = [
    ...findTaint(answer.output, 'output', marks),
    ...answer.payloads.flatMap((payload) => findTaint(payload.value, payload.path, marks)),
  ];
  return paths.map((path): TenantFinding => ({ code: 'X_TENANT_LEAK', leg, path }));
}

const verdictOf = (
  plan: TenantAttack,
  control: { readonly record: ExerciseRecord; readonly output: unknown },
  findings: readonly TenantFinding[],
): TenantProof => {
  const { record } = control;
  if (findings.length > 0) return { verdict: 'crossed', findings };
  if (record.outcome !== 'reached') {
    return {
      verdict: 'unproven',
      reason: `A's own call was not reached (${record.code ?? record.outcome}), so B's clean answers prove nothing`,
    };
  }
  if (plan.public !== undefined) return { verdict: 'public', reason: plan.public };
  // Every mark of A's, handed ones included: A was handed its own ids, and reading them is the point.
  if (plan.read && findTaint(control.output, 'output', plan.taint.marks).length === 0) {
    return {
      verdict: 'unproven',
      reason: "A's control returned none of A's rows, so B's answers had nothing to leak",
    };
  }
  return { verdict: 'proven' };
};

/** B, A, B — each B leg between two snapshots of A's rows — and A's record with the verdict on it. */
export async function proveTenant(plan: TenantAttack): Promise<ExerciseRecord> {
  const marks = huntedMarks(plan.taint, plan.input);
  const findings: TenantFinding[] = [];
  const leg = async (name: TenantLeg): Promise<void> => {
    const before = await plan.snapshot(plan.taint.rows);
    const answer = await plan.attack(name);
    const after = await plan.snapshot(plan.taint.rows);
    findings.push(...crossedWrites(name, plan.taint, before, after));
    if (plan.public === undefined) findings.push(...leaksIn(name, answer, marks));
  };
  await leg('before');
  const control = await plan.control();
  await leg('after');
  return { ...control.record, tenant: verdictOf(plan, control, findings) };
}
