// `actorRowsOf`: the rows the pass seats its actors in, and the column whose value is the user —
// carried from `defineExercise(…, { actor: { entity, column } })` to `asSeededRow`.

import { describe, expect, test } from 'bun:test';
import { defineExercise } from './define-exercise';
import { actorRowsOf } from './exercise-sweeps';
import type { SeedGraph } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';

const memberships = { $name: 'memberships', $primaryKey: ['id'] } as unknown as SeedEntity;
const graph = {
  inserts: [
    { entity: 'memberships', row: { id: 'm1', userId: 'u1' } },
    { entity: 'orgs', row: { id: 'o1' } },
  ],
} as unknown as SeedGraph;

describe('actorRowsOf', () => {
  test('carries the declared column, so the actor id is the user, not the membership', () => {
    const overrides = defineExercise({}, { actor: { entity: memberships, column: 'userId' } });
    const rows = actorRowsOf({ entities: [memberships], overrides, roles: () => [] }, graph);
    expect(rows?.column).toBe('userId');
    expect(rows?.rows).toHaveLength(1);
  });

  test('an entity alone carries no column: the row key is the id', () => {
    const overrides = defineExercise({}, { actor: memberships });
    const rows = actorRowsOf({ entities: [memberships], overrides, roles: () => [] }, graph);
    expect(rows?.column).toBeUndefined();
  });
});
