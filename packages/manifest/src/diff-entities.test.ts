// The entity facts nothing classified: the table a name maps to, a column's key and foreign key,
// and the invariant list. Renaming `posts` to `articles` reported `buildId: content changed`.

import { describe, expect, test } from 'bun:test';
import type { ManifestSources } from './build';
import { diffManifest } from './diff';
import { fixtureManifest } from './diff-fixture';

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

  // Both directions, because `diffInvariants` already states why: "a rule that quietly stopped
  // being enforced is what a reviewer of a data migration most needs to see." `diffColumns`
  // implemented only the tightening half, so a column dropping NOT NULL reported nothing at all.
  test('a column that loses NOT NULL is additive, and reported', () => {
    const loosened = diff(withColumn('authorId', { nullable: true }));
    expect(loosened.hasBreaking).toBe(false);
    const change = loosened.additive.find(
      (c) => c.path === 'entities.post.columns.authorId.nullable',
    );
    expect(change?.detail).toBe('became nullable');
  });

  test('a column that gains NOT NULL is still breaking', () => {
    const tightened = diff(withColumn('note', { nullable: false }));
    expect(
      tightened.breaking.find((c) => c.path === 'entities.post.columns.note.nullable')?.detail,
    ).toBe('became NOT NULL');
  });

  // `.sealed()` changes no DDL and no column type, so before this the diff said nothing at all —
  // while the field left every action output, every query row and every record the app sends.
  describe('a column changing how it is sealed', () => {
    const at = 'entities.post.columns.note.sealed';
    const from = (how: 'opaque' | 'lookup', to?: 'opaque' | 'lookup') =>
      diffManifest(
        fixtureManifest({ entities: withColumn('note', { sealed: how }) }),
        fixtureManifest({
          entities: to === undefined ? post() : withColumn('note', { sealed: to }),
        }),
      );

    test('becoming sealed is breaking: the field is removed from every output', () => {
      for (const how of ['opaque', 'lookup'] as const) {
        const changed = diff(withColumn('note', { sealed: how }));
        const change = changed.breaking.find((c) => c.path === at);
        expect(change?.detail).toContain(`became sealed (${how})`);
        expect(change?.detail).toContain('output');
      }
    });

    test('unsealing is breaking too: stored values stay ciphertext, and the field joins every output', () => {
      const change = from('opaque').breaking.find((c) => c.path === at);
      expect(change?.detail).toContain('no longer sealed');
    });

    test('lookup -> opaque is breaking: equality filters and unique are now refused', () => {
      expect(from('lookup', 'opaque').breaking.find((c) => c.path === at)?.detail).toBe(
        'sealed lookup -> opaque; an equality filter or a unique rule on it is now refused',
      );
    });

    test('opaque -> lookup is additive, and reported: equal values now store equal strings', () => {
      const changed = from('opaque', 'lookup');
      expect(changed.hasBreaking).toBe(false);
      expect(changed.additive.find((c) => c.path === at)?.detail).toContain('opaque -> lookup');
    });

    test('a column sealed the same way on both sides reports nothing', () => {
      expect(from('lookup', 'lookup').changes.filter((c) => c.path === at)).toEqual([]);
    });
  });

  test('an unchanged entity reports nothing of its own', () => {
    expect(diff(post()).changes.filter((c) => c.path.startsWith('entities.'))).toEqual([]);
  });
});

// `hasDefault` was read for an ADDED column only, so a NOT NULL column losing its default reported
// nothing but `buildId` — while every writer that omitted the column started being refused.
describe('a column default that moved', () => {
  const between = (before: readonly Entity[], after: readonly Entity[]) =>
    diffManifest(fixtureManifest({ entities: before }), fixtureManifest({ entities: after }))
      .changes.filter((change) => change.path.endsWith('.hasDefault'))
      .map(({ kind, path }) => ({ kind, path }));

  test('dropped from a NOT NULL column is breaking', () => {
    expect(between(withColumn('authorId', { hasDefault: true }), post())).toEqual([
      { kind: 'breaking', path: 'entities.post.columns.authorId.hasDefault' },
    ]);
  });

  test('dropped from a nullable column is reported, and refuses no writer', () => {
    expect(between(withColumn('note', { hasDefault: true }), post())).toEqual([
      { kind: 'internal', path: 'entities.post.columns.note.hasDefault' },
    ]);
  });

  test('gained is additive, and an unmoved default reports nothing', () => {
    expect(between(post(), withColumn('authorId', { hasDefault: true }))).toEqual([
      { kind: 'additive', path: 'entities.post.columns.authorId.hasDefault' },
    ]);
    const kept = withColumn('authorId', { hasDefault: true });
    expect(between(kept, kept)).toEqual([]);
  });
});
