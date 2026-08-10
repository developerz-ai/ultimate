// The route projection, proven over the real pipeline rather than by calling `route.handler`:
// an action route has ONE authz evaluation, it happens inside `invoke`, and it happens after
// `row` has loaded.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { userActor } from '@ultimat3/core';
import { createServer } from '@ultimat3/http';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { toRoute } from './http';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

type Parsed = { readonly postId: string };
type Draft = { readonly authorId: string };

/**
 * One action per test, so the evaluation counter is its own. The predicate fails closed on
 * `null` — "no loader" and "no such row" are one value, and neither is evidence of permission —
 * which is exactly why an evaluation without the row denies the author.
 */
function publisher(authorId: string, evaluations: { count: number }) {
  return action({
    input: Input,
    output: Output,
    policy: can<Parsed, Draft>('post:publish', ({ actor, row }) => {
      evaluations.count += 1;
      return row !== null && row.authorId === actor?.id;
    }),
    row: () => ({ authorId }),
    handle: ({ input }) => ({ id: input.postId, published: true }),
  }).named('publishPost');
}

const editor = (id: string): Actor => ({ ...userActor({ id }), permissions: ['post:publish'] });

function serve(target: ReturnType<typeof publisher>, actor: Actor | null) {
  return createServer({
    routes: [toRoute(target)],
    // No `authorize` hook. An action route must not need one: wiring a second opinion is how a
    // host grows a second authz system, and the pipeline used to 403 any route that declared a
    // policy without one.
    hooks: { authenticate: () => actor },
  });
}

const publish = (server: ReturnType<typeof serve>): Promise<Response> =>
  server.fetch(
    new Request('http://dev.test/api/posts/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId: POST_ID }),
    }),
  );

describe('an action route over the pipeline', () => {
  test('declares that its handler holds the one evaluation', () => {
    const evaluations = { count: 0 };
    const route = toRoute(publisher('u1', evaluations));

    // The policy is still named — dropping it would read as "this action is unguarded".
    expect(route.meta.policy).toBe('post:publish');
    expect(route.meta.enforcedBy).toBe('handler');
    expect(evaluations.count).toBe(0);
  });

  test("the row's own author is allowed, and the policy runs exactly once", async () => {
    const evaluations = { count: 0 };
    const response = await publish(serve(publisher('u1', evaluations), editor('u1')));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: POST_ID, published: true });
    // Twice would mean the pipeline decided too, and it decides from `row: null` — a denial for
    // the row's own author, issued by an authz system that never saw the row. That is the bug
    // these tests exist to keep fixed.
    expect(evaluations.count).toBe(1);
  });

  test('a stranger is denied by that same evaluation, with the policy’s own code', async () => {
    const evaluations = { count: 0 };
    const response = await publish(serve(publisher('u1', evaluations), editor('u2')));
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(403);
    expect(body.code).toBe('X_FORBIDDEN');
    expect(evaluations.count).toBe(1);
  });

  test('an anonymous caller is refused before the policy is ever reached', async () => {
    const evaluations = { count: 0 };
    const response = await publish(serve(publisher('u1', evaluations), null));

    // The `auth` stage answers this one: `meta.auth` is 'required' for any non-`allow` policy.
    // Authentication, not authorization — which is why the count stays at zero.
    expect(response.status).toBe(401);
    expect(evaluations.count).toBe(0);
  });
});
