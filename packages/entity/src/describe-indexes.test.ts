// E9: one covering rule for every implicit index. A foreign key's own index that the primary key,
// a declared index or a unique invariant already leads with is LISTED (`coveredIndexes`) — and,
// on `main`, still described, so an existing app's next `x db gen` drops nothing.

import { describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { entity } from './entity';
import { invariant } from './invariants';
import { getEntity } from './registry';
import { coveringIndexOf } from './tenant-index';

const posts = entity('e9_posts', { columns: { id: uuid().primaryKey() } });
const fk = () => uuid().references(() => posts.id);

const covered = (name: string) =>
  (getEntity(name)?.coveredIndexes ?? []).map((each) => [each.name, each.coveredBy]);

const described = (name: string): readonly string[] =>
  getEntity(name)
    ?.describe()
    .indexes.map((index) => index.name) ?? [];

describe('unit · the covering rule', () => {
  test('a prefix covers; a longer list, a different leading column or an empty list does not', () => {
    const coverers = [
      { name: 'a_b', columns: ['a', 'b'] },
      { name: 'b', columns: ['b'] },
    ];
    expect(coveringIndexOf(['a'], coverers)?.name).toBe('a_b');
    expect(coveringIndexOf(['a', 'b'], coverers)?.name).toBe('a_b');
    expect(coveringIndexOf(['a', 'b', 'c'], coverers)).toBeUndefined();
    expect(coveringIndexOf(['c'], coverers)).toBeUndefined();
    expect(coveringIndexOf([], coverers)).toBeUndefined();
  });
});

describe('unit · a foreign key index another index already leads with', () => {
  test('join table: the primary key leads with the first key, so its index is covered', () => {
    entity('e9_post_tags', {
      columns: { postId: fk(), tagId: fk() },
      primaryKey: ['postId', 'tagId'],
    });
    expect(covered('e9_post_tags')).toEqual([['e9_post_tags_post_id_idx', 'e9_post_tags_pkey']]);
  });

  test('declared (fk, x): covered by that declaration', () => {
    entity('e9_declared', {
      columns: { id: uuid().primaryKey(), postId: fk(), kind: text({ max: 9 }) },
      indexes: [{ on: ['postId', 'kind'] }],
    });
    expect(covered('e9_declared')).toEqual([
      ['e9_declared_post_id_idx', 'e9_declared_post_id_kind_idx'],
    ]);
  });

  test('unique invariant (fk, y): covered by the invariant', () => {
    entity('e9_unique_pair', {
      columns: { id: uuid().primaryKey(), postId: fk(), slug: text({ max: 9 }) },
      invariants: (c) => [invariant('e9_post_slug', c.unique(['postId', 'slug']))],
    });
    expect(covered('e9_unique_pair')).toEqual([['e9_unique_pair_post_id_idx', 'e9_post_slug']]);
  });

  test('a unique fk keeps its own unique index: uniqueness is a rule, not an access path', () => {
    entity('e9_unique_fk', {
      columns: { id: uuid().primaryKey(), postId: fk().unique() },
      indexes: [{ on: ['postId', 'id'] }],
    });
    expect(covered('e9_unique_fk')).toEqual([]);
    expect(described('e9_unique_fk')).toContain('e9_unique_fk_post_id_key');
  });

  test('a partial, a gin or a second-position index covers nothing', () => {
    entity('e9_not_covering', {
      columns: { id: uuid().primaryKey(), postId: fk(), kind: text({ max: 9 }) },
      indexes: [
        { on: ['postId', 'kind'], where: (c) => c.kind.eq('a') },
        { on: ['postId'], using: 'gin' },
        { on: ['kind', 'postId'] },
      ],
    });
    expect(covered('e9_not_covering')).toEqual([]);
  });

  test('an fk index the author ALSO declared by hand is theirs, never listed', () => {
    entity('e9_hand_declared', {
      columns: { id: uuid().primaryKey(), postId: fk(), kind: text({ max: 9 }) },
      indexes: [{ on: ['postId'] }, { on: ['postId', 'kind'] }],
    });
    expect(covered('e9_hand_declared')).toEqual([]);
  });

  test('main: a covered index is still described, so an existing app generates no drop', () => {
    expect(described('e9_post_tags')).toContain('e9_post_tags_post_id_idx');
    expect(described('e9_declared')).toContain('e9_declared_post_id_idx');
    expect(described('e9_unique_pair')).toContain('e9_unique_pair_post_id_idx');
  });

  test('an index nothing leads with is not listed', () => {
    entity('e9_plain', { columns: { id: uuid().primaryKey(), postId: fk() } });
    expect(covered('e9_plain')).toEqual([]);
    expect(described('e9_plain')).toEqual(['e9_plain_post_id_idx']);
  });
});
