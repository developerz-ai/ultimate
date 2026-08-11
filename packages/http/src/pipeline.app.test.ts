// The two things the pipeline owes the APP, both of which it withheld: the request it is
// answering, and a status for the app's own error codes. Split out of `pipeline.test.ts`, which
// pins the framework's own lifecycle — one file, one job, and that one was at its ceiling.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ErrorReport } from '@ultimat3/core';
import {
  configureErrorReporting,
  memoryErrorReporter,
  resetErrorReporting,
  UltimateError,
} from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { useRequestCookie, useRequestHeader } from './context';
import { registerErrorStatus, resetErrorStatus } from './error-map';
import { createPipeline } from './pipeline';
import { json, text } from './response';
import { createRouter, type Route } from './router';

/** A code the APP owns — nothing in `ERROR_STATUS` knows it, which is the whole point. */
const APP_CODE = 'X_CREDENTIALS_INVALID';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/public',
    meta: { name: 'public', auth: 'public' },
    handler: () => text('ok'),
  },
  // The sign-in loop, both halves. The write half always worked; the read half had nowhere to
  // read from, which is why an app could set a session cookie and never see it again.
  {
    method: 'POST',
    path: '/sign-in',
    meta: { name: 'sign-in', auth: 'public' },
    handler: (_request, ctx) => {
      ctx.headers.set('set-cookie', 'session=s3cret; Path=/; HttpOnly');
      return text('signed in');
    },
  },
  {
    method: 'GET',
    path: '/me',
    meta: { name: 'me', auth: 'public' },
    handler: () =>
      json({ session: useRequestCookie('session'), agent: useRequestHeader('x-agent') }),
  },
  {
    method: 'GET',
    path: '/credentials',
    meta: { name: 'credentials', auth: 'public' },
    handler: () => {
      throw new UltimateError({
        code: APP_CODE,
        cause: 'the password did not match',
        fix: 'x logs tail --json   # then sign in again',
      });
    },
  },
];

const config = defineHttpConfig({ dev: false, buildId: null, hostname: '127.0.0.1' });

const pipeline = () => createPipeline({ table: createRouter(routes), config });

const get = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

/**
 * The blocking half of "an Ultimate app cannot implement authentication". The context carried
 * the RESPONSE headers and no reference to the request, so a session cookie the app itself set
 * could never be read back: sign-in worked, and every page after it saw a stranger.
 */
describe('the request the app is answering is readable from its context', () => {
  test('a cookie set on one response is readable on the next request', async () => {
    const handle = pipeline();

    const signIn = await handle.handle(get('/sign-in', { method: 'POST' }), { role: 'web' });
    const setCookie = signIn.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('session=s3cret');

    // The browser's next request, built from what the server actually sent.
    const sent = setCookie.split(';')[0] as string;
    const me = await handle.handle(get('/me', { headers: { cookie: sent } }), { role: 'web' });

    expect(await me.json()).toEqual({ session: 's3cret', agent: null });
  });

  test('an arbitrary inbound header is readable too', async () => {
    const me = await pipeline().handle(get('/me', { headers: { 'x-agent': 'claude' } }), {
      role: 'web',
    });
    expect(await me.json()).toEqual({ session: null, agent: 'claude' });
  });

  test('hooks.authenticate can read the cookie it was always meant to read', async () => {
    let seen: string | null = 'never ran';
    const handle = createPipeline({
      table: createRouter(routes),
      config,
      hooks: {
        authenticate: (request) => {
          seen = request.cookie('session');
          return null;
        },
      },
    });
    await handle.handle(get('/public', { headers: { cookie: 'session=s3cret' } }), { role: 'web' });
    expect(seen).toBe('s3cret');
  });
});

/**
 * `ERROR_STATUS` was closed, so every app-defined code answered 500 — and the `error-map` stage
 * reports `status >= 500`. A wrong password paged the on-call.
 */
describe('an app-declared status decides whether the on-call hears about it', () => {
  const reporter = memoryErrorReporter();

  beforeEach(() => {
    resetErrorReporting();
    resetErrorStatus();
    reporter.reset();
    configureErrorReporting({ reporter });
  });

  afterEach(() => {
    resetErrorReporting();
    resetErrorStatus();
  });

  test('undeclared: 500, and it pages', async () => {
    const response = await pipeline().handle(get('/credentials'), { role: 'web' });

    expect(response.status).toBe(500);
    expect(reporter.events).toHaveLength(1);
    expect((reporter.events[0] as ErrorReport).code).toBe(APP_CODE);
  });

  test('declared 401: the problem document says 401 and nothing pages', async () => {
    registerErrorStatus({ [APP_CODE]: 401 });
    const response = await pipeline().handle(get('/credentials'), { role: 'web' });

    expect(response.status).toBe(401);
    const document = (await response.json()) as { status: number; code: string; fix: string };
    expect(document.status).toBe(401);
    expect(document.code).toBe(APP_CODE);
    expect(document.fix).toContain('x logs tail');
    expect(reporter.events).toEqual([]);
  });

  test('a declared 5xx still pages — the app decides, and it can decide "page me"', async () => {
    registerErrorStatus({ [APP_CODE]: 503 });
    const response = await pipeline().handle(get('/credentials'), { role: 'web' });

    expect(response.status).toBe(503);
    expect(reporter.events).toHaveLength(1);
  });
});
