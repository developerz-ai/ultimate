// The entity facts nothing classified: the table a name maps to, a column's key and foreign key,
// and the invariant list. Renaming `posts` to `articles` reported `buildId: content changed`.

import { describe, expect, test } from 'bun:test';
import type { ManifestSources } from './build';
import { diffManifest } from './diff';
import { fixtureManifest } from './diff-fixtures';

type Entity = NonNullable<ManifestSources['entities']>[number];
type Column = Entity['columns'][number];

const COLUMNS: readonly Column[] = [
  { name: 'id', type: 'uuid', nullable: false, primaryKey: true },
  { name: 'authorId', type: 'uuid', nullable: false, references: 'users.id' },
  { name: 'note', type: 'text', nullable: true },
];

const post = (overrides: Partial<Entity> = {}): readonly Entity[] => [
  {
    name: 'post',
    table: 'posts',
    columns: COLUMNS,
    invariants: ['post_title_present'],
    ...overrides,
  },
];

const withColumn = (name: string, patch: Partial<Column>): readonly Entity[] =>
  post({ columns: COLUMNS.map((c) => (c.name === name ? { ...c, ...patch } : c)) });

const dropField = (name: string, field: 'primaryKey' | 'references'): readonly Entity[] =>
  post({
    columns: COLUMNS.map((column) => {
      if (column.name !== name) return column;
      const { [field]: _dropped, ...rest } = column;
      return rest;
    }),
  });

const diff = (entities: readonly Entity[]) =>
  diffManifest(fixtureManifest(), fixtureManifest({ entities }));

describe('entity facts', () => {
  test('a renamed table is breaking — every hand-written query against it stops resolving', () => {
    const changed = diff(post({ table: 'articles' }));
    expect(changed.hasBreaking).toBe(true);
    expect(changed.breaking.map((c) => c.path)).toContain('entities.post.table');
    expect(changed.breaking.find((c) => c.path === 'entities.post.table')?.detail).toContain(
      'posts -> articles',
    );
  });

  test('a dropped primary key is breaking', () => {
    const changed = diff(dropField('id', 'primaryKey'));
    expect(changed.breaking.map((c) => c.path)).toContain('entities.post.columns.id.primaryKey');
  });

  test('a dropped or retargeted foreign key is breaking', () => {
    expect(diff(dropField('authorId', 'references')).breaking.map((c) => c.path)).toContain(
      'entities.post.columns.authorId.references',
    );
    expect(
      diff(withColumn('authorId', { references: 'orgs.id' })).breaking.map((c) => c.path),
    ).toContain('entities.post.columns.authorId.references');
  });

  test('a gained primary key or foreign key is breaking too — rows that were valid are refused', () => {
    expect(diff(withColumn('note', { primaryKey: true })).breaking.map((c) => c.path)).toContain(
      'entities.post.columns.note.primaryKey',
    );
    expect(
      diff(withColumn('note', { references: 'tags.id' })).breaking.map((c) => c.path),
    ).toContain('entities.post.columns.note.references');
  });

  test('an added invariant is breaking; a dropped one is additive but reported', () => {
    const added = diff(post({ invariants: ['post_title_present', 'post_slug_unique'] }));
    expect(added.breaking.map((c) => c.path)).toContain(
      'entities.post.invariants.post_slug_unique',
    );

    const emptied = diff(post({ invariants: [] }));
    expect(emptied.hasBreaking).toBe(false);
    expect(emptied.additive.map((c) => c.path)).toContain(
      'entities.post.invariants.post_title_present',
    );
  });

  test('an unchanged entity reports nothing of its own', () => {
    expect(diff(post()).changes.filter((c) => c.path.startsWith('entities.'))).toEqual([]);
  });
});
