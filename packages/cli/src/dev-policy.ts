// The `/_x` policy panel's source: the app's own policies, decided by `@ultimat3/policy`'s own
// `policyMatrix()` — the same function `x g policy` generates a test against. The CLI supplies
// only the two things no registry holds: which actors to ask about, and which capability each
// policy gates. Re-deriving a verdict here would be the second authz the framework bans.

import { listActions } from '@ultimat3/action';
import type { PolicyFact } from '@ultimat3/admin/dev';
import type { NamedActor, Policy } from '@ultimat3/policy';
import { policyMatrix, roleDefinitions, testActor } from '@ultimat3/policy';
import { listQueries } from '@ultimat3/query';

/**
 * One capability and the policy that decides it. A primitive's `capability` IS its policy's own
 * label (`policyCapability` returns exactly that), so the capability identifies the gate: two
 * primitives reporting the same one are two call sites of one rule, not two answers to one cell.
 */
interface PolicyGate {
  readonly permission: string;
  readonly policy: Policy;
  /** The primitives that gate on it — the panel's answer to "where is this enforced?". */
  readonly usedBy: readonly string[];
}

/**
 * Every actor the matrix is computed for: one per role the app declared with `defineRoles`, plus
 * the anonymous caller. Derived rather than flagged, because the roles ARE the app's declaration
 * of who exists — a `--actor` flag would be a second place to keep that list.
 */
export function devActors(): readonly NamedActor[] {
  const roles = Object.keys(roleDefinitions()).sort();
  return [
    { name: 'anonymous', actor: null },
    ...roles.map((role) => testActor(role, { roles: [role] })),
  ];
}

/** Every gated capability in the app, actions and queries alike, sorted for a stable panel. */
export function devPolicyGates(): readonly PolicyGate[] {
  const gates = new Map<string, { permission: string; policy: Policy; usedBy: string[] }>();
  const add = (permission: string, policy: Policy, primitive: string): void => {
    // A policy that gates on nothing reports an empty capability; there is no cell to draw for it.
    if (permission.length === 0) return;
    const existing = gates.get(permission);
    if (existing === undefined) gates.set(permission, { permission, policy, usedBy: [primitive] });
    else existing.usedBy.push(primitive);
  };

  for (const target of listActions())
    add(target.describe().capability, target.policy, `action:${target.name}`);
  for (const target of listQueries())
    add(target.describe().capability, target.policy, `query:${target.name}`);

  return [...gates.values()].sort((a, b) => a.permission.localeCompare(b.permission));
}

/**
 * The matrix, actor by actor and capability by capability.
 *
 * Evaluated with no row on purpose: `/_x` asks whether an actor may reach a capability at all, and
 * there is no row to hand a row-level rule outside a real request. A rule that needs one therefore
 * shows its no-row verdict, and the trace says so rather than letting the cell read as a flat deny.
 */
export function devPolicyMatrix(): readonly PolicyFact[] {
  const actors = devActors();
  return devPolicyGates().flatMap((gate) => {
    const matrix = policyMatrix(gate.policy, { actors, input: {} });
    return matrix.rows.map(
      (row): PolicyFact => ({
        permission: gate.permission,
        actorId: row.actor,
        allowed: row.allowed,
        trace: [
          `${gate.policy.label}: ${row.allowed ? 'allow' : 'deny'}`,
          ...(row.deciding === null ? [] : [`deciding rule: ${row.deciding}`]),
          ...(row.reason === null ? [] : [`reason: ${row.reason}`]),
          `enforced in: ${gate.usedBy.join(', ')}`,
          'evaluated with no row — a row-level rule decides again on the real request',
        ],
      }),
    );
  });
}
