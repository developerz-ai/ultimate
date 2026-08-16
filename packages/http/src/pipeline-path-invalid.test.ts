// What a malformed percent-escape in the path is worth end to end: a 400 the caller can act on,
// and silence from the error monitor. Split out of `pipeline.test.ts`, which pins the framework's
// own lifecycle and is at its ceiling — one file, one job.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureErrorReporting, memoryErrorReporter, resetErrorReporting } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { json, text } from './response';
import { createRouter, type Route } from './router';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/posts/:id',
    meta: { name: 'posts.show', auth: 'public' },
    handler: (_request, ctx) => json({ id: ctx.params['id'] }),
  },
  {
    method: 'GET',
    path: '/files/*path',
    meta: { name: 'files.serve', auth: 'public' },
    handler: () => text('file'),
  },
];

const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false });
const pipeline = () => createPipeline({ table: createRouter(routes), config, hooks: {} });
const get = (path: string) => new Request(`http://localhost${path}`);

describe('a path the client mis-encoded', () => {
  const reporter = memoryErrorReporter();

  beforeEach(() => {
    resetErrorReporting();
    reporter.reset();
    configureErrorReporting({ reporter });
  });

  afterEach(() => {
    resetErrorReporting();
  });

  // Before: `decodeURIComponent('%ZZ')` threw a bare `URIError` out of the match, the error map
  // had no code for it, and the caller's typo answered 500 — and paged whoever was on call.
  test('answers 400 with the code, the offending segment and a runnable fix', async () => {
    const response = await pipeline().handle(get('/posts/%ZZ'), { role: 'web' });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['code']).toBe('X_PATH_INVALID');
    expect(body['cause']).toContain('%ZZ');
    expect(body['fix']).toContain('encodeURIComponent');
  });

  test('the error monitor is not paged for it', async () => {
    await pipeline().handle(get('/posts/%ZZ'), { role: 'web' });
    await pipeline().handle(get('/files/a/%E0%A4%A/b'), { role: 'web' });

    expect(reporter.events).toEqual([]);
  });

  test('a wildcard tail is refused the same way', async () => {
    const response = await pipeline().handle(get('/files/a/%E0%A4%A/b'), { role: 'web' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('X_PATH_INVALID');
  });

  test('a correctly encoded param still routes and still arrives decoded', async () => {
    const response = await pipeline().handle(get('/posts/a%20b'), { role: 'web' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'a b' });
  });

  test('an unmatched path with no escape at all is still 404', async () => {
    const response = await pipeline().handle(get('/nope'), { role: 'web' });
    expect(response.status).toBe(404);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('X_ROUTE_NOT_FOUND');
  });
});
