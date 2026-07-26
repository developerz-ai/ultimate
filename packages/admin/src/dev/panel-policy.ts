// Panel: Policy.
// Kills: "can this actor do that, and why?" — the permission matrix per actor, every cell
// carrying the decision trace that produced it.

import type { PolicyFact } from './facts';
import type { DevPanel } from './panel';

export interface PolicyRow {
  readonly permission: string;
  /** actorId → allowed. The matrix as the panel draws it. */
  readonly byActor: Readonly<Record<string, boolean>>;
}

export interface PolicyPanelData {
  readonly actors: readonly string[];
  readonly permissions: readonly string[];
  readonly matrix: readonly PolicyRow[];
  readonly facts: readonly PolicyFact[];
  /** The selected cell's trace: `?permission=post:publish&actor=u_1`. */
  readonly trace: readonly string[];
  /** Permissions no actor holds — usually a policy nobody can satisfy. */
  readonly unreachable: readonly string[];
}

export const policyPanel: DevPanel<PolicyPanelData> = {
  key: 'policy',
  titleKey: 'dev.panel.policy',
  question: 'can this actor do that, and why?',
  async data(sources, params): Promise<PolicyPanelData> {
    const facts = await sources.policyMatrix();
    const actors = [...new Set(facts.map((fact) => fact.actorId))].sort();
    const permissions = [...new Set(facts.map((fact) => fact.permission))].sort();

    const matrix = permissions.map((permission) => {
      const byActor: Record<string, boolean> = {};
      for (const actor of actors) {
        byActor[actor] =
          facts.find((fact) => fact.permission === permission && fact.actorId === actor)?.allowed ??
          false;
      }
      return { permission, byActor };
    });

    const wantedPermission = params.get('permission');
    const wantedActor = params.get('actor');
    const selected = facts.find(
      (fact) => fact.permission === wantedPermission && fact.actorId === wantedActor,
    );

    return {
      actors,
      permissions,
      matrix,
      facts,
      trace: selected?.trace ?? [],
      unreachable: matrix
        .filter((row) => Object.values(row.byActor).every((allowed) => !allowed))
        .map((row) => row.permission),
    };
  },
};
