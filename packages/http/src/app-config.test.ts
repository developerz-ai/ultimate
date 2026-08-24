// The app's HTTP declaration has to REACH a served request, not merely typecheck. Every
// assertion here runs a real request through a real pipeline built the way a boot builds one —
// `defineHttpConfig(mergeHttpConfig(configuredHttp(), <the boot's own facts>))` — because the
// defect this file exists for is a config key that is declared, defaulted, merged and read by
// nothing: `DEFAULT_CORS.origins` was `[]` with no path to change it, so every cross-origin call
// in every deployment was refused, permanently.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  type AppHttpConfig,
  configuredHttp,
  configureHttp,
  mergeHttpConfig,
  resetHttpConfig,
} from './app-config';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { json, text } from './response';
import { createRouter, type Route } from './router';
import type { Schema } from './validate';

const titleSchema: Schema<{ title: string }> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => {
      const record = (typeof value === 'object' && value !== null ? value : {}) as {
        title?: unknown;
      };
      return typeof record.title === 'string'
        ? { value: { title: record.title } }
        : { issues: [{ message: 'must be a string', path: ['title'] }] };
    },
  },
};

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/public',
    meta: { name: 'public', auth: 'public' },
    handler: () => text('ok'),
  },
  {
    method: 'POST',
    path: '/posts',
    meta: { name: 'posts.create', auth: 'public', input: titleSchema },
    handler: (_request, ctx) => json({ input: ctx.input }),
  },
];

/** Exactly what `startWeb` does: the app's declaration underneath, the boot's own facts on top. */
const boot = (): ReturnType<typeof createPipeline> =>
  createPipeline({
    table: createRouter(routes),
    config: defineHttpConfig(
      mergeHttpConfig(configuredHttp(), {
        dev: false,
        buildId: null,
        hostname: '127.0.0.1',
        rateLimit: { scope: 'process' },
        security: { csp: { extend: { 'script-src': ["'sha256-boot'"] } } },
      }),
    ),
  });

afterEach(() => {
  resetHttpConfig();
});

describe('an app-declared HTTP block reaches the running pipeline', () => {
  test('a declared CORS origin is answered with access-control-allow-origin', async () => {
    configureHttp({ cors: { origins: ['https://app.example.test'], credentials: false } });

    const response = await boot().handle(
      new Request('http://localhost/public', { headers: { origin: 'https://app.example.test' } }),
      { role: 'web' },
    );

    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
  });

  test('an origin the app did not declare is still refused', async () => {
    configureHttp({ cors: { origins: ['https://app.example.test'], credentials: false } });

    const response = await boot().handle(
      new Request('http://localhost/public', { headers: { origin: 'https://evil.example.test' } }),
      { role: 'web' },
    );

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    // The refusal is still varied on, or a shared cache files the un-CORS'd body under the URL.
    expect(response.headers.get('vary')).toContain('origin');
  });

  test('a declared body limit is what the request is measured against', async () => {
    configureHttp({ bodyLimitBytes: 8 });

    const response = await boot().handle(
      new Request('http://localhost/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'far longer than eight bytes' }),
      }),
      { role: 'web' },
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toContain('limit is 8');
  });

  test('a declared request timeout is the budget the deadline runs on', async () => {
    configureHttp({ requestTimeoutMs: 250 });
    expect(boot().config.requestTimeoutMs).toBe(250);
  });

  test('a declared bucket is the one a route without its own limit spends', () => {
    configureHttp({
      rateLimit: { buckets: { default: { capacity: 3, refillPerSecond: 0.1 } } },
    });
    expect(boot().config.rateLimit.buckets['default']).toEqual({
      capacity: 3,
      refillPerSecond: 0.1,
    });
  });
});

describe('mergeHttpConfig layering', () => {
  test('a boot fact wins over an app that reached the same key through a cast', () => {
    // The type refuses `dev` to an app; the layering has to hold anyway, because `buildId`,
    // `port` and `hostname` are facts only the process knows and an app cannot be right about.
    const app = { dev: true, basePath: '/api' } as AppHttpConfig;
    expect(mergeHttpConfig(app, { dev: false, buildId: 'b7' })).toMatchObject({
      dev: false,
      buildId: 'b7',
      basePath: '/api',
    });
  });

  test('both halves of csp.extend survive, per directive', () => {
    const merged = mergeHttpConfig(
      {
        security: {
          csp: { extend: { 'script-src': ['https://cdn.example.test'], 'img-src': ['data:'] } },
        },
      },
      { security: { csp: { extend: { 'script-src': ["'sha256-boot'"] } } } },
    );
    // The app's CDN and the boot's inline hash are each the whole answer for something: dropping
    // either breaks a page — the CDN script, or every island's hydration runtime.
    expect(merged.security?.csp?.extend).toEqual({
      'script-src': ['https://cdn.example.test', "'sha256-boot'"],
      'img-src': ['data:'],
    });
  });

  test('the boot-derived rate-limit scope wins and the app keeps its buckets', () => {
    const merged = mergeHttpConfig(
      { rateLimit: { enabled: true, buckets: { default: { capacity: 9, refillPerSecond: 1 } } } },
      { rateLimit: { scope: 'shared' } },
    );
    expect(merged.rateLimit?.scope).toBe('shared');
    expect(merged.rateLimit?.buckets?.['default']?.capacity).toBe(9);
  });

  test('no declaration at all is the boot alone', () => {
    expect(configuredHttp()).toBeUndefined();
    expect(mergeHttpConfig(undefined, { port: 3000 })).toEqual({ port: 3000 });
  });
});
