// `/_client-errors` through the real `httpPipeline`: every refusal by its status, and the report a
// configured `ErrorReporter` receives — `source: 'browser'`, `X_CLIENT_ERROR`, the tab's build —
// with nothing reported for a refusal.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Actor, ClientErrorsConfig } from '@ultimat3/core';
import {
  CLIENT_ERRORS_DEFAULTS,
  configureErrorReporting,
  errorFingerprint,
  memoryErrorReporter,
  resetErrorReporting,
  userActor,
} from '@ultimat3/core';
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import { compilePattern } from '@ultimat3/render';
import type { ClientErrorPage } from './client-errors-routes';
import {
  clientErrorsHead,
  clientErrorsRoutes,
  clientErrorsStaticWarning,
  clientErrorsSurface,
} from './client-errors-routes';
import { CLIENT_ERRORS_PATH, CLIENT_ERRORS_SCRIPT_PATH } from './client-errors-script';

const ON: ClientErrorsConfig = { ...CLIENT_ERRORS_DEFAULTS, enabled: true };
const ADA: Actor = userActor({ id: 'ada', orgId: 'org-1', roles: ['member'] });

const PAGES: readonly ClientErrorPage[] = [
  {
    path: '/settings',
    surface: 'app',
    pattern: compilePattern('/settings'),
    islands: ['settings'],
  },
  {
    path: '/posts/:id',
    surface: 'app',
    pattern: compilePattern('/posts/:id'),
    islands: ['post-form', 'like'],
  },
];

const reporter = memoryErrorReporter();
beforeEach(() => {
  reporter.reset();
  configureErrorReporting({ reporter, release: 'build-9' });
});
afterEach(() => resetErrorReporting());

function server(config: ClientErrorsConfig = ON, actor: Actor | null = ADA) {
  const pipeline = httpPipeline({
    table: httpRouter(clientErrorsRoutes(config, { pages: () => PAGES })),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
    hooks: { authenticate: () => actor },
  });
  // `null` drops a header: a request with NO browser evidence is a different case from a bad one.
  return (body: unknown, headers: Record<string, string | null> = {}): Promise<Response> =>
    pipeline.handle(
      new Request(`http://app.test${CLIENT_ERRORS_PATH}`, {
        method: 'POST',
        headers: Object.entries({
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          ...headers,
        }).flatMap(([name, value]): [string, string][] => (value === null ? [] : [[name, value]])),
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      { role: 'web', ip: '203.0.113.7' },
    );
}

const REPORT = {
  kind: 'island',
  message: 'mount threw',
  path: '/posts/42',
  build: 'build-8',
  island: 'post-form',
  stack: 'TypeError: mount threw\n    at mount (https://app.test/islands/post-form.js:3:9)',
};

describe('POST /_client-errors', () => {
  test('a same-origin report is 204 and reaches the reporter as a browser X_CLIENT_ERROR', async () => {
    const response = await server()(REPORT);
    expect(response.status).toBe(204);
    expect(reporter.events).toHaveLength(1);
    const event = reporter.events[0];
    expect(event?.source).toBe('browser');
    expect(event?.code).toBe('X_CLIENT_ERROR');
    expect(event?.cause).toBe('mount threw');
    expect(event?.meta).toEqual({ clientBuild: 'build-8', kind: 'island', island: 'post-form' });
    // The server's own deploy beside the tab's: a stale tab, not a bug.
    expect(event?.release).toBe('build-9');
    // The browser's stack, never the server's construction site.
    expect(event?.stack).toBe(REPORT.stack);
    expect(event?.scope.actorId).toBe('ada');
    // The route PATTERN and the island, never the concrete path: the grouping key's input.
    expect(event?.scope.operation).toBe('/posts/:id post-form');
    expect(event?.scope.extra).toEqual({ path: '/posts/42' });
    expect(event?.fix).toBe('x shot /posts/42 --json');
  });

  test('wave 3 errorFingerprint groups one fault across paths and splits two islands', async () => {
    const send = server();
    await send(REPORT);
    await send({ ...REPORT, path: '/posts/43', message: 'other words' });
    await send({ ...REPORT, island: 'like' });
    const [a, b, c] = reporter.events.map((event) => errorFingerprint(event));
    expect(a).toBe(b ?? '');
    expect(a).not.toBe(c ?? '');
  });

  // The id is the browser's to choose: grouped on, an invented one per report would be a new
  // fingerprint group per report. Only an island this build serves is a facet; any other is filed.
  test('an island id this build does not serve is filed with no operation', async () => {
    const send = server();
    for (const island of ['not-ours-1', 'not-ours-2']) {
      expect((await send({ ...REPORT, island })).status).toBe(204);
    }
    expect(reporter.events.map((event) => event.scope.operation)).toEqual([undefined, undefined]);
    expect(new Set(reporter.events.map((event) => errorFingerprint(event))).size).toBe(1);
    expect(reporter.events[0]?.meta).toEqual(expect.objectContaining({ island: 'not-ours-1' }));
  });

  test('a path no app page matches is reported with no operation', async () => {
    await server()({ kind: 'error', message: 'x', path: '/nowhere', build: 'b' });
    expect(reporter.events[0]?.scope.operation).toBeUndefined();
  });

  test('a cross-site request is 403, and one with no browser evidence too', async () => {
    const send = server(ON, null);
    const anonymousOn = server({ ...ON, anonymous: true }, null);
    expect((await anonymousOn(REPORT, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    // The pipeline's `csrf` stage lets an anonymous request with neither header through as a
    // webhook would be; this route has no such caller, so it refuses one itself.
    const bare = await anonymousOn(REPORT, { 'sec-fetch-site': null });
    expect(bare.status).toBe(403);
    const problem = (await bare.json()) as { code: string; fix: string };
    expect(problem.code).toBe('X_CSRF_BLOCKED');
    // True for THIS throw: the route exists, so the remedy is where the report comes from.
    expect(problem.fix).toContain('same origin');
    expect(problem.fix).not.toContain('enabled');
    expect((await send(REPORT, { 'sec-fetch-site': 'cross-site' })).status).not.toBe(204);
    expect(reporter.events).toHaveLength(0);
  });

  test('an anonymous caller is 401 unless the app opened the door', async () => {
    expect((await server(ON, null)(REPORT)).status).toBe(401);
    expect(reporter.events).toHaveLength(0);
    expect((await server({ ...ON, anonymous: true }, null)(REPORT)).status).toBe(204);
    expect(reporter.events).toHaveLength(1);
  });

  test('a body over 32 KiB is refused unread past the cap', async () => {
    const response = await server()({ ...REPORT, stack: 'x'.repeat(33 * 1024) });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe('X_BODY_INVALID');
    expect(reporter.events).toHaveLength(0);
  });

  test('an unknown key, a wrong kind, an over-long field and non-JSON are each refused', async () => {
    const send = server();
    for (const body of [
      { ...REPORT, vitals: { lcp: 1 } },
      { ...REPORT, kind: 'vitals' },
      { ...REPORT, message: 'm'.repeat(1_001) },
      { ...REPORT, path: 'posts/42' },
      { ...REPORT, path: '/posts/42?token=secret' },
      { ...REPORT, path: '/posts/42\u0000x' },
      { ...REPORT, path: '/posts/42\u001b[2Jx' },
      { ...REPORT, path: '/posts/42\u007f' },
      'not json',
      [],
    ]) {
      const response = await send(body);
      expect(response.status).toBe(422);
    }
    expect(reporter.events).toHaveLength(0);
  });

  test('past perMinute the caller is 429 and nothing more is reported', async () => {
    const send = server({ ...ON, perMinute: 2 });
    expect((await send(REPORT)).status).toBe(204);
    expect((await send(REPORT)).status).toBe(204);
    expect((await send(REPORT)).status).toBe(429);
    expect(reporter.events).toHaveLength(2);
  });
});

describe('GET /x-client-errors.js and the head', () => {
  test('the script is served revalidated, as JavaScript', async () => {
    const pipeline = httpPipeline({
      table: httpRouter(clientErrorsRoutes(ON, { pages: () => PAGES })),
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
    });
    const response = await pipeline.handle(
      new Request(`http://app.test${CLIENT_ERRORS_SCRIPT_PATH}`),
      { role: 'web' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(await response.text()).toContain(CLIENT_ERRORS_PATH);
  });

  test('the head names the script with the build it was rendered by, escaped', () => {
    expect(clientErrorsHead('b"1')).toBe(
      `<script src="${CLIENT_ERRORS_SCRIPT_PATH}" data-build="b&quot;1" defer></script>`,
    );
  });

  test('off — or no app.config.ts — mounts nothing and names no script', () => {
    expect(clientErrorsSurface(undefined, 'b')).toBeUndefined();
    expect(clientErrorsSurface({ ...ON, enabled: false }, 'b')).toBeUndefined();
    const on = clientErrorsSurface(ON, 'b');
    expect(on?.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${CLIENT_ERRORS_SCRIPT_PATH}`,
      `POST ${CLIENT_ERRORS_PATH}`,
    ]);
    expect(on?.head).toBe(clientErrorsHead('b'));
  });

  test('a static export with it on says it cannot serve it; with it off says nothing', () => {
    expect(clientErrorsStaticWarning(undefined)).toEqual([]);
    expect(clientErrorsStaticWarning({ ...ON, enabled: false })).toEqual([]);
    const [warning] = clientErrorsStaticWarning(ON);
    expect(warning).toContain('clientErrors.enabled');
    expect(warning).toContain(CLIENT_ERRORS_SCRIPT_PATH);
  });
});
