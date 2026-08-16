// The one policy declaration set both `x policy` test files run against. Shared rather than
// copied, for the reason `thrown-by.ts` gives: every count in both files' assertions is read off
// THIS set, so a second copy drifts and each file keeps passing while they stop agreeing.

import { action, registerActions, t } from '@ultimat3/action';
import { and, can, definePermissions, defineRoles } from '@ultimat3/policy';
import { from, query, registerQuery } from '@ultimat3/query';

/**
 * The row the fixture's two reads return, over an empty source: `x policy` describes a query and
 * evaluates its policy, it never executes one, so the rows are the one fact that may be missing.
 */
interface PostRow {
  readonly id: string;
}

/**
 * Four permissions, three roles, two actions and two queries — each fact earning its place.
 *
 * `archivePost` is guarded by a COMPOSITE, and that is the point of it: its display capability is
 * the label `and(post:publish, post:read)`, which is not any permission, so a report that matched
 * on the label counted this action as enforcing nothing and printed both of its permissions as
 * dead grants. It enforces two, and the facts say so.
 *
 * `post:delete` is the control: declared, granted to `admin`, enforced by nothing at all. It is
 * what a genuinely dead grant looks like, and it is what keeps `unenforced` a claim worth making
 * now that a composite no longer lands in it by accident.
 *
 * `post:publish` is enforced by two actions AND a query, so the aggregation across declarations
 * has something to aggregate.
 *
 * Registers only; the registries are process-global, so the caller clears them first.
 */
export function registerPolicyFixture(): void {
  definePermissions(['post:publish', 'post:read', 'post:delete', 'feed:read'] as const);
  defineRoles({
    admin: { grants: ['post:publish', 'post:read', 'post:delete', 'feed:read'] },
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
      sql: () => from<PostRow>('posts', []).orderBy('id').limit(10),
    }),
  );
  registerQuery(
    'publishedPosts',
    query({
      input: t.object({}),
      policy: can('post:publish'),
      sql: () => from<PostRow>('posts', []).orderBy('id').limit(10),
    }),
  );
}
