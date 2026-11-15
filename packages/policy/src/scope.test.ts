// A policy's SQL projection: `scoped(policy, scope)` hands down `scope(actor) → where` in the entity
// chain's predicate shape, and changes nothing about how the policy decides. The composed predicate
// is pinned for the three viewers a feed has: anonymous, a member, an admin.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { evaluate } from './evaluate';
import { clearPermissions, definePermissions } from './permissions';
import type { Policy } from './policy';
import { allow, and, can, not, or, policyPermissions } from './policy';
import { admitsAnonymous } from './policy-anonymous';
import { decideBeforeInput } from './pre-input';
import { clearRoles, defineRoles } from './roles';
import { policyScope, type ScopeCondition, type ScopeNode, scoped } from './scope';
import { testActor } from './test-kit';

interface Post {
  readonly id: string;
  readonly orgId: string;
  readonly audience: 'public' | 'members';
  readonly deletedAt: Date | null;
}

beforeEach(() => {
  clearPermissions();
  clearRoles();
  definePermissions(['post:read', 'post:moderate'] as const);
  defineRoles({
    member: { grants: ['post:read'] },
    admin: { grants: ['post:moderate'], inherits: ['member'] },
  });
});

afterAll(() => {
  clearPermissions();
  clearRoles();
});

const member = () => testActor('m1', { roles: ['member'], orgId: 'org-1' }).actor;
const admin = () => testActor('a1', { roles: ['admin'], orgId: 'org-1' }).actor;

/** The JS rule: the authority. Public posts to anyone, a member's org to a member, all to an admin. */
const rule = (): Policy<unknown, Post> =>
  or(
    can<unknown, Post>('post:moderate'),
    can<unknown, Post>('post:read', ({ actor, row }) => row?.orgId === actor?.orgId),
    allow<unknown, Post>('public posts'),
  );

/** The same rule, as the predicate the database can serve from an index. */
const visible = (): Policy<unknown, Post> =>
  scoped(rule(), (actor): readonly ScopeCondition<Post>[] => {
    const live: ScopeCondition<Post> = { column: 'deletedAt', op: 'is-null' };
    if (actor === null) return [live, { column: 'audience', op: 'eq', value: 'public' }];
    if (actor.roles.includes('admin')) return [];
    return [live, { column: 'orgId', op: 'eq', value: actor.orgId }];
  });

describe('scoped(policy, scope)', () => {
  test('an anonymous viewer: live public posts only', () => {
    expect(policyScope(visible(), null)).toEqual([
      { column: 'deletedAt', op: 'is-null' },
      { column: 'audience', op: 'eq', value: 'public' },
    ]);
  });

  test('a member: live posts of their own org', () => {
    expect(policyScope(visible(), member())).toEqual([
      { column: 'deletedAt', op: 'is-null' },
      { column: 'orgId', op: 'eq', value: 'org-1' },
    ]);
  });

  test('an admin: every row — an empty conjunction, never "no scope"', () => {
    expect(policyScope(visible(), admin())).toEqual([]);
  });

  test('a scoped row policy still widens as an unscoped one does — a typecheck, not a run', () => {
    const nullable: Policy<unknown, Post | null> = visible();
    const untyped: Policy = visible();
    expect([nullable.label, untyped.label]).toEqual([rule().label, rule().label]);
  });

  test('a policy nobody scoped hands nothing down: the read stays the JS rule over every row', () => {
    expect(policyScope(rule(), member())).toBeUndefined();
  });

  test('what it hands down is frozen: the composer cannot be handed a list a caller still edits', () => {
    const where = policyScope(visible(), null);
    expect(Object.isFrozen(where)).toBe(true);
    expect(where?.every((condition) => Object.isFrozen(condition))).toBe(true);
  });

  test('the scope belongs to the clause it is declared on: a combinator over it carries none', () => {
    const inner = visible();
    expect(policyScope(and(inner, allow('also')), null)).toBeUndefined();
    expect(policyScope(or(inner, allow('also')), null)).toBeUndefined();
    expect(policyScope(not(inner), null)).toBeUndefined();
  });

  test('scoping changes no decision: the JS rule stays the authority', () => {
    const scopedPolicy = visible();
    const plain = rule();
    const row: Post = { id: 'p', orgId: 'org-2', audience: 'members', deletedAt: null };
    for (const actor of [null, member(), admin()]) {
      for (const candidate of [row, { ...row, orgId: 'org-1' }]) {
        expect(evaluate(scopedPolicy, { actor, input: {}, row: candidate })).toEqual(
          evaluate(plain, { actor, input: {}, row: candidate }),
        );
      }
      expect(decideBeforeInput(scopedPolicy, { actor })).toEqual(
        decideBeforeInput(plain, { actor }),
      );
    }
    expect(scopedPolicy.label).toBe(plain.label);
    expect(policyPermissions(scopedPolicy)).toEqual(policyPermissions(plain));
    expect(admitsAnonymous(scopedPolicy)).toBe(admitsAnonymous(plain));
  });
});

describe('a scope tree: or groups and via hops', () => {
  interface Feed {
    readonly authorId: string;
    readonly audience: 'public' | 'friends';
  }
  /** Mine, or public, or a friend's: one disjunction over a graph, handed down whole. */
  const feed = (): Policy<unknown, Feed> =>
    scoped(allow<unknown, Feed>('feed'), (actor): readonly ScopeNode<Feed>[] =>
      actor === null
        ? [{ column: 'audience', op: 'eq', value: 'public' }]
        : [
            {
              or: [
                { column: 'authorId', op: 'eq', value: actor.id },
                { column: 'audience', op: 'eq', value: 'public' },
                {
                  via: { column: 'authorId', entity: 'friendships', target: 'friendId' },
                  where: [{ column: 'userId', op: 'eq', value: actor.id }],
                },
              ],
            },
          ],
    );

  test('an or group is handed down as written, its hop with it', () => {
    expect(policyScope(feed(), member())).toEqual([
      {
        or: [
          { column: 'authorId', op: 'eq', value: 'm1' },
          { column: 'audience', op: 'eq', value: 'public' },
          {
            via: { column: 'authorId', entity: 'friendships', target: 'friendId' },
            where: [{ column: 'userId', op: 'eq', value: 'm1' }],
          },
        ],
      },
    ]);
  });

  test('frozen at every depth: no node of an or, a via or its where can be edited', () => {
    const [group] = policyScope(feed(), member()) ?? [];
    const members = group !== undefined && 'or' in group ? group.or : [];
    const hop = members[2];
    expect(Object.isFrozen(group)).toBe(true);
    expect(Object.isFrozen(members)).toBe(true);
    expect(members.every((node) => Object.isFrozen(node))).toBe(true);
    expect(hop !== undefined && 'via' in hop && Object.isFrozen(hop.via)).toBe(true);
    expect(hop !== undefined && 'via' in hop && Object.isFrozen(hop.where[0])).toBe(true);
  });
});
