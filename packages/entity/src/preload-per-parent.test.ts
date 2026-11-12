// What `preload(rel, { perParent: n })` means: at most n related rows per parent, newest first
// unless an order is named, read in one statement for the page (`latest-by.ts`), and the refusals
// — a `belongsTo` has one row already, and n is a count. The wire side is in
// `preload-statements.test.ts`.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { EntityError } from './errors';
import { clearRegistry } from './registry';

const authors = entity('per_parent_authors', {
  columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
});

const notes = entity('per_parent_notes', {
  columns: {
    id: uuid().primaryKey(),
    authorId: uuid().references(() => authors.id),
    title: text({ max: 40 }),
  },
});

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

const ANA = idAt(1);
const BEN = idAt(2);
const CY = idAt(3);
const NOTES = 'per_parent_notes';

const handle = () => database({ authors, notes }, { driver: memoryDriver() });
let db: ReturnType<typeof handle>;

beforeEach(async () => {
  db = handle();
  for (const [id, name] of [
    [ANA, 'ana'],
    [BEN, 'ben'],
    [CY, 'cy'],
  ] as const) {
    await db.authors.insert({ id, name });
  }
  // Ana: 4 notes, Ben: 1, Cy: none. Titles run against the ids so an order is visible.
  for (const [index, authorId, title] of [
    [10, ANA, 'd'],
    [11, ANA, 'c'],
    [12, ANA, 'b'],
    [13, ANA, 'a'],
    [20, BEN, 'z'],
  ] as const) {
    await db.notes.insert({ id: idAt(index), authorId, title });
  }
});

afterAll(() => {
  clearRegistry();
});

const attached = (row: unknown): readonly unknown[] =>
  ((row as Record<string, unknown>)[NOTES] as readonly Record<string, unknown>[]).map(
    (note) => note['id'],
  );

describe('perParent', () => {
  test('at most n per parent, newest key first; a parent with fewer keeps them; none is []', async () => {
    const rows = await db.authors.orderBy('id').preload(NOTES, { perParent: 2 }).all();

    expect(rows.map(attached)).toEqual([[idAt(13), idAt(12)], [idAt(20)], []]);
  });

  test('a named order picks which n, in the direction stated', async () => {
    const rows = await db.authors
      .orderBy('id')
      .preload(NOTES, { perParent: 1, order: 'title', direction: 'desc' })
      .all();

    expect(rows.map(attached)).toEqual([[idAt(10)], [idAt(20)], []]);
  });

  test('the ceiling still bounds what one page attaches', async () => {
    const chain = () => db.authors.orderBy('id').preload(NOTES, { perParent: 3, max: 3 });
    await expect(chain().all()).rejects.toBeInstanceOf(EntityError);
    expect(
      (await db.authors.orderBy('id').preload(NOTES, { perParent: 2, max: 3 }).all()).map(attached),
    ).toEqual([[idAt(13), idAt(12)], [idAt(20)], []]);
  });

  test('a later call stating perParent replaces the earlier one', async () => {
    const rows = await db.authors
      .orderBy('id')
      .preload(NOTES, { perParent: 3 })
      .preload(NOTES, { perParent: 1 })
      .all();

    expect(rows.map(attached)).toEqual([[idAt(13)], [idAt(20)], []]);
  });
});

describe('the refusals', () => {
  const refusal = (run: () => unknown): EntityError => {
    try {
      run();
    } catch (error) {
      if (error instanceof EntityError) return error;
      throw error;
    }
    return expect.unreachable('expected an EntityError');
  };

  test('perParent on a belongsTo is refused on the chain — it already attaches one row', () => {
    const error = refusal(() => db.notes.preload('author', { perParent: 1 }));
    expect(error.code).toBe('X_INVARIANT_VIOLATED');
    expect(error.message).toContain('belongsTo');
  });

  test('perParent that is not a whole count is refused with a runnable fix', () => {
    for (const perParent of [0, 1.5, -1]) {
      const error = refusal(() => db.authors.preload(NOTES, { perParent }));
      expect(error.message).toContain('perParent');
      expect(error.fix).toContain('x entities show');
    }
  });

  test('an order without perParent is refused: a whole relation has no "first n"', () => {
    const error = refusal(() => db.authors.preload(NOTES, { order: 'title' }));
    expect(error.message).toContain('perParent');
  });
});
