// `x policy`'s pure facts, against real permissions, roles, actions and queries — the same
// registries `x actions|queries` read. A fixture that only pretended to declare a permission
// would prove nothing about whether `explainPolicy` reads the app's own policy objects.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, registerActions, resetRegistry as resetActions, t } from '@ultimat3/action';
import type { Policy } from '@ultimat3/policy';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { resetRegistry as resetQueries } from '@ultimat3/query';
import { explainPolicy, knownPolicySubjects, listPolicy } from './policy-facts';
import { registerPolicyFixture } from './policy-fixture';

/** What a policy that reads request input decides on — nothing the CLI can supply. */
interface PostInput {
  readonly postId: string;
  readonly post: { readonly id: string };
}

/**
 * Reset BEFORE registering the fixture, not only after. The declaration registries are
 * process-global and `bun test` runs every file in one process, so whatever ran first — the
 * reference app registers its own `publishPost` — is still seated when the first
 * `registerPolicyFixture()` lands and the name collides with `X_ACTION_DUPLICATE`. Clearing first
 * is what makes this file order-independent instead of passing alone and failing in the suite.
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
    registerPolicyFixture();
    expect(listPolicy().rows).toEqual([
      { permission: 'feed:read', roles: ['admin', 'reader'], actions: [], queries: ['postFeed'] },
      // Declared, granted, enforced by nothing: what a dead grant actually looks like.
      { permission: 'post:delete', roles: ['admin'], actions: [], queries: [] },
      {
        permission: 'post:publish',
        roles: ['admin', 'editor'],
        // `archivePost` is guarded by `and(post:publish, post:read)`. Matching on the display
        // label reported it as enforcing NEITHER, so both of its permissions read as dead.
        actions: ['archivePost', 'publishPost'],
        queries: ['publishedPosts'],
      },
      {
        permission: 'post:read',
        roles: ['admin', 'editor', 'reader'],
        actions: ['archivePost'],
        queries: [],
      },
    ]);
  });

  test('counts roles, and permissions at least one declaration enforces', () => {
    registerPolicyFixture();
    const facts = listPolicy();
    expect(facts.roleCount).toBe(3);
    // Three of four: the composite's two count, and only the grant nothing references does not.
    expect(facts.enforcedCount).toBe(3);
    expect(facts.unenforced).toEqual(['post:delete']);
  });

  test('an app with nothing declared answers empty facts, not a throw', () => {
    expect(listPolicy()).toEqual({ rows: [], roleCount: 0, enforcedCount: 0, unenforced: [] });
  });
});

describe('unit · x policy · explainPolicy', () => {
  test('a permission resolves to its granting roles and every enforcing declaration', () => {
    registerPolicyFixture();
    const explanation = explainPolicy('post:publish');
    expect(explanation?.kind).toBe('permission');
    expect(explanation?.grantingRoles).toEqual(['admin', 'editor']);
    expect(explanation?.declarations.map((d) => [d.name, d.kind])).toEqual([
      // The composite is here because it references the permission, not because its label is one.
      ['archivePost', 'action'],
      ['publishPost', 'action'],
      ['publishedPosts', 'query'],
    ]);
  });

  test('every declaration matrix carries one row per role plus anonymous, in that order', () => {
    registerPolicyFixture();
    // `declarations[1]` is `publishPost`, the simple `can()` one: `archivePost` now sorts ahead
    // of it, because a composite is a real enforcer of this permission.
    const rows = explainPolicy('post:publish')?.declarations[1]?.rows ?? [];
    expect(rows.map((r) => r.actor)).toEqual(['anonymous', 'admin', 'editor', 'reader']);
    expect(rows.map((r) => r.allowed)).toEqual([false, true, true, false]);
  });

  test('the deciding clause and reason for a simple can() policy name the permission itself', () => {
    registerPolicyFixture();
    const rows = explainPolicy('post:publish')?.declarations[1]?.rows ?? [];
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
    registerPolicyFixture();
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
    registerPolicyFixture();
    expect(explainPolicy('publishPost')?.kind).toBe('action');
    expect(explainPolicy('postFeed')?.kind).toBe('query');
    const byPath = explainPolicy('/api/posts/publish');
    expect(byPath?.kind).toBe('action');
    expect(byPath?.subject).toBe('/api/posts/publish');
    expect(byPath?.declarations[0]?.name).toBe('publishPost');
  });

  test('grantingRoles for a single declaration is the union over its permissions, not its label', () => {
    registerPolicyFixture();
    expect(explainPolicy('postFeed')?.grantingRoles).toEqual(['admin', 'reader']);
    // `rolesGranting('and(post:publish, post:read)')` is a lookup that can only ever answer
    // nothing, so a composite-guarded action reported NO granting roles — which reads as "nobody
    // can do this" about an action every role in the app can at least attempt. The union over
    // `post:publish` and `post:read` is who can reach it, deduped and sorted.
    expect(explainPolicy('archivePost')?.grantingRoles).toEqual(['admin', 'editor', 'reader']);
  });

  test('an unknown subject resolves to undefined, not a throw', () => {
    registerPolicyFixture();
    expect(explainPolicy('does-not-exist')).toBeUndefined();
  });
});

describe('unit · x policy · explainPolicy · policies that read request input', () => {
  /** One granting role and the anonymous caller — the smallest matrix that runs a predicate. */
  function seedPermission(): void {
    definePermissions(['post:publish'] as const);
    defineRoles({ admin: { grants: ['post:publish'] } });
  }

  function registerPublishPost(policy: Policy<PostInput>): void {
    registerActions({
      publishPost: action({
        input: t.object({}),
        output: t.object({}),
        policy,
        async handle() {
          return {};
        },
      }),
    });
  }

  test('a predicate that READS input still decides — every actor, marked decidable', () => {
    seedPermission();
    registerPublishPost(can<PostInput>('post:publish', ({ input }) => input.postId === 'post_1'));

    const declaration = explainPolicy('publishPost')?.declarations[0];
    expect(declaration?.decidable).toBe(true);
    expect(declaration?.rows.map((r) => r.actor)).toEqual(['anonymous', 'admin']);
    // admin holds the grant and is denied anyway, because `undefined !== 'post_1'` outside a
    // request. That false deny is the whole reason the rendered table carries `cli.policy.noInput`.
    expect(declaration?.rows.find((r) => r.actor === 'admin')).toMatchObject({
      allowed: false,
      deciding: 'post:publish',
      reason: 'post:publish predicate returned false',
    });
  });

  test('a predicate that DEREFERENCES nested input is undecidable — no rows, and no throw', () => {
    seedPermission();
    registerPublishPost(can<PostInput>('post:publish', ({ input }) => input.post.id === 'post_1'));

    // `input.post` is undefined with no request, so the predicate throws a bare `TypeError`
    // through `policyMatrix` — which used to escape `x policy explain` and kill the command.
    expect(() => explainPolicy('publishPost')).not.toThrow();
    const declaration = explainPolicy('publishPost')?.declarations[0];
    expect(declaration?.decidable).toBe(false);
    // Not even the anonymous row that was decided before the throwing actor: a partial matrix
    // reads as a verdict on the actors it omits.
    expect(declaration?.rows).toEqual([]);
    expect(declaration?.label).toBe('post:publish');
  });
});

describe('unit · x policy · knownPolicySubjects', () => {
  test('permissions, then action names, query names, and action paths — in that order', () => {
    registerPolicyFixture();
    expect(knownPolicySubjects()).toEqual([
      'feed:read',
      'post:delete',
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
