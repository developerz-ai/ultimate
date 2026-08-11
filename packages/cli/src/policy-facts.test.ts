// `x policy`'s pure facts, against real permissions, roles, actions and queries — the same
// registries `x actions|queries` read. A fixture that only pretended to declare a permission
// would prove nothing about whether `explainPolicy` reads the app's own policy objects.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, registerActions, resetRegistry as resetActions, t } from '@ultimat3/action';
import {
  and,
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueries } from '@ultimat3/query';
import { explainPolicy, knownPolicySubjects, listPolicy } from './policy-facts';

/**
 * `post:read` is declared but enforced by nothing: `archivePost`'s policy grants that permission
 * to its second clause, but the compound policy's own capability is `and(post:publish, post:read)`
 * — a different string — so `post:read` alone stays unenforced. `post:publish` is enforced by an
 * action AND a query at once, so the aggregation across declarations has something to aggregate.
 */
function seed(): void {
  definePermissions(['post:publish', 'post:read', 'feed:read'] as const);
  defineRoles({
    admin: { grants: ['post:publish', 'post:read', 'feed:read'] },
    editor: { grants: ['post:publish', 'post:read'] },
    reader: { grants: ['post:read', 'feed:read'] },
  });
  registerActions({
    publishPost: action({
      input: t.object({}),
      output: t.object({}),
      policy: can('post:publish'),
      async handle() {
        return {};
      },
    }),
    archivePost: action({
      input: t.object({}),
      output: t.object({}),
      policy: and(
        can('post:publish'),
        can('post:read', ({ actor }) => actor?.id === 'admin'),
      ),
      async handle() {
        return {};
      },
    }),
  });
  registerQuery(
    'postFeed',
    query({
      input: t.object({}),
      policy: can('feed:read'),
      sql: () => from('posts').select({ id: 'id' }).limit(10),
    }),
  );
  registerQuery(
    'publishedPosts',
    query({
      input: t.object({}),
      policy: can('post:publish'),
      sql: () => from('posts').select({ id: 'id' }).limit(10),
    }),
  );
}

/**
 * Reset BEFORE seeding, not only after. The declaration registries are process-global and
 * `bun test` runs every file in one process, so whatever ran first — the reference app registers
 * its own `publishPost` — is still seated when this file's first `seed()` lands and the name
 * collides with `X_ACTION_DUPLICATE`. Clearing first is what makes this file order-independent
 * instead of passing alone and failing in the full suite.
 */
beforeEach(() => {
  resetActions();
  resetQueries();
  clearRoles();
  clearPermissions();
});

afterEach(() => {
  resetActions();
  resetQueries();
  clearRoles();
  clearPermissions();
});

describe('unit · x policy · listPolicy', () => {
  test('one row per declared permission — granting roles, and every action/query that enforces it', () => {
    seed();
    expect(listPolicy().rows).toEqual([
      { permission: 'feed:read', roles: ['admin', 'reader'], actions: [], queries: ['postFeed'] },
      {
        permission: 'post:publish',
        roles: ['admin', 'editor'],
        actions: ['publishPost'],
        queries: ['publishedPosts'],
      },
      { permission: 'post:read', roles: ['admin', 'editor', 'reader'], actions: [], queries: [] },
    ]);
  });

  test('counts roles, and permissions at least one declaration enforces', () => {
    seed();
    const facts = listPolicy();
    expect(facts.roleCount).toBe(3);
    expect(facts.enforcedCount).toBe(2);
    expect(facts.unenforced).toEqual(['post:read']);
  });

  test('an app with nothing declared answers empty facts, not a throw', () => {
    expect(listPolicy()).toEqual({ rows: [], roleCount: 0, enforcedCount: 0, unenforced: [] });
  });
});

describe('unit · x policy · explainPolicy', () => {
  test('a permission resolves to its granting roles and every enforcing declaration', () => {
    seed();
    const explanation = explainPolicy('post:publish');
    expect(explanation?.kind).toBe('permission');
    expect(explanation?.grantingRoles).toEqual(['admin', 'editor']);
    expect(explanation?.declarations.map((d) => [d.name, d.kind])).toEqual([
      ['publishPost', 'action'],
      ['publishedPosts', 'query'],
    ]);
  });

  test('every declaration matrix carries one row per role plus anonymous, in that order', () => {
    seed();
    const rows = explainPolicy('post:publish')?.declarations[0]?.rows ?? [];
    expect(rows.map((r) => r.actor)).toEqual(['anonymous', 'admin', 'editor', 'reader']);
    expect(rows.map((r) => r.allowed)).toEqual([false, true, true, false]);
  });

  test('the deciding clause and reason for a simple can() policy name the permission itself', () => {
    seed();
    const rows = explainPolicy('post:publish')?.declarations[0]?.rows ?? [];
    expect(rows.find((r) => r.actor === 'anonymous')).toMatchObject({
      deciding: 'post:publish',
      reason: 'no actor for post:publish',
    });
    expect(rows.find((r) => r.actor === 'reader')).toMatchObject({
      deciding: 'post:publish',
      reason: 'actor lacks post:publish',
    });
  });

  test('a compound and() policy surfaces the SPECIFIC clause that decided, not the wrapper', () => {
    seed();
    const explanation = explainPolicy('archivePost');
    expect(explanation?.kind).toBe('action');
    expect(explanation?.declarations).toHaveLength(1);
    const declaration = explanation?.declarations[0];
    expect(declaration?.label).toBe('and(post:publish, post:read)');
    const rows = declaration?.rows ?? [];
    // reader lacks post:publish outright — the FIRST clause decides.
    expect(rows.find((r) => r.actor === 'reader')).toMatchObject({
      allowed: false,
      deciding: 'post:publish',
      reason: 'actor lacks post:publish',
    });
    // editor has post:publish and post:read, but fails the second clause's own predicate.
    expect(rows.find((r) => r.actor === 'editor')).toMatchObject({
      allowed: false,
      deciding: 'post:read',
      reason: 'post:read predicate returned false',
    });
    // admin passes both clauses outright.
    expect(rows.find((r) => r.actor === 'admin')).toMatchObject({
      allowed: true,
      deciding: 'post:publish',
    });
  });

  test('resolves by action name, query name, and action path alike', () => {
    seed();
    expect(explainPolicy('publishPost')?.kind).toBe('action');
    expect(explainPolicy('postFeed')?.kind).toBe('query');
    const byPath = explainPolicy('/api/posts/publish');
    expect(byPath?.kind).toBe('action');
    expect(byPath?.subject).toBe('/api/posts/publish');
    expect(byPath?.declarations[0]?.name).toBe('publishPost');
  });

  test('grantingRoles for a single declaration comes from its own capability, not the subject text', () => {
    seed();
    expect(explainPolicy('postFeed')?.grantingRoles).toEqual(['admin', 'reader']);
    // no role grants the literal compound label "and(post:publish, post:read)"
    expect(explainPolicy('archivePost')?.grantingRoles).toEqual([]);
  });

  test('an unknown subject resolves to undefined, not a throw', () => {
    seed();
    expect(explainPolicy('does-not-exist')).toBeUndefined();
  });
});

describe('unit · x policy · knownPolicySubjects', () => {
  test('permissions, then action names, query names, and action paths — in that order', () => {
    seed();
    expect(knownPolicySubjects()).toEqual([
      'feed:read',
      'post:publish',
      'post:read',
      'archivePost',
      'publishPost',
      'postFeed',
      'publishedPosts',
      '/api/posts/archive',
      '/api/posts/publish',
    ]);
  });

  test('an app with nothing registered answers no known subjects', () => {
    expect(knownPolicySubjects()).toEqual([]);
  });
});
