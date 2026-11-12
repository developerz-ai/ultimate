// `text().collate('C')`: the one collation a column may declare, because it is the one the live
// matcher and the memory driver already order by (code point). It reaches the projection
// `@ultimat3/db` renders, survives the other links, and anything but `'C'` is refused where written.

import { afterAll, describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => clearRegistry());

const codeOf = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
};

describe('text().collate()', () => {
  test('records the collation on the column', () => {
    expect(text({ max: 40 }).collate('C').$meta.collation).toBe('C');
  });

  test('an undeclared collation stays absent, so no description moves', () => {
    expect('collation' in text().$meta).toBe(false);
  });

  test('the links after it keep it and keep the text builder', () => {
    const column = text().collate('C').nullable().column('display_name');
    expect(column.$meta.collation).toBe('C');
    expect(column.$meta.notNull).toBe(false);
    expect(typeof column.sealed).toBe('function');
  });

  test('a collation other than C is refused where it is written', () => {
    const collate = text().collate as (collation: string) => unknown;
    expect(codeOf(() => collate('en_US'))).toBe('X_INVARIANT_VIOLATED');
  });

  test('describe carries it to the column description, and only on the declaring column', () => {
    const people = entity('collate_people', {
      columns: { id: uuid().primaryKey(), name: text({ max: 40 }).collate('C'), bio: text() },
    });
    const byProperty = new Map(people.$describe().columns.map((c) => [c.property, c]));
    expect(byProperty.get('name')?.collation).toBe('C');
    expect(byProperty.get('name')?.kind).toBe('text');
    expect(
      byProperty.get('bio') !== undefined && 'collation' in (byProperty.get('bio') ?? {}),
    ).toBe(false);
  });
});
