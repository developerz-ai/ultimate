// The dev server's authorizer must decide from the app's own policy objects. A dev-only
// approximation here is how "it worked locally" happens, so these tests pin the lookup: the
// route table's declared permission for pages, deny otherwise — and nothing at all for an
// action, whose route says `enforcedBy: 'handler'` because `invoke` is its one evaluation.

import { afterEach, describe, expect, test } from 'bun:test';
import { action, registerAction, resetRegistry, t, toRoute } from '@ultimat3/action';
import type { AuthzDecision, RequestContext, Route, UltimateRequest } from '@ultimat3/http';
import { createRequestContext, defineHttpConfig } from '@ultimat3/http';
import {
  allow,
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { devHooks } from './dev-hooks';
import { appRoutes } from './dev-render';

const context = (path: string): RequestContext =>
  createRequestContext({
    url: new URL(`http://dev.test${path}`),
    method: 'GET',
    role: 'web',
    config: defineHttpConfig({ dev: true }),
  });

/** The hook takes a request only to pass it to app code; nothing in `authorize` reads it. */
const decide = async (route: Route, ctx: RequestContext): Promise<AuthzDecision> => {
  const authorize = devHooks().authorize;
  if (authorize === undefined) throw new Error('x dev must wire an authorizer');
  return authorize(route, undefined as unknown as UltimateRequest, ctx);
};

afterEach(() => {
  resetRegistry();
  clearRoutes();
  clearPermissions();
  clearRoles();
});

describe('unit · x dev authorizes from the app’s own policies', () => {
  test('an action route is never brought here — its handler holds the one evaluation', async () => {
    definePermissions(['post:publish'] as const);
    defineRoles({ editor: { grants: ['post:publish'] } });
    const publish = action({
      input: t.object({ id: t.uuid }),
      output: t.object({ id: t.uuid }),
      policy: can('post:publish'),
      handle: async ({ input }) => input,
    });
    registerAction('publishPost', publish);

    // The route says so, and the pipeline's authz stage reads exactly this field. A dev
    // authorizer that answered for an action would be the second authz system — one that
    // decides before `row` has loaded, and therefore denies the row's own author.
    const route = toRoute(publish.named('publishPost'));
    expect(route.meta.enforcedBy).toBe('handler');

    // Asked anyway — a wiring accident, a hand-rolled host — it refuses rather than guessing.
    const decision = await decide(route, context('/api/posts/publish'));
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ reason: expect.stringContaining('no policy is registered') });
  });

  test('a public action is allowed by its own handler, so the stage is skipped too', () => {
    const echo = action({
      input: t.object({ word: t.string }),
      output: t.object({ word: t.string }),
      policy: allow(),
      handle: async ({ input }) => input,
    });
    registerAction('echoWord', echo);

    const route = toRoute(echo.named('echoWord'));
    expect(route.meta.auth).toBe('public');
    expect(route.meta.enforcedBy).toBe('handler');
  });

  test("a page route's declared permission is evaluated, not waved through", async () => {
    definePermissions(['settings:read'] as const);
    registerRoute({
      file: 'apps/web/app/settings/page.tsx',
      suspenseBoundaries: 0,
      config: defineRoute({
        render: 'spa',
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '0kb' },
        meta: () => ({ title: 'Settings' }),
        policy: { permission: 'settings:read' },
      }),
    });
    const route = appRoutes({ buildId: 'test' })[0];
    if (route === undefined) throw new Error('the settings route did not register');

    expect((await decide(route, context('/settings'))).allowed).toBe(false);
  });

  test('a route naming a policy nothing registered is denied, never allowed by default', async () => {
    const route: Route = {
      method: 'GET',
      path: '/ghost',
      handler: () => new Response('never reached'),
      meta: { name: 'ghost', auth: 'required', policy: 'ghost:read' },
    };
    const decision = await decide(route, context('/ghost'));
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ reason: expect.stringContaining('no policy is registered') });
  });
});
