// Single responsibility: pin `partition-order.ts` — a partition loads after its parent and in its
// root's file whatever the names sort as, and a partitioned index loads without `ONLY`.

import { describe, expect, test } from 'bun:test';
import type { CatalogTable } from './catalog';
import { indexDefinitionOf, inLoadOrder } from './partition-order';

const table = (name: string, parent?: string): CatalogTable => ({
  name,
  unlogged: false,
  options: null,
  columns: [],
  constraints: [],
  sequences: [],
  replicaIdentity: { kind: 'default' },
  ...(parent === undefined ? {} : { partitionOf: { table: parent, bound: 'DEFAULT' } }),
});

const placed = (tables: readonly CatalogTable[]): readonly string[] =>
  inLoadOrder(tables).map(({ table: each, file }) => `${file}:${each.name}`);

describe('inLoadOrder', () => {
  test('an unpartitioned schema keeps its order, each table in its own file', () => {
    expect(placed([table('a'), table('b')])).toEqual(['a:a', 'b:b']);
  });

  test('a partition named to sort first still loads after its parent, in the root file', () => {
    expect(
      placed([table('a_2026', 'events'), table('a_2026_q1', 'a_2026'), table('events')]),
    ).toEqual(['events:events', 'events:a_2026', 'events:a_2026_q1']);
  });

  test('a partition whose parent is not in the list is still placed, under itself', () => {
    expect(placed([table('orphan', 'elsewhere')])).toEqual(['orphan:orphan']);
  });
});

describe('indexDefinitionOf', () => {
  test('`ON ONLY` after the index name is dropped; any other definition is untouched', () => {
    expect(indexDefinitionOf('CREATE INDEX e_idx ON ONLY public.events USING btree (kind)')).toBe(
      'CREATE INDEX e_idx ON public.events USING btree (kind)',
    );
    expect(
      indexDefinitionOf('CREATE UNIQUE INDEX "a ON ONLY b" ON ONLY public.e USING btree (id)'),
    ).toBe('CREATE UNIQUE INDEX "a ON ONLY b" ON public.e USING btree (id)');
    const plain = 'CREATE INDEX only_idx ON public.only USING btree (id)';
    expect(indexDefinitionOf(plain)).toBe(plain);
  });
});
