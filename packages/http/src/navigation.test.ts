// The server half of client navigation. What is pinned: a router request a route may not answer
// runs NOTHING of the route (not its auth hook, not its handler), and a redirect answered to a
// router request is handed over as `204` + `x-ultimate-location` — the handler ran once, and
// nothing will ask it again. Failure cases first: they are the evidence GETs this exists for.

import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { navigationGate, redirectForRouter } from './navigation';
import { redirect } from './response';
import type { Route, RouteNavigation } from './router';
import { createServer } from './server';

const APP = 'web:app';
const soft = { 'x-ultimate-navigation': 'soft', 'x-ultimate-surface': APP };
const prefetch = { 'x-ultimate-navigation': 'prefetch', 'x-ultimate-surface': APP };
const at = (headers: Record<string, string> = {}, method = 'GET'): Request =>
  new Request('https://app.test/r/tok/d/1', { method, headers });
const URL_AT = new URL('https://app.test/r/tok/d/1');
const page = (patch: Partial<RouteNavigation> = {}): RouteNavigation => ({
  surface: APP,
  prefetch: false,
  ...patch,
});

describe('navigationGate — what a router request may not reach', () => {
  test('a prefetch of a route that did not opt in is an empty 204, never a redirect', () => {
    for (const nav of [undefined, page(), page({ surface: 'web:site' })]) {
      const answer = navigationGate(at(prefetch), 'GET', URL_AT, nav);
      expect(answer?.status).toBe(204);
      expect(answer?.headers.get('x-ultimate-location')).toBeNull();
      expect(answer?.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('a soft visit to anything but a page of this surface is handed to the browser', () => {
    for (const nav of [undefined, page({ surface: 'admin:app' }), page({ surface: 'web:site' })]) {
      const answer = navigationGate(at(soft), 'GET', URL_AT, nav);
      expect(answer?.status).toBe(204);
      expect(answer?.headers.get('x-ultimate-location')).toBe(URL_AT.href);
    }
  });

  test('a router request that names no surface reaches no page', () => {
    const answer = navigationGate(at({ 'x-ultimate-navigation': 'soft' }), 'GET', URL_AT, page());
    expect(answer?.status).toBe(204);
  });

  test('passes: every non-router request, every POST, a soft visit, an opted-in prefetch', () => {
    expect(navigationGate(at(), 'GET', URL_AT, undefined)).toBeUndefined();
    expect(navigationGate(at(soft, 'POST'), 'POST', URL_AT, undefined)).toBeUndefined();
    expect(navigationGate(at(soft), 'GET', URL_AT, page())).toBeUndefined();
    expect(navigationGate(at(prefetch), 'GET', URL_AT, page({ prefetch: true }))).toBeUndefined();
  });
});

describe('redirectForRouter', () => {
  test('a redirect to a router request becomes 204 + an absolute location, cookies kept', () => {
    const answered = redirect('/done?x=1', 303);
    answered.headers.append('set-cookie', 'a=1; Path=/');
    answered.headers.append('set-cookie', 'b=2; Path=/');
    const out = redirectForRouter(at(soft, 'POST'), answered, URL_AT);
    expect(out?.status).toBe(204);
    expect(out?.headers.get('x-ultimate-location')).toBe('https://app.test/done?x=1');
    expect(out?.headers.get('location')).toBeNull();
    expect(out?.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  test('another origin is handed over as is — the router lets the browser go there', () => {
    const out = redirectForRouter(at(soft), redirect('https://pay.test/checkout', 302), URL_AT);
    expect(out?.headers.get('x-ultimate-location')).toBe('https://pay.test/checkout');
  });

  test('left alone: a request the router did not make, and every non-redirect', () => {
    expect(redirectForRouter(at(), redirect('/x', 303), URL_AT)).toBeUndefined();
    expect(redirectForRouter(at(soft), new Response('ok'), URL_AT)).toBeUndefined();
  });
});

describe('through the pipeline', () => {
  const ran: string[] = [];
  const route = (path: string, navigation?: RouteNavigation): Route => ({
    method: 'GET',
    path,
    meta: { name: path, auth: 'public', ...(navigation === undefined ? {} : { navigation }) },
    handler: () => {
      ran.push(path);
      return path === '/go' ? redirect('/landing', 302) : new Response('<p>page</p>');
    },
  });
  const authenticated: string[] = [];
  const server = createServer({
    routes: [
      route('/evidence'),
      route('/page', page()),
      route('/eager', page({ prefetch: true })),
      route('/go', page()),
    ],
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: 'b', rateLimit: { scope: 'process' } }),
    hooks: {
      authenticate: (request) => {
        authenticated.push(request.pathname);
        return null;
      },
    },
  });
  const hit = (path: string, headers: Record<string, string> = {}) =>
    server.fetch(new Request(`http://app.test${path}`, { headers }));

  test('a prefetch of an evidence GET runs neither the auth hook nor the handler', async () => {
    ran.length = 0;
    authenticated.length = 0;
    expect((await hit('/evidence', prefetch)).status).toBe(204);
    expect((await hit('/page', prefetch)).status).toBe(204);
    expect(ran).toEqual([]);
    expect(authenticated).toEqual([]);
  });

  test('a soft visit to it runs nothing and names itself; the real load then runs it once', async () => {
    ran.length = 0;
    const answer = await hit('/evidence', soft);
    expect(answer.status).toBe(204);
    expect(answer.headers.get('x-ultimate-location')).toBe('http://app.test/evidence');
    expect(ran).toEqual([]);
    expect((await hit('/evidence')).status).toBe(200);
    expect(ran).toEqual(['/evidence']);
  });

  test('pages: swapped softly, prefetched only when they opted in', async () => {
    ran.length = 0;
    expect((await hit('/page', soft)).status).toBe(200);
    expect((await hit('/eager', prefetch)).status).toBe(200);
    expect(ran).toEqual(['/page', '/eager']);
  });

  test('a redirect answered to the router is handed over after ONE execution', async () => {
    ran.length = 0;
    const answer = await hit('/go', soft);
    expect(answer.status).toBe(204);
    expect(answer.headers.get('x-ultimate-location')).toBe('http://app.test/landing');
    expect(ran).toEqual(['/go']);
    // A browser's own request is untouched.
    expect((await hit('/go')).status).toBe(302);
  });
});
