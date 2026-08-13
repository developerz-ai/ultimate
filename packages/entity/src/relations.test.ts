// What a `references()` means once it is read as an association: which relations exist, what they
// are called, and which side each key lives on. The naming rules are the interesting part — a
// relation nobody can name is a relation nobody can preload.

import { afterAll, describe, expect, test } from 'bun:test';
import { money, text, timestamp, uuid } from './columns';
import type { EntityCore } from './entity';
import { entity } from './entity';
import type { RegistryEntry } from './registry';
import { clearRegistry, getEntity } from './registry';
import { relationsOf } from './relations';

const orgs = entity('relations_test_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

const members = entity('relations_test_members', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    email: text({ max: 120 }),
  },
});

const posts = entity('relations_test_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    authorId: uuid().references(() => members.id),
    /** Nullable on purpose: a post nobody reviewed is data, not a broken key. */
    reviewerId: uuid()
      .references(() => members.id)
      .nullable(),
    title: text({ max: 120 }),
    /** Money is two physical columns, so a reference declared on it names neither. */
    bounty: money().references(() => orgs.id),
  },
});

/** The join table: a composite key, two foreign keys, no id of its own. */
const likes = entity('relations_test_likes', {
  columns: {
    postId: uuid().references(() => posts.id, { onDelete: 'cascade' }),
    memberId: uuid().references(() => members.id, { onDelete: 'cascade' }),
    createdAt: timestamp().defaultNow(),
  },
  primaryKey: ['postId', 'memberId'],
});

/** A tree: the FK points at the entity that declares it. */
const comments = entity('relations_test_comments', {
  columns: {
    id: uuid().primaryKey(),
    postId: uuid().references(() => posts.id),
    parentId: uuid()
      .references(() => comments.id)
      .nullable(),
    body: text(),
  },
});

/** The registry entry `entity()` left behind — the resolved foreign keys the map is derived from. */
const entriesOf = (...entities: readonly EntityCore[]): readonly RegistryEntry[] =>
  entities.flatMap((one) => {
    const entry = getEntity(one.$name);
    return entry === undefined ? [] : [entry];
  });

const ALL = entriesOf(orgs, members, posts, likes, comments);

afterAll(() => {
  clearRegistry();
});

const caught = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('relationsOf()', () => {
  test('reads a belongsTo off the entity that declared the foreign key', () => {
    const relations = relationsOf(ALL)[posts.$name] ?? {};
    expect(relations.author).toEqual({
      kind: 'belongsTo',
      name: 'author',
      from: 'relations_test_posts',
      to: 'relations_test_members',
      localKey: 'authorId',
      localColumn: 'author_id',
      remoteKey: 'id',
      remoteColumn: 'id',
      nullable: false,
    });
  });

  test('reads a hasMany off the inbound foreign keys, keys the other way round', () => {
    const relations = relationsOf(ALL)[members.$name] ?? {};
    expect(relations.relations_test_likes).toEqual({
      kind: 'hasMany',
      name: 'relations_test_likes',
      from: 'relations_test_members',
      to: 'relations_test_likes',
      localKey: 'id',
      localColumn: 'id',
      remoteKey: 'memberId',
      remoteColumn: 'member_id',
      nullable: false,
    });
  });

  test('names a belongsTo after the key minus its Id, and carries nullability', () => {
    const relations = relationsOf(ALL)[posts.$name] ?? {};
    expect(Object.keys(relations)).toEqual([
      'author',
      'org',
      'relations_test_comments',
      'relations_test_likes',
      'reviewer',
    ]);
    expect(relations.reviewer?.nullable).toBe(true);
    expect(relations.author?.nullable).toBe(false);
  });

  test('gives a composite-key join table one belongsTo per foreign key and no id of its own', () => {
    const relations = relationsOf(ALL)[likes.$name] ?? {};
    expect(Object.keys(relations)).toEqual(['member', 'post']);
    expect(relations.post?.localKey).toBe('postId');
    expect(relations.post?.remoteKey).toBe('id');
    expect(relations.member?.to).toBe('relations_test_members');
  });

  test('resolves a self-reference to both sides of the same entity', () => {
    const relations = relationsOf(ALL)[comments.$name] ?? {};
    expect(relations.parent).toMatchObject({
      kind: 'belongsTo',
      from: 'relations_test_comments',
      to: 'relations_test_comments',
      localKey: 'parentId',
      remoteKey: 'id',
      nullable: true,
    });
    expect(relations.relations_test_comments).toMatchObject({
      kind: 'hasMany',
      from: 'relations_test_comments',
      to: 'relations_test_comments',
      localKey: 'id',
      remoteKey: 'parentId',
    });
  });

  test('declares no relation for a money column: neither physical column is named', () => {
    const relations = relationsOf(ALL)[posts.$name] ?? {};
    expect(relations.bounty).toBeUndefined();
    expect(Object.values(relationsOf(ALL)[orgs.$name] ?? {}).map((r) => r.remoteKey)).not.toContain(
      'bounty',
    );
  });

  test('keeps a belongsTo whose target is outside the set, and no hasMany for it', () => {
    const map = relationsOf(entriesOf(posts));
    expect(Object.keys(map)).toEqual(['relations_test_posts']);
    expect(map.relations_test_posts?.org?.to).toBe('relations_test_orgs');
    expect(map.relations_test_posts?.relations_test_likes).toBeUndefined();
  });

  test('is keyed in sorted order and unaffected by the order it was handed', () => {
    const forward = relationsOf(ALL);
    const shuffled = relationsOf(entriesOf(comments, posts, orgs, likes, members));
    expect(Object.keys(forward)).toEqual([
      'relations_test_comments',
      'relations_test_likes',
      'relations_test_members',
      'relations_test_orgs',
      'relations_test_posts',
    ]);
    expect(shuffled).toEqual(forward);
  });

  test('counts the same entity handed in twice as one', () => {
    expect(relationsOf(entriesOf(posts, members, posts))).toEqual(
      relationsOf(entriesOf(posts, members)),
    );
  });
});

describe('relation names under collision', () => {
  const users = entity('relations_collide_users', {
    columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
  });

  /** Two keys to one target: the belongsTo names differ, the hasMany names do not. */
  const tickets = entity('relations_collide_tickets', {
    columns: {
      id: uuid().primaryKey(),
      reporterId: uuid().references(() => users.id),
      assigneeId: uuid()
        .references(() => users.id)
        .nullable(),
    },
  });

  test('the whole colliding group falls back — not whichever key was declared second', () => {
    const relations = relationsOf(entriesOf(users, tickets))[users.$name] ?? {};
    expect(Object.keys(relations)).toEqual([
      'relations_collide_ticketsByAssignee',
      'relations_collide_ticketsByReporter',
    ]);
    expect(relations.relations_collide_ticketsByAssignee?.remoteKey).toBe('assigneeId');
  });

  test('the uncontested side keeps the short name', () => {
    const relations = relationsOf(entriesOf(users, tickets))[tickets.$name] ?? {};
    expect(Object.keys(relations)).toEqual(['assignee', 'reporter']);
  });

  test('a belongsTo and a hasMany contesting one name both fall back', () => {
    // Two entities pointing at each other: `shops` names carts by its own key, and carts name
    // shops back — so on `shops` a belongsTo and a hasMany both want `relations_collide_carts`.
    const carts = entity('relations_collide_carts', {
      columns: { id: uuid().primaryKey(), shopId: uuid().references(() => shops.id) },
    });
    const shops = entity('relations_collide_shops', {
      columns: {
        id: uuid().primaryKey(),
        relations_collide_cartsId: uuid().references(() => carts.id),
      },
    });
    const relations = relationsOf(entriesOf(carts, shops))[shops.$name] ?? {};
    expect(Object.keys(relations)).toEqual([
      'relations_collide_cartsByShop',
      'relations_collide_cartsId',
    ]);
    expect(relations.relations_collide_cartsId?.kind).toBe('belongsTo');
    expect(relations.relations_collide_cartsByShop?.kind).toBe('hasMany');
    // The other side is uncontested and keeps the short name.
    expect(Object.keys(relationsOf(entriesOf(carts, shops))[carts.$name] ?? {})).toEqual([
      'relations_collide_shops',
      'shop',
    ]);
  });

  test('refuses two foreign keys that differ only by an Id suffix, naming both columns', () => {
    const badges = entity('relations_bad_badges', {
      columns: { id: uuid().primaryKey(), label: text({ max: 20 }) },
    });
    const holders = entity('relations_bad_holders', {
      columns: {
        id: uuid().primaryKey(),
        badge: uuid().references(() => badges.id),
        badgeId: uuid().references(() => badges.id),
      },
    });
    const error = caught(() => relationsOf(entriesOf(badges, holders)));
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(String(error)).toContain('relations_bad_holders.badge');
    expect(String(error)).toContain('relations_bad_holders.badgeId');
    // The owning side is fine: `badge` and `badgeId` are two distinct fallbacks.
    expect(Object.keys(relationsOf(entriesOf(holders))[holders.$name] ?? {})).toEqual([
      'badge',
      'badgeId',
    ]);
  });

  test('refuses a reference to a column that belongs to no entity', () => {
    const loose = uuid().primaryKey();
    const strays = entity('relations_bad_strays', {
      columns: { id: uuid().primaryKey(), looseId: uuid().references(() => loose) },
    });
    expect(caught(() => relationsOf(entriesOf(strays)))).toBeUltimateError('X_INVARIANT_VIOLATED');
  });
});
