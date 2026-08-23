// What a BROWSER gets from a production process when a request fails, which was the problem
// document — rendered as raw JSON in the viewport, cause and fix included — on every deployed
// Ultimate app until 10.x. The overlay stays the dev answer; these pin which is which.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { text } from './response';
import { createRouter, type Route } from './router';

const SECRET = 'connect ECONNREFUSED 10.0.0.7:5432 as postgres/hunter2';

const routes: readonly Route[] = [
  { method: 'GET', path: '/ok', meta: { name: 'ok', auth: 'public' }, handler: () => text('ok') },
  {
    method: 'GET',
    path: '/boom',
    meta: { name: 'boom', auth: 'public' },
    handler: () => {
      throw new TypeError(SECRET);
    },
  },
];

const pipelineWith = (
  options: { dev?: boolean; errorPage?: (status: number) => string | undefined } = {},
) =>
  createPipeline({
    table: createRouter(routes),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: options.dev ?? false,
      buildId: null,
    }),
    ...(options.errorPage === undefined ? {} : { hooks: { errorPage: options.errorPage } }),
  });

const browser = (path: string) =>
  new Request(`http://localhost${path}`, {
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
const agent = (path: string) =>
  new Request(`http://localhost${path}`, { headers: { accept: 'application/json' } });

describe('a browser, in production', () => {
  test('gets a page for a 404 — with the backlinks, and no problem document', async () => {
    const response = await pipelineWith().handle(browser('/nope'), { role: 'web' });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).toStartWith('<!doctype html>');
    expect(body).toContain('Page not found');
    expect(body).toContain('https://github.com/developerz-ai/ultimate');
    expect(body).toContain('https://www.developerz.ai');
    expect(body).toContain('X_ROUTE_NOT_FOUND');
    // The fix line is an instruction for the author, and it names the app's own route table.
    expect(body).not.toContain('x routes list');
  });

  test('gets a page for a 500 that leaks nothing off the throwable', async () => {
    const response = await pipelineWith().handle(browser('/boom'), { role: 'web' });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('10.0.0.7');
    expect(body).not.toContain('x errors explain');
    expect(body).toContain('Something broke on our side');
    // The request id is on the page and on the header, so a visitor can quote one thing.
    const requestId = response.headers.get('x-request-id') ?? 'absent';
    expect(body).toContain(requestId);
  });

  test('still gets the overlay in dev — the cause, the fix and the stack', async () => {
    const response = await pipelineWith({ dev: true }).handle(browser('/boom'), { role: 'web' });
    const body = await response.text();
    expect(body).toContain(SECRET);
    expect(body).toContain('x errors explain');
    expect(body).not.toContain('https://www.developerz.ai');
  });

  test("an app's own file wins, verbatim", async () => {
    const own = '<!doctype html><title>ours</title>Gone fishing';
    const seen: number[] = [];
    const response = await pipelineWith({
      errorPage: (status) => {
        seen.push(status);
        return status === 404 ? own : undefined;
      },
    }).handle(browser('/nope'), { role: 'web' });
    expect(seen).toEqual([404]);
    expect(await response.text()).toBe(own);
    expect(response.status).toBe(404);
  });

  test('a hook that has no file for this status leaves the framework page', async () => {
    const response = await pipelineWith({ errorPage: () => undefined }).handle(browser('/nope'), {
      role: 'web',
    });
    expect(await response.text()).toContain('Page not found');
  });

  test('a hook that throws degrades to the problem document, never to no answer', async () => {
    const response = await pipelineWith({
      errorPage: () => {
        throw new TypeError('the disk went away');
      },
    }).handle(browser('/nope'), { role: 'web' });
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'X_ROUTE_NOT_FOUND' });
  });
});

describe('an agent, in production', () => {
  test('still gets problem+json, and the hook is never consulted', async () => {
    let asked = 0;
    const response = await pipelineWith({
      errorPage: () => {
        asked += 1;
        return '<!doctype html>never';
      },
    }).handle(agent('/nope'), { role: 'web' });
    expect(asked).toBe(0);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await response.json()).toMatchObject({
      code: 'X_ROUTE_NOT_FOUND',
      fix: expect.stringContaining('x routes list'),
    });
  });
});
