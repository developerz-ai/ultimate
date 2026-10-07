// `Set-Cookie` is the one header that is a LIST: each cookie is its own field line, and merging the
// context's headers onto the response with `set` kept the last one only — a session cookie set
// beside a preference cookie reached the browser alone, or not at all.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { httpPipeline } from './pipeline';
import { redirect, textResponse } from './response';
import { httpRouter, type Route } from './router';

const SESSION = 'session=abc; Path=/; HttpOnly';
const THEME = 'theme=dark; Path=/';
const SEEN = 'seen=1; Path=/';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/two',
    meta: { name: 'two', auth: 'public' },
    handler: (_request, ctx) => {
      ctx.headers.append('set-cookie', SESSION);
      ctx.headers.append('set-cookie', THEME);
      return textResponse('ok');
    },
  },
  {
    method: 'GET',
    path: '/both-sides',
    meta: { name: 'both-sides', auth: 'public' },
    handler: (_request, ctx) => {
      ctx.headers.append('set-cookie', SESSION);
      ctx.headers.append('set-cookie', THEME);
      const response = textResponse('ok');
      response.headers.append('set-cookie', SEEN);
      return response;
    },
  },
  {
    method: 'POST',
    path: '/sign-in',
    meta: { name: 'sign-in', auth: 'public' },
    handler: (_request, ctx) => {
      ctx.headers.append('set-cookie', SESSION);
      ctx.headers.append('set-cookie', THEME);
      return redirect('/home', 303);
    },
  },
  {
    method: 'GET',
    path: '/boom',
    meta: { name: 'boom', auth: 'public' },
    handler: (_request, ctx) => {
      ctx.headers.append('set-cookie', SESSION);
      ctx.headers.append('set-cookie', THEME);
      throw new TypeError('after the cookies were set');
    },
  },
];

const pipeline = httpPipeline({
  table: httpRouter(routes),
  config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null }),
});

const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  pipeline.handle(new Request(`http://localhost${path}`, init), { role: 'web' });

describe('every cookie set during a request is on the wire', () => {
  test('two cookies on the context are two Set-Cookie lines', async () => {
    const response = await call('/two');
    expect(response.headers.getSetCookie()).toEqual([SESSION, THEME]);
  });

  test('a cookie the handler put on its own Response survives beside them', async () => {
    const response = await call('/both-sides');
    expect([...response.headers.getSetCookie()].sort()).toEqual([SEEN, SESSION, THEME].sort());
  });

  test('a redirect keeps both, and so does its hand-over to the client router', async () => {
    const same = { 'sec-fetch-site': 'same-origin' };
    const plain = await call('/sign-in', { method: 'POST', headers: same });
    expect(plain.status).toBe(303);
    expect(plain.headers.getSetCookie()).toEqual([SESSION, THEME]);
    const routed = await call('/sign-in', {
      method: 'POST',
      headers: { ...same, 'x-ultimate-navigation': 'soft', 'x-ultimate-surface': 'web:app' },
    });
    expect(routed.status).toBe(204);
    expect(routed.headers.getSetCookie()).toEqual([SESSION, THEME]);
  });

  test('a failed request keeps them too — the recover stage answers through the same merge', async () => {
    const response = await call('/boom', { headers: { accept: 'application/json' } });
    expect(response.status).toBe(500);
    expect(response.headers.getSetCookie()).toEqual([SESSION, THEME]);
  });

  test('a single-valued header is still set once, never doubled', async () => {
    const response = await call('/two');
    expect(response.headers.get('x-request-id')?.includes(',')).toBe(false);
  });
});
