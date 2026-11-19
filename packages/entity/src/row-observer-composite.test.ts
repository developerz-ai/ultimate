// The before-read of an upsert on a COMPOSITE natural key reads the pairs asked for — never the
// Cartesian product of each column's values, which a diagonal batch turns into n² stored rows.

import { afterEach, describe, expect, test } from 'bun:test';
import type { EntityRowEvent } from '@ultimat3/core';
import { resetInstrumentation, subscribe } from '@ultimat3/core';
import { recordingClient, setDbClient } from '@ultimat3/db';
import { text, uuid } from './columns';
import { entity } from './entity';
import { invariant } from './invariants';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { Repo } from './repo';
import { observedRepo } from './row-observer';

const cells = entity('observed_cells', {
  columns: { id: uuid().primaryKey(), row: text({ max: 8 }), col: text({ max: 8 }), v: text() },
  invariants: (c) => [invariant('observed_cells_pair', c.unique(['row', 'col']))],
});
type Cell = typeof cells.$row;

const idAt = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

const SIDE = 6;
/** Every (row, col) pair of a SIDE × SIDE grid: a diagonal batch's per-column `in` lists match all. */
const grid: Cell[] = Array.from({ length: SIDE * SIDE }, (_, index) => ({
  id: idAt(index + 1),
  row: `r${Math.floor(index / SIDE)}`,
  col: `c${index % SIDE}`,
  v: 'old',
}));
const diagonal = Array.from({ length: SIDE }, (_, index) => ({
  row: `r${index}`,
  col: `c${index}`,
  v: 'new',
}));

afterEach(() => {
  resetInstrumentation();
  setDbClient(undefined);
  clearRegistry();
});

describe('a composite conflict target reads its tuples, not their product', () => {
  test('a diagonal batch reads exactly its own stored rows, and reports each as an update', async () => {
    const seen: EntityRowEvent[] = [];
    subscribe('entity.row', (event) => void seen.push(event.payload));
    const stored = memoryRepo(cells, grid);
    let read = 0;
    const counting: Repo<Cell> = {
      ...stored,
      findMany: async (args) => {
        const page = await stored.findMany(args);
        read += page.rows.length;
        return page;
      },
    };

    await observedRepo(cells, counting).upsertAll(diagonal as Cell[], {
      onConflict: ['row', 'col'],
      onMatch: 'update',
    });

    expect(read).toBe(SIDE);
    expect(seen.map((change) => [change.op, change.before?.['v'], change.after?.['v']])).toEqual(
      diagonal.map(() => ['update', 'old', 'new']),
    );
    expect(seen.map((change) => change.before?.['col'])).toEqual(diagonal.map((cell) => cell.col));
  });

  test('postgres: one statement matching each pair as a pair', async () => {
    subscribe('entity.row', () => undefined);
    const recorded = recordingClient();
    setDbClient(recorded);
    recorded.on('insert into "observed_cells"', { rows: [] });

    await observedRepo(cells, postgresRepo(cells)).upsertAll(diagonal as Cell[], {
      onConflict: ['row', 'col'],
    });

    const reads = recorded.texts.filter((text) => text.startsWith('select'));
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toContain('"row" in (');
    expect(reads[0]).toContain(' or ');
  });
});
