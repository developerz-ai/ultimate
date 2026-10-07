// A caller that derived an action's URL under the wrong path style is told so — by the server,
// naming the style it serves — instead of being handed a `X_ROUTE_NOT_FOUND` for a route that
// exists one rule over. Driven through `@ultimat3/http`'s real pipeline for the wire half.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FetchLike } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { rpc } from './client';
import { defineApi } from './define-api';
import { toRoute } from './http';
import { explainActionPathMiss } from './path-style-miss';
import { listActions, resetActions } from './registry';

const make = (http?: { readonly path: string }) =>
  action({
    input: t.object({ email: t.string }),
    output: t.object({ ok: t.boolean }),
    policy: allow('session:create'),
    ...(http === undefined ? {} : { http }),
    handle: () => ({ ok: true }),
  });

const signIn = make();
type Actions = { readonly signIn: typeof signIn };

beforeEach(() => resetActions());
afterEach(() => resetActions());

describe('explainActionPathMiss', () => {
  test("a 'resource' path on a 'readable' server names the action, both styles and where it lives", () => {
    defineApi({ actions: { signIn }, http: { pathStyle: 'readable' } });
    const error = explainActionPathMiss('POST', '/api/ins/sign');

    expect(error?.code).toBe('X_CONTRACT_DRIFT');
    expect(error?.cause).toBe(
      "POST /api/ins/sign is signIn under pathStyle 'resource'; this server serves pathStyle 'readable', where it is POST /api/sign-in",
    );
    expect(error?.fix).toStartWith("rpc<Api['actions']>({ baseUrl, pathStyle: 'readable' })");
  });

  test("the other direction too: a 'readable' path on a default server", () => {
    defineApi({ actions: { signIn } });
    const error = explainActionPathMiss('POST', '/api/sign-in');

    expect(error?.cause).toContain("signIn under pathStyle 'readable'");
    expect(error?.cause).toContain("serves pathStyle 'resource', where it is POST /api/ins/sign");
    expect(error?.fix).toStartWith("rpc<Api['actions']>({ baseUrl, pathStyle: 'resource' })");
  });

  test('a path no action has under any style stays a plain miss', () => {
    defineApi({ actions: { signIn }, http: { pathStyle: 'readable' } });
    expect(explainActionPathMiss('POST', '/api/outs/sign')).toBeUndefined();
    expect(explainActionPathMiss('POST', '/ins/sign')).toBeUndefined();
    expect(explainActionPathMiss('POST', '/api')).toBeUndefined();
  });

  test('a path under the SERVED style is never drift — a role that mounted no API misses plainly', () => {
    defineApi({ actions: { signIn }, http: { pathStyle: 'readable' } });
    expect(explainActionPathMiss('POST', '/api/sign-in')).toBeUndefined();
  });

  test('only a POST is an action call — a GET there was never one under either style', () => {
    defineApi({ actions: { signIn }, http: { pathStyle: 'readable' } });
    expect(explainActionPathMiss('GET', '/api/ins/sign')).toBeUndefined();
  });

  test('a pinned action is not explained: its URL is the pin under every style', () => {
    defineApi({
      actions: { stripeHook: make({ path: '/hooks/stripe' }) },
      http: { pathStyle: 'readable' },
    });
    expect(explainActionPathMiss('POST', '/api/hooks/stripe')).toBeUndefined();
  });

  test('an empty registry explains nothing', () => {
    expect(explainActionPathMiss('POST', '/api/ins/sign')).toBeUndefined();
  });
});

describe('over the wire, as `hooks.explainMiss`', () => {
  const serve = () =>
    httpServer({
      routes: listActions().map(toRoute),
      role: 'web',
      hooks: { explainMiss: explainActionPathMiss },
      config: defineHttpConfig({ dev: false, buildId: null, rateLimit: { scope: 'process' } }),
    });

  const post = (path: string): Request =>
    new Request(`http://app.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.test' }),
    });

  test('the wrong style is a 404 problem document carrying X_CONTRACT_DRIFT and the served style', async () => {
    defineApi({ actions: { signIn }, http: { pathStyle: 'readable' } });
    const response = await serve().fetch(post('/api/ins/sign'));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(body['code']).toBe('X_CONTRACT_DRIFT');
    expect(String(body['cause'])).toContain("this server serves pathStyle 'readable'");
  });

  test('the right style is served, and an unknown path is still X_ROUTE_NOT_FOUND', async () => {
    defineApi({ actions: { signIn }, http: { pathStyle: 'readable' } });
    const server = serve();
    const served = await server.fetch(post('/api/sign-in'));
    const unknown = await server.fetch(post('/api/nothing-here'));

    expect(served.status).toBe(200);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as Record<string, unknown>)['code']).toBe('X_ROUTE_NOT_FOUND');
  });

  test('a server-side `rpc` passing the wrong pathStyle rejects with the server’s own instruction', async () => {
    defineApi({ actions: { signIn }, http: { pathStyle: 'readable' } });
    const server = serve();
    const fetchStub: FetchLike = (url, init) => server.fetch(new Request(url, init));
    const client = rpc<Actions>({ baseUrl: 'http://app.test', fetch: fetchStub });

    const error: unknown = await client
      .signIn({ email: 'a@b.test' })
      .catch((thrown: unknown) => thrown);

    if (!isUltimateError(error))
      return expect.unreachable('the call resolved or threw a non-framework value');
    expect(error.code).toBe('X_CONTRACT_DRIFT');
    expect(error.fix).toStartWith("rpc<Api['actions']>({ baseUrl, pathStyle: 'readable' })");
  });
});
