// The dev server's authorizer must decide from the app's own policy objects. A dev-only
// approximation here is how "it worked locally" happens, so these tests pin the lookup: the
// route table's declared permission for pages, deny otherwise — and nothing at all for an
// action, whose route says `enforcedBy: 'handler'` because `invoke` is its one evaluation.

import { afterEach, describe, expect, test } from 'bun:test';
import { action, registerAction, resetRegistry, t, toRoute } from '@ultimat3/action';
import { userActor } from '@ultimat3/core';
import type { AuthzDecision, RequestContext, Route, UltimateRequest } from '@ultimat3/http';
import {
  configureAuthenticator,
  createRequestContext,
  defineHttpConfig,
  resetAuthenticator,
} from '@ultimat3/http';
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
import { CliNotImplementedError } from './errors';

const context = (path: string): RequestContext =>
  createRequestContext({
    url: new URL(`http://dev.test${path}`),
    method: 'GET',
    role: 'web',
    config: defineHttpConfig({ dev: true, rateLimit: { scope: 'process' } }),
  });

/** The hook takes a request only to pass it to app code; nothing in `authorize` reads it. */
const decide = async (route: Route, ctx: RequestContext): Promise<AuthzDecision> => {
  const authorize = devHooks().authorize;
  // Never a bare Error, tests included: a throw without a code and a fix is not an instruction.
  if (authorize === undefined) {
    throw new CliNotImplementedError({
      feature: 'an authorize hook on devHooks()',
      fix: 'return authorize from devHooks() in packages/cli/src/dev-hooks.ts',
    });
  }
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
    if (route === undefined) {
      throw new CliNotImplementedError({
        feature: 'a route table for the registered settings page',
        fix: 'x routes --json   # every route registerRoute() holds',
      });
    }

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

// The other seam. `devHooks()` returned `authorize` alone, so the one place an actor can come
// from had no caller — `x dev` and `apps/web/server.ts` both boot through `startWeb`, which
// passes this object verbatim.
describe('unit · x dev fills both seams, not one', () => {
  afterEach(resetAuthenticator);

  test('no authenticator declared: the key is absent, never a stub that answers nobody', () => {
    expect('authenticate' in devHooks()).toBe(false);
  });

  test('the app’s declared resolver is what the server is handed, by identity', () => {
    const authenticate = () => userActor({ id: 'u-1' });
    configureAuthenticator(authenticate);
    expect(devHooks().authenticate).toBe(authenticate);
  });

  // Read at server start, not at module load: a watch-mode restart re-reads the app's modules,
  // and a captured `undefined` would outlive the app that later declared one.
  test('it is read per call, so a declaration made after import is still picked up', () => {
    expect(devHooks().authenticate).toBeUndefined();
    configureAuthenticator(() => null);
    expect(devHooks().authenticate).toBeDefined();
  });
});

// The third seam, and the one that is not a decision: a dev diagnostic's findings, rendered by the
// overlay next to the error. `serve.ts` boots through the same `startWeb` and passes nothing, so
// the absent key is what keeps a production process from paying for a diagnostic it never installed.
describe('unit · the dev-notice seam is passed in, never reached for', () => {
  test('nothing supplied: the key is absent, not a function answering an empty list', () => {
    expect('devNotices' in devHooks()).toBe(false);
  });

  test('what x dev supplies is what the server is handed, by identity', () => {
    const devNotices = (): readonly [] => [];
    expect(devHooks({ devNotices }).devNotices).toBe(devNotices);
  });

  test('supplying it does not disturb the other two seams', () => {
    configureAuthenticator(() => null);
    const hooks = devHooks({ devNotices: () => [] });
    expect(hooks.authenticate).toBeDefined();
    expect(hooks.authorize).toBeDefined();
    resetAuthenticator();
  });
});
