// The `/_x` mount as a browser meets it. The SQL panel ran guard-approved SQL on a public GET with
// no origin check, and `/_x/*` answered any Host — so a page the developer had open could drive
// the app's own database credentials (a cross-site GET, or a DNS-rebound name read back).

import { describe, expect, test } from 'bun:test';
import type { Route } from '@ultimat3/http';
import { defineHttpConfig, requestContext, UltimateRequest } from '@ultimat3/http';
import type { DevDashboardInput, DevStatus } from './dev-dashboard';
import { devDashboardRoutes } from './dev-dashboard';
import type { DevServices } from './runtime-bindings';
import type { RunningServices } from './runtime-services';

const SERVICES: DevServices = {
  db: { name: 'db', mode: 'embedded', url: 'pglite:///tmp/pgdata', detail: 'fixture' },
  events: { name: 'events', mode: 'embedded', url: 'inproc://events', detail: 'fixture' },
  storage: { name: 'storage', mode: 'embedded', url: 'file:///tmp/storage', detail: 'fixture' },
  stateDir: '/tmp/state',
  root: '/tmp',
};

const STATUS: DevStatus = {
  url: 'http://localhost:3000',
  services: SERVICES,
  roles: ['web'],
  findings: [],
  reloads: 0,
};

/** Every statement that reached the database, in order — the read-only wrapper included. */
const recordingDb = (sent: string[]) => ({
  query: (fragment: { text: string }): Promise<readonly unknown[]> => {
    sent.push(fragment.text);
    return Promise.resolve([{ one: 1 }]);
  },
  one: (): Promise<null> => Promise.resolve(null),
  execute: (fragment: { text: string }): Promise<number> => {
    sent.push(fragment.text);
    return Promise.resolve(0);
  },
});

const inputFor = (sent: string[]): DevDashboardInput => ({
  root: '/tmp/nonexistent-app',
  runtime: { db: recordingDb(sent), mail: { name: 'smtp' } } as unknown as RunningServices,
  status: (): DevStatus => STATUS,
  env: 'development',
});

const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const route = routes.find((entry) => entry.method === method && entry.path === path);
  if (route === undefined) return expect.unreachable(`no ${method} ${path} route is mounted`);
  return route;
};

interface Sent {
  readonly method?: string;
  readonly host?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The handler as the router calls it; a refusal comes back as the thrown error's code. */
async function call(route: Route, target: string, sent: Sent = {}): Promise<Response | string> {
  const url = new URL(`http://${sent.host ?? 'localhost:3000'}${target}`);
  const method = sent.method ?? 'GET';
  const headers = { host: url.host, ...sent.headers };
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  const ctx = requestContext({
    url,
    method,
    role: 'web',
    config,
    ip: '127.0.0.1',
    requestHeaders: headers,
  });
  const raw = new Request(url, {
    method,
    headers,
    ...(sent.body === undefined ? {} : { body: sent.body }),
  });
  try {
    return await route.handler(new UltimateRequest(raw, ctx), ctx);
  } catch (error) {
    return (error as { code?: string }).code ?? 'uncoded';
  }
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };

describe('unit · /_x answers this machine only', () => {
  test('a Host that is not loopback is X_DEV_HOST_REFUSED, on every route', async () => {
    const routes = devDashboardRoutes(inputFor([]));
    for (const route of routes) {
      const answer = await call(route, route.path, {
        method: route.method,
        host: 'rebound.evil.test:3000',
      });
      if (typeof answer === 'string') return expect.unreachable(`${route.path} threw ${answer}`);
      expect([route.method, route.path, answer.status]).toEqual([route.method, route.path, 421]);
      expect(((await answer.json()) as { error: { code: string } }).error.code).toBe(
        'X_DEV_HOST_REFUSED',
      );
    }
  });

  test('every loopback spelling is this machine', async () => {
    const route = routeFor(devDashboardRoutes(inputFor([])), 'GET', '/_x/services');
    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'app.localhost:3000']) {
      const answer = await call(route, '/_x/services?json=1', { host });
      expect([host, typeof answer === 'string' ? answer : answer.status]).toEqual([host, 200]);
    }
  });
});

describe('unit · the SQL panel runs a statement on a same-origin POST only', () => {
  test('a GET carrying ?sql= is refused, and nothing reaches the database', async () => {
    const sent: string[] = [];
    const route = routeFor(devDashboardRoutes(inputFor(sent)), 'GET', '/_x/db');
    expect(await call(route, '/_x/db?sql=select%201&json=1')).toBe('X_METHOD_NOT_ALLOWED');
    expect(sent).toEqual([]);
  });

  test('a cross-site POST is X_CSRF_BLOCKED, by Origin or by sec-fetch-site', async () => {
    const sent: string[] = [];
    const route = routeFor(devDashboardRoutes(inputFor(sent)), 'POST', '/_x/db');
    for (const evidence of [{ origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }]) {
      const answer = await call(route, '/_x/db', {
        method: 'POST',
        headers: { ...FORM, ...evidence },
        body: 'sql=select%201',
      });
      expect([evidence, answer]).toEqual([evidence, 'X_CSRF_BLOCKED']);
    }
    expect(sent).toEqual([]);
  });

  test('a same-origin POST runs it inside a read-only transaction that rolls back', async () => {
    const sent: string[] = [];
    const route = routeFor(devDashboardRoutes(inputFor(sent)), 'POST', '/_x/db');
    const answer = await call(route, '/_x/db', {
      method: 'POST',
      headers: { ...FORM, origin: 'http://localhost:3000' },
      body: 'sql=select%201%20as%20one',
    });
    if (typeof answer === 'string') return expect.unreachable(`POST /_x/db threw ${answer}`);
    expect(answer.status).toBe(200);
    const payload = (await answer.json()) as {
      ok: boolean;
      data: { sql: string; result: { columns: string[] } | null };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.sql).toBe('select 1 as one');
    expect(payload.data.result?.columns).toEqual(['one']);
    expect(sent[0]).toBe('BEGIN READ ONLY');
    expect(sent.at(-1)).toBe('ROLLBACK');
  });

  // `curl` sends neither header and is not a page a hostile site can drive — core's rule.
  test('a client with no browser evidence at all is let through, as http does for curl', async () => {
    const sent: string[] = [];
    const route = routeFor(devDashboardRoutes(inputFor(sent)), 'POST', '/_x/db');
    const answer = await call(route, '/_x/db', {
      method: 'POST',
      headers: FORM,
      body: 'sql=select%201',
    });
    expect(typeof answer === 'string' ? answer : answer.status).toBe(200);
    expect(sent).toContain('BEGIN READ ONLY');
  });
});
