// The dev server's authorizer must decide from the app's own policy objects. A dev-only
// approximation here is how "it worked locally" happens, so these tests pin the lookup: the
// action registry for actions, the route table's declared permission for pages, deny otherwise.

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
  test('a public action is allowed — the pipeline no longer denies for want of an authorizer', async () => {
    const echo = action({
      input: t.object({ word: t.string }),
      output: t.object({ word: t.string }),
      policy: allow(),
      handle: async ({ input }) => input,
    });
    registerAction('echoWord', echo);

    expect(await decide(toRoute(echo.named('echoWord')), context('/api/words/echo'))).toEqual({
      allowed: true,
    });
  });

  test('a gated action is denied for an actor without the permission, with policy’s own reason', async () => {
    definePermissions(['post:publish'] as const);
    const publish = action({
      input: t.object({ id: t.uuid }),
      output: t.object({ id: t.uuid }),
      policy: can('post:publish'),
      handle: async ({ input }) => input,
    });
    registerAction('publishPost', publish);

    const decision = await decide(
      toRoute(publish.named('publishPost')),
      context('/api/posts/publish'),
    );
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ code: 'X_UNAUTHENTICATED' });
  });

  test('an actor holding the permission is allowed', async () => {
    definePermissions(['post:publish'] as const);
    defineRoles({ editor: { grants: ['post:publish'] } });
    const publish = action({
      input: t.object({ id: t.uuid }),
      output: t.object({ id: t.uuid }),
      policy: can('post:publish'),
      handle: async ({ input }) => input,
    });
    registerAction('publishPost', publish);

    const ctx = context('/api/posts/publish');
    ctx.actor = { kind: 'user', id: 'u1', roles: ['editor'], scopes: [] };
    expect(await decide(toRoute(publish.named('publishPost')), ctx)).toEqual({ allowed: true });
  });

  test("a page route's declared permission is evaluated, not waved through", async () => {
    definePermissions(['settings:read'] as const);
    registerRoute({
      file: 'apps/web/app/settings.tsx',
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
