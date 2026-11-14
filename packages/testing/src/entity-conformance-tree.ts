// Entity conformance · the PREDICATE TREE: `andWhereNode` with an `or` group and a `via` hop answers
// the same rows on every driver, and a hop's subselect runs under its TARGET's tenant and soft
// delete — a friendship recorded in another org never widens this org's read. The security half of
// the feature is the tenancy checks here; each would pass on a driver that read the target raw.

import { expect } from 'bun:test';
import type { Database } from '@ultimat3/entity';
import { entity, text, timestamp, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf, idAt, inOrg } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const posts = remember(
  entity('ec_tree_posts', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      authorId: uuid(),
      audience: text({ max: 10 }),
      body: text({ max: 20 }),
    },
  }),
);

const friendships = remember(
  entity('ec_tree_friendships', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      userId: uuid(),
      friendId: uuid(),
      deletedAt: timestamp().nullable(),
    },
  }),
);

/** Untenanted and undeclared: a hop into it from a tenant table is an unscoped read. */
const handles = remember(
  entity('ec_tree_handles', { columns: { id: uuid().primaryKey(), userId: uuid() } }),
);

/** Untenanted and SAID so: a hop into it is the reach `shared:` already declares. */
const badges = remember(
  entity('ec_tree_badges', {
    columns: { id: uuid().primaryKey(), userId: uuid(), kind: text({ max: 10 }) },
    shared: 'a badge hangs off a user, whichever org reads it',
  }),
);

const ORG = idAt('b1');
const OTHER_ORG = idAt('b2');
const ME = idAt('c1');
const FRIEND = idAt('c2');
const STRANGER = idAt('c3');
const EX = idAt('c4');

const tables = { posts, friendships, handles, badges };
type Tree = Database<typeof tables>;

/** Seeded as a script would, naming every tenant: the table's own answer. */
const seed = async (db: Tree): Promise<void> => {
  const post = (n: number, authorId: string, audience: string, orgId = ORG) =>
    db.posts.insert({ id: idAt(`d${n}`), orgId, authorId, audience, body: `p${n}` });
  await post(1, ME, 'private');
  await post(2, FRIEND, 'friends');
  await post(3, STRANGER, 'friends');
  await post(4, STRANGER, 'public');
  await post(5, EX, 'friends');
  await post(6, FRIEND, 'public', OTHER_ORG);
  const friend = (n: number, friendId: string, orgId: string, deletedAt: Date | null = null) =>
    db.friendships.insert({ id: idAt(`e${n}`), orgId, userId: ME, friendId, deletedAt });
  await friend(1, FRIEND, ORG);
  // The whole point: in ANOTHER org, ME is friends with STRANGER. Read in ORG, it must not count.
  await friend(2, STRANGER, OTHER_ORG);
  // A friendship that ended: soft-deleted, so it must not count either.
  await friend(3, EX, ORG, new Date('2026-01-01T00:00:00.000Z'));
  await db.handles.insert({ id: idAt('f1'), userId: FRIEND });
  await db.badges.insert({ id: idAt('f2'), userId: FRIEND, kind: 'gold' });
};

const bodies = (rows: readonly { readonly body: string }[]): readonly string[] =>
  rows.map((row) => row.body).sort();

const friendsOfMe = {
  via: { column: 'authorId', entity: 'ec_tree_friendships', target: 'friendId' },
  where: [{ column: 'userId', op: 'eq', value: ME }],
} as const;

export const TREE_CHECKS: readonly EntityDriverCheck[] = [
  checkOver(
    tables,
    'an or group answers the rows any member matches, and an empty one answers none',
    async (db) => {
      await seed(db);
      const visible = await inOrg(ORG, () =>
        db.posts
          .andWhereNode({
            or: [
              { column: 'audience', op: 'eq', value: 'public' },
              { column: 'authorId', op: 'eq', value: ME },
            ],
          })
          .all(),
      );
      expect(bodies(visible)).toEqual(['p1', 'p4']);
      expect(await inOrg(ORG, () => db.posts.andWhereNode({ or: [] }).all())).toEqual([]);
      const counted = await inOrg(ORG, () =>
        db.posts
          .andWhereNode({ or: [{ column: 'audience', op: 'in', value: ['friends', 'private'] }] })
          .count(),
      );
      expect(counted).toBe(4);
    },
    ['predicate:or'],
  ),
  checkOver(
    tables,
    'a via hop reads its target under the target’s tenant: another org’s friendship never counts',
    async (db) => {
      await seed(db);
      const read = await inOrg(ORG, () => db.posts.andWhereNode(friendsOfMe).all());
      // p2 (FRIEND, an ORG friendship). Not p3/p4: ME↔STRANGER is OTHER_ORG's row. Not p5: ended.
      expect(bodies(read)).toEqual(['p2']);
      const there = await inOrg(OTHER_ORG, () => db.posts.andWhereNode(friendsOfMe).all());
      // In OTHER_ORG the friendship with STRANGER counts, and FRIEND's ORG friendship does not.
      expect(bodies(there)).toEqual([]);
    },
    ['predicate:via'],
  ),
  checkOver(
    tables,
    'the demo’s visibility rule is one tree: mine, public, or a friend’s friends-only post',
    async (db) => {
      await seed(db);
      const rule = {
        or: [
          { column: 'authorId', op: 'eq', value: ME },
          { column: 'audience', op: 'eq', value: 'public' },
          { or: [{ column: 'audience', op: 'eq', value: 'friends' }, friendsOfMe] },
        ],
      } as const;
      const read = await inOrg(ORG, () => db.posts.andWhereNode(rule).all());
      // `friends OR friend-of-me` is wider than the demo's AND; the next level narrows it.
      expect(bodies(read)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
      const exact = await inOrg(ORG, () =>
        db.posts
          .andWhereNode({
            or: [
              { column: 'authorId', op: 'eq', value: ME },
              { column: 'audience', op: 'eq', value: 'public' },
              { via: friendsOfMe.via, where: friendsOfMe.where },
            ],
          })
          .andWhere('audience', 'neq', 'private')
          .all(),
      );
      expect(bodies(exact)).toEqual(['p2', 'p4']);
    },
    ['predicate:or', 'predicate:via'],
  ),
  checkOver(
    tables,
    'a hop into an untenanted table is refused unless it declares shared:',
    async (db) => {
      await seed(db);
      const into = (name: string) =>
        db.posts
          .andWhereNode({
            via: { column: 'authorId', entity: name, target: 'userId' },
            where: [],
          })
          .all();
      expect(await inOrg(ORG, () => codeOf(() => into('ec_tree_handles')))).toBe(
        'X_TENANCY_UNSCOPED',
      );
      expect(bodies(await inOrg(ORG, () => into('ec_tree_badges')))).toEqual(['p2']);
    },
    ['predicate:via'],
  ),
  checkOver(
    tables,
    'outside a request a hop into a tenant table must name its tenant, as a read of it must',
    async (db) => {
      await seed(db);
      const unnamed = () => db.posts.where({ orgId: ORG }).andWhereNode(friendsOfMe).all();
      expect(await codeOf(unnamed)).toBe('X_TENANCY_UNSCOPED');
      const named = await db.posts
        .where({ orgId: ORG })
        .andWhereNode({
          via: friendsOfMe.via,
          where: [...friendsOfMe.where, { column: 'orgId', op: 'eq', value: ORG }],
        })
        .all();
      expect(bodies(named)).toEqual(['p2']);
    },
    ['predicate:via'],
  ),
];
