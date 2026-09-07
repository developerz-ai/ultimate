// A handler's OWN status is the response's status, and the body it wrote is the body a browser
// gets. Pinned because the render side now has a way for a page route to answer 404 with its own
// document (`@ultimat3/render`'s `withStatus`), and that is only true if nothing between the
// handler and the socket rewrites a 4xx it did not throw: the error page is for a THROW, never
// for a status a handler chose. Measured before this pin: ai-maxxing's `/fleet/nope` answered 200
// because the only path to a 404 went through the error page, outside the app's shell.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { html } from './response';
import { createRouter, type Route } from './router';

const OWN_PAGE =
  '<!doctype html><html><body><main id="shell">No such box: nope</main></body></html>';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/fleet/:host',
    meta: { name: 'host', auth: 'public', render: 'ssr' },
    handler: () => html(OWN_PAGE, { status: 404 }),
  },
  {
    method: 'GET',
    path: '/gone',
    meta: { name: 'gone', auth: 'public', render: 'ssr' },
    handler: () => html(OWN_PAGE, { status: 410, headers: { 'cache-control': 'no-store' } }),
  },
];

const pipeline = (dev = false) =>
  createPipeline({
    table: createRouter(routes),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev, buildId: null }),
  });

const browser = (path: string) =>
  new Request(`http://localhost${path}`, {
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });

describe('a handler that answers its own status', () => {
  test('a 404 keeps the handler’s document — inside the app’s shell, never the error page', async () => {
    const response = await pipeline().handle(browser('/fleet/nope'), { role: 'web' });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body).toBe(OWN_PAGE);
    expect(body).not.toContain('X_ROUTE_NOT_FOUND');
  });

  test('a 410 passes through the same way', async () => {
    const response = await pipeline().handle(browser('/gone'), { role: 'web' });
    expect(response.status).toBe(410);
    expect(await response.text()).toBe(OWN_PAGE);
  });

  test('dev is no different: the overlay is for a throw, and nothing threw', async () => {
    const response = await pipeline(true).handle(browser('/fleet/nope'), { role: 'web' });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(OWN_PAGE);
  });

  test('a path that matches NO route is still the framework’s 404 page', async () => {
    // The two answers to "404" stay distinct: a route the table lacks is a throw, and gets the
    // error page; a route that exists and says "not found" renders itself.
    const response = await pipeline().handle(browser('/nowhere'), { role: 'web' });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('X_ROUTE_NOT_FOUND');
  });
});
