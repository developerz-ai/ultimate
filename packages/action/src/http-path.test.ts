// Where an action is served: the app's `pathStyle`, a per-action `http.path` pin, and every
// projection agreeing on the answer — the route, the OpenAPI operation, the descriptor, the typed
// client and the deprecation successor.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FetchLike } from '@ultimat3/core';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { apiDeclaration } from './api-declaration';
import { rpc } from './client';
import { defineApi } from './define-api';
import { toOpenApiOperation, toPostBinding, toRoute } from './http';
import { assertPinnedPath } from './http-path';
import { derivePath } from './naming';
import { buildOpenApi } from './openapi';
import { actionHttpPath, configureActionPathStyle, getAction, resetRegistry } from './registry';

const make = (http?: { readonly path: string }) =>
  action({
    input: t.object({ email: t.string }),
    output: t.object({ ok: t.boolean }),
    policy: allow('session:create'),
    ...(http === undefined ? {} : { http }),
    handle: () => ({ ok: true }),
  });

beforeEach(() => resetRegistry());
afterEach(() => resetRegistry());

describe('pathStyle', () => {
  test("default 'resource' keeps every existing URL", () => {
    defineApi({ actions: { signIn: make() } });
    expect(derivePath('signIn').path).toBe('/api/ins/sign');
    const signIn = getAction('signIn');
    expect(signIn === undefined ? null : toRoute(signIn).path).toBe('/api/ins/sign');
  });

  test("'readable' is the kebab-cased name, on every projection", () => {
    defineApi({ actions: { signIn: make(), health: make() }, http: { pathStyle: 'readable' } });
    const signIn = getAction('signIn');
    if (signIn === undefined) return expect.unreachable('signIn registered above');
    expect(toRoute(signIn).path).toBe('/api/sign-in');
    expect(derivePath('health').path).toBe('/api/health');
    expect(signIn.describe().path).toBe('/api/sign-in');
    expect(Object.keys(buildOpenApi().paths)).toEqual(['/api/health', '/api/sign-in']);
    // The tag is the resource the POLICY names, never a noun guessed from `In`.
    expect(toOpenApiOperation(signIn).tags).toEqual(['session']);
  });

  test('re-derives what the module scan already seated under the default', () => {
    const signIn = make();
    defineApi({ actions: { signIn } });
    // `describe()` reads the seat and hands no path out by name, so the switch below is legal.
    expect(signIn.describe().path).toBe('/api/ins/sign');
    defineApi({ actions: { signIn }, http: { pathStyle: 'readable' } });
    expect(actionHttpPath('signIn').path).toBe('/api/sign-in');
  });

  // The Notificado 22.6.0 adoption: the loader evaluated `apps/admin/**` before the api index, so
  // `const SIGN_OUT_PATH = derivePath('signOut').path` captured `/api/outs/sign` and the sign-out
  // form 404'd once `defineApi` declared 'readable'. The capture is a string no re-derivation can
  // reach, so the declaration that would strand it is what refuses.
  test('a path handed out by name before the style changes is refused, naming it', () => {
    const captured = derivePath('signOut').path;
    expect(captured).toBe('/api/outs/sign');
    expect(() =>
      defineApi({ actions: { signOut: make() }, http: { pathStyle: 'readable' } }),
    ).toThrow(
      expect.objectContaining({
        code: 'X_ACTION_PATH_DERIVED_EARLY',
        meta: { style: 'readable', names: ['signOut'] },
      }),
    );
  });

  test('actionHttpPath by name is a hand-out too', () => {
    actionHttpPath('signIn');
    expect(() => configureActionPathStyle('readable')).toThrow(
      expect.objectContaining({ code: 'X_ACTION_PATH_DERIVED_EARLY' }),
    );
  });

  test('a hand-out the new style does not move is not stale, and one after it is fine', () => {
    // Pinned: the same URL under either style, so nothing captured is stranded.
    defineApi({ actions: { hook: make({ path: '/api/webhooks/hook' }) } });
    expect(derivePath('hook').path).toBe('/api/webhooks/hook');
    configureActionPathStyle('readable');
    expect(derivePath('signOut').path).toBe('/api/sign-out');
    // Declaring the SAME style again moves nothing.
    expect(() => configureActionPathStyle('readable')).not.toThrow();
  });

  test('resetRegistry forgets every hand-out', () => {
    derivePath('signOut');
    resetRegistry();
    expect(() => configureActionPathStyle('readable')).not.toThrow();
  });

  test('an unknown style is refused by code', () => {
    expect(() => configureActionPathStyle('pretty' as never)).toThrow(
      expect.objectContaining({ code: 'X_ACTION_PATH_STYLE_INVALID' }),
    );
  });

  test('a pin the new style derives for another name is refused, not shadowed', () => {
    defineApi({ actions: { publishPost: make(), hook: make({ path: '/api/publish-post' }) } });
    expect(() => configureActionPathStyle('readable')).toThrow(
      expect.objectContaining({ code: 'X_ACTION_PATH_DUPLICATE' }),
    );
  });
});

describe('http.path pins', () => {
  test('a pin wins over any style, on the route, the spec, the descriptor and derivePath', () => {
    defineApi({
      actions: { ingestSesEvent: make({ path: '/api/ses-events/ingest' }) },
      http: { pathStyle: 'readable' },
    });
    const target = getAction('ingestSesEvent');
    if (target === undefined) return expect.unreachable('registered above');
    expect(toRoute(target).path).toBe('/api/ses-events/ingest');
    expect(target.describe().path).toBe('/api/ses-events/ingest');
    expect(derivePath('ingestSesEvent').path).toBe('/api/ses-events/ingest');
    expect(Object.keys(buildOpenApi().paths)).toEqual(['/api/ses-events/ingest']);
  });

  test.each([
    ['/api/:id'],
    ['/api/Webhooks'],
    ['/api/hooks/'],
    ['api/hooks'],
    ['/_x/hooks'],
    ['/api/*rest'],
  ])('%s is refused at registration', (path) => {
    expect(() => defineApi({ actions: { hook: make({ path }) } })).toThrow(
      expect.objectContaining({ code: 'X_ACTION_HTTP_PATH_INVALID' }),
    );
  });

  test('a pin colliding with a derived path is the duplicate refusal', () => {
    expect(() =>
      defineApi({
        actions: { publishPost: make(), hook: make({ path: '/api/posts/publish' }) },
      }),
    ).toThrow(expect.objectContaining({ code: 'X_ACTION_PATH_DUPLICATE' }));
  });

  test('assertPinnedPath accepts a plain webhook path', () => {
    expect(() => assertPinnedPath('wompiWebhook', '/api/webhooks/wompi')).not.toThrow();
  });
});

describe('the typed client', () => {
  const recording = (): { urls: string[]; fetch: FetchLike } => {
    const urls: string[] = [];
    return {
      urls,
      fetch: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    };
  };

  test('rpc() derives with the restated style', async () => {
    const seen = recording();
    const client = rpc<{ signIn: ReturnType<typeof make> }>({
      baseUrl: 'http://app.test',
      fetch: seen.fetch,
      pathStyle: 'readable',
    });
    await client.signIn({ email: 'a@b.co' });
    expect(seen.urls).toEqual(['http://app.test/api/sign-in']);
  });

  test("action.client() honours the action's own pin", async () => {
    const seen = recording();
    const hook = make({ path: '/api/webhooks/wompi' }).named('wompiWebhook');
    await hook.client({ baseUrl: 'http://app.test', fetch: seen.fetch })({ email: 'a@b.co' });
    expect(seen.urls).toEqual(['http://app.test/api/webhooks/wompi']);
  });
});

describe('defineApi declaration', () => {
  test('holds http and openapi for the boot and x manifest', () => {
    defineApi({ actions: {}, openapi: { title: 'Notificado API', version: '1.0.0' } });
    expect(apiDeclaration().openapi?.title).toBe('Notificado API');
  });

  test.each([[{ title: ' ' }], [{ servers: [{ url: 'www.example.com' }] }]])(
    'refuses an openapi block that cannot make a document: %j',
    (openapi) => {
      expect(() => defineApi({ actions: {}, openapi })).toThrow(
        expect.objectContaining({ code: 'X_OPENAPI_CONFIG_INVALID' }),
      );
    },
  );

  test('refuses a mount document that is not a distinct .json file', () => {
    const mount = { prefix: '/v1', scopes: {}, resolveToken: () => null };
    expect(() =>
      defineApi({ actions: {}, http: { mounts: [{ ...mount, openapi: 'openapi.json' }] } }),
    ).toThrow(expect.objectContaining({ code: 'X_OPENAPI_CONFIG_INVALID' }));
    expect(() =>
      defineApi({ actions: {}, http: { mounts: [{ ...mount, openapi: '../v1.json' }] } }),
    ).toThrow(expect.objectContaining({ code: 'X_OPENAPI_CONFIG_INVALID' }));
  });
});

describe('toPostBinding — a page URL bound to an action', () => {
  const seen: unknown[] = [];
  const unsubscribe = action({
    input: t.object({ t: t.string, 'List-Unsubscribe': t.string.optional() }),
    output: t.object({ ok: t.boolean }),
    policy: allow('mail:unsubscribe'),
    handle: ({ input }) => {
      seen.push(input);
      return { ok: true };
    },
  }).named('unsubscribeOnboarding');

  const server = () =>
    createServer({
      routes: [toPostBinding(unsubscribe, '/correos/baja')],
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    });

  test('an RFC 8058 one-click POST merges the URL query into the form body, anonymously', async () => {
    seen.length = 0;
    const response = await server().fetch(
      new Request('http://app.test/correos/baja?t=tok123', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      }),
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ t: 'tok123', 'List-Unsubscribe': 'One-Click' }]);
  });

  test('the query wins a name the body also carries — it is the URL the server minted', async () => {
    seen.length = 0;
    await server().fetch(
      new Request('http://app.test/correos/baja?t=minted', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 't=forged',
      }),
    );
    expect(seen).toEqual([{ t: 'minted' }]);
  });

  test('the policy is still the action’s own', () => {
    const guarded = action({
      input: t.object({}),
      output: t.object({}),
      policy: can('mail:admin'),
      handle: () => ({}),
    }).named('guarded');
    expect(toPostBinding(guarded, '/x').meta.auth).toBe('required');
  });
});
