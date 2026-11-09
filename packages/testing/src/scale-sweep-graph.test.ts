// The scale sweep's sized graph is built with the app's factories too: a table only a factory
// satisfies (a cross-column `satisfies`) was refused there after the pass's own graph had passed.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { entity, integer, invariant, text, uuid } from '@ultimat3/entity';
import { defineFactory } from './factories';
import { scaleGraph } from './scale-sweep-graph';
import { seedGraph } from './seed-graph';
import type { SeedGraph } from './seed-graph-plan';
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

// A factory value built from the row index, on a unique column: the sized graph's factories were
// reset, so its first row rebuilt the pass's first `code` and the sized seed died on the unique key.
const coded = entity('ssg_coded', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    code: text({ max: 40 }).unique(),
    seq: integer().unique(),
  },
});
const codeFactory = defineFactory<{ code: string }>(coded, {
  defaults: (index) => ({ code: `c${index}` }),
});

describe(testName('unit', 'scaleGraph beside the pass'), () => {
  const values = (graph: SeedGraph, property: string) =>
    graph.inserts.filter((i) => i.entity === 'ssg_coded').map((i) => i.row[property]);

  test("no sized row repeats a value built from a row's position in a graph written before it", () => {
    const factories = { ssg_coded: codeFactory };
    const main = seedGraph({ orgs, coded }, { tenants: 4, seed: 1, factories });
    const small = scaleGraph(main, [orgs, coded], { perTable: 2, seed: 2, factories });
    const large = scaleGraph(main, [orgs, coded], {
      perTable: 8,
      seed: 3,
      factories,
      beside: small.write,
    });
    for (const property of ['code', 'seq']) {
      const written = [main, small.write, large.write].flatMap((graph) => values(graph, property));
      expect(written.length).toBe(main.inserts.filter((i) => i.entity === 'ssg_coded').length + 10);
      expect(new Set(written).size).toBe(written.length);
    }
  });

  test('the same graph twice is the same bytes: the offset is a position, never a clock', () => {
    const factories = { ssg_coded: codeFactory };
    const main = seedGraph({ orgs, coded }, { tenants: 2, seed: 1, factories });
    const once = scaleGraph(main, [orgs, coded], { perTable: 2, seed: 2, factories });
    const twice = scaleGraph(main, [orgs, coded], { perTable: 2, seed: 2, factories });
    expect(twice.write).toEqual(once.write);
  });
});
