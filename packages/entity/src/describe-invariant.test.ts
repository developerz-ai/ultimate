/**
 * The invariant half of the `entity` -> `@ultimat3/db` projection: the physical columns a rule
 * reads cross the tier seam as DATA. A generator that has to re-split the rule's own `sql` is
 * reading a rendering back, which is the failure `IndexDescription.columns` already exists against.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { declaredIndexes, uniqueColumns } from '@ultimat3/db';
import { enumerated, integer, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { invariant } from './invariants';
import type { InvariantDescription } from './registry';
import { clearRegistry } from './registry';

const coherent = (status: string, publishedAt: Date | null): boolean =>
  (status === 'published') === (publishedAt !== null);

const posts = entity('describe_invariant_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    slug: text({ max: 80 }),
    likeCount: integer().default(0),
    status: enumerated(['draft', 'published']).default('draft'),
    publishedAt: timestamp().nullable(),
    deletedAt: timestamp().nullable(),
  },
  invariants: (c) => [
    invariant('like_count_non_negative', c.likeCount.atLeast(0)),
    invariant('slug_unique_per_org', c.unique(['orgId', 'slug'])),
    invariant('publish_coherent', c.satisfies(coherent, ['status', 'publishedAt'])),
  ],
});

const projected = (name: string): InvariantDescription => {
  const found = posts.$describe().invariants.find((inv) => inv.name === name);
  if (found === undefined) expect.unreachable(`describe() dropped the invariant ${name}`);
  return found;
};

afterAll(() => {
  clearRegistry();
});

describe('the invariant projection', () => {
  test('a unique invariant names its physical columns as a list, never only as joined text', () => {
    expect(projected('slug_unique_per_org').columns).toEqual(['org_id', 'slug']);
  });

  test('a check and an assert name the columns they read, in the same field', () => {
    // One meaning for one field: `Invariant.columns` is "the physical names this rule reads" for
    // every kind, so narrowing the projection to `unique` would give the field a second meaning
    // that depends on the sibling `kind`.
    expect(projected('like_count_non_negative').columns).toEqual(['like_count']);
    expect(projected('publish_coherent').columns).toEqual(['status', 'published_at']);
  });

  test('@ultimat3/db reads that list, not a comma-split of the rule sql', () => {
    // The two readings agree on every declarable entity, so only a description whose `sql` and
    // `columns` disagree can say WHICH one the generator used — and the generator using `sql` is
    // exactly the lossy re-read this field exists to retire.
    const unique = projected('slug_unique_per_org');
    const tampered: InvariantDescription = { ...unique, sql: 'not_a_column_list' };
    expect(uniqueColumns('describe_invariant_posts', tampered)).toEqual(['org_id', 'slug']);
  });

  test('the unique index the generator declares is unchanged by the new field', () => {
    const key = declaredIndexes(posts.$describe()).find((index) =>
      index.name.endsWith('_slug_unique_per_org_key'),
    );
    expect(key).toEqual({
      name: 'describe_invariant_posts_slug_unique_per_org_key',
      columns: ['org_id', 'slug'],
      unique: true,
      where: 'deleted_at is null',
      order: null,
    });
  });
});
