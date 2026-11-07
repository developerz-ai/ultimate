// The scale sweep's sized graph is built with the app's factories too: a table only a factory
// satisfies (a cross-column `satisfies`) was refused there after the pass's own graph had passed.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { entity, integer, invariant, text, uuid } from '@ultimat3/entity';
import { defineFactory } from './factories';
import { scaleGraph } from './scale-sweep-graph';
import { seedGraph } from './seed-graph';
import { testName } from './test-types';

// A label that spells its own size: no generated pair of a text and an integer meets it.
const spelled = (label: string, size: number): boolean => label === `size-${size}`;
const orgs = entity('ssg_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const labelled = entity('ssg_labelled', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    label: text({ max: 40 }),
    size: integer(),
  },
  invariants: (c) => [invariant('ssg_label_spells_size', c.satisfies(spelled, ['label', 'size']))],
});
const factory = defineFactory<{ label: string; size: number }>(labelled, {
  defaults: (index) => ({ label: `size-${index}`, size: index }),
});
const factories = { ssg_labelled: factory };

describe(testName('unit', 'scaleGraph'), () => {
  test("builds the sized rows with the app's factories, as the pass's graph is built", () => {
    const main = seedGraph({ orgs, labelled }, { tenants: 2, seed: 1, factories });
    const sized = scaleGraph(main, [orgs, labelled], { perTable: 8, seed: 2, factories });
    const rows = sized.write.inserts.filter((insert) => insert.entity === 'ssg_labelled');
    expect(rows.length).toBeGreaterThan(0);
    for (const { row } of rows) {
      expect(() => labelled.$assert(labelled.$parse(row))).not.toThrow();
    }
  });

  test('without them the sized graph is refused, as the pass met it before 30.1.1', () => {
    const main = seedGraph({ orgs, labelled }, { tenants: 2, seed: 1, factories });
    let caught: unknown;
    try {
      scaleGraph(main, [orgs, labelled], { perTable: 8, seed: 2 });
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) && caught.code).toBe('X_SEED_GRAPH_UNSATISFIED');
  });
});
