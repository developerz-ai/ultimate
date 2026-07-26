import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import type { AuthzDecision } from './hooks';
import { createPipeline, PIPELINE_STAGES } from './pipeline';
import { createRateLimiter } from './rate-limit';
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
    method: 'GET',
    path: '/private',
    meta: { name: 'private', auth: 'required' },
    handler: (_request, ctx) => json({ locale: ctx.locale, tz: ctx.tz }),
  },
  {
    method: 'POST',
    path: '/posts',
    meta: { name: 'posts.create', auth: 'public', input: titleSchema },
    handler: (_request, ctx) => json({ input: ctx.input }),
  },
  {
    method: 'GET',
    path: '/guarded',
    meta: { name: 'guarded', auth: 'public', policy: 'post:publish' },
    handler: () => text('never reached'),
  },
];

const config = defineHttpConfig({ dev: false, buildId: null, hostname: '127.0.0.1' });

interface PipelineTestOptions {
  actorId?: string;
  decision?: AuthzDecision;
  buildId?: string | null;
  rateLimitCapacity?: number;
}

const pipelineWith = (options: PipelineTestOptions) => {
  const active =
    options.buildId === undefined
      ? config
      : defineHttpConfig({ dev: false, buildId: options.buildId });
  const decision = options.decision;
  const actorId = options.actorId;
  return createPipeline({
    table: createRouter(routes),
    config: active,
    limiter: createRateLimiter({
      config: {
        enabled: true,
        defaultBucket: 'default',
        buckets: {
          default: { capacity: options.rateLimitCapacity ?? 100, refillPerSecond: 0.001 },
        },
      },
    }),
    hooks: {
      authenticate: () => (actorId === undefined ? null : ({ id: actorId } as never)),
      ...(decision === undefined ? {} : { authorize: () => decision }),
    },
  });
};

const get = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe('stage order', () => {
  test('is the documented order, and this test is the guarantee', () => {
    expect(PIPELINE_STAGES.map((stage) => stage.name)).toEqual([
      'request-id',
      'trace',
      'context',
      'locale',
      'auth',
      'rate-limit',
      'body',
      'authz',
      'handler',
      'cache-headers',
      'error-map',
      'response',
    ]);
  });

  test('every stage documents why it sits where it does', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(stage.why.length, `${stage.name} has no reason`).toBeGreaterThan(20);
    }
  });

  test('the runnable stages match the documented list one to one', () => {
    const pipeline = pipelineWith({});
    expect(pipeline.stages.map((stage) => stage.name)).toEqual(
      PIPELINE_STAGES.map((stage) => stage.name),
    );
    expect(pipeline.stages.every((stage) => typeof stage.run === 'function')).toBe(true);
  });

  test('body validation runs before authz, so a policy always sees parsed input', () => {
    const names = PIPELINE_STAGES.map((stage) => stage.name);
    expect(names.indexOf('body')).toBeLessThan(names.indexOf('authz'));
    expect(names.indexOf('auth')).toBeLessThan(names.indexOf('rate-limit'));
    expect(names.indexOf('context')).toBeLessThan(names.indexOf('auth'));
    expect(names.indexOf('handler')).toBeLessThan(names.indexOf('response'));
  });
});

describe('lifecycle', () => {
  test('a successful request carries request id, locale and security headers', async () => {
    const pipeline = pipelineWith({ actorId: 'actor-1' });
    const response = await pipeline.handle(
      get('/private', { headers: { 'accept-language': 'de-CH,de;q=0.9' } }),
      { role: 'web' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('server-timing')).toContain('total;dur=');
  });

  test('an unmatched route is problem+json, not an HTML page', async () => {
    const response = await pipelineWith({}).handle(get('/nope'), { role: 'web' });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['code']).toBe('X_ROUTE_NOT_FOUND');
    expect(body['fix']).toContain('x routes list');
  });

  test("auth: 'required' with no actor is 401 before the handler runs", async () => {
    const response = await pipelineWith({}).handle(get('/private'), { role: 'web' });
    expect(response.status).toBe(401);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('X_UNAUTHENTICATED');
  });

  test('an invalid body is 422 with the failing path in the cause', async () => {
    const response = await pipelineWith({}).handle(
      get('/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 7 }),
      }),
      { role: 'web' },
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['code']).toBe('X_BODY_INVALID');
    expect(String(body['cause'])).toContain('title: must be a string');
  });

  test('a valid body reaches the handler already parsed', async () => {
    const response = await pipelineWith({}).handle(
      get('/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'hello' }),
      }),
      { role: 'web' },
    );
    expect(await response.json()).toEqual({ input: { title: 'hello' } });
  });

  test('a declared policy with no authorizer fails closed', async () => {
    const response = await pipelineWith({}).handle(get('/guarded'), { role: 'web' });
    expect(response.status).toBe(403);
    expect(String(((await response.json()) as Record<string, unknown>)['cause'])).toContain(
      'no authorizer wired',
    );
  });

  test('a policy denial becomes 403 and keeps the reason', async () => {
    const pipeline = pipelineWith({
      decision: { allowed: false, reason: 'actor does not own post', code: 'X_FORBIDDEN' },
    });
    const response = await pipeline.handle(get('/guarded'), { role: 'web' });
    expect(response.status).toBe(403);
    expect(String(((await response.json()) as Record<string, unknown>)['cause'])).toContain(
      'actor does not own post',
    );
  });

  test('an exhausted bucket is 429 with Retry-After', async () => {
    const pipeline = pipelineWith({ rateLimitCapacity: 1 });
    expect((await pipeline.handle(get('/public'), { role: 'web' })).status).toBe(200);
    const limited = await pipeline.handle(get('/public'), { role: 'web' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  test('a stale client build id is told to reload instead of getting a 404', async () => {
    const pipeline = pipelineWith({ buildId: 'build-2' });
    const response = await pipeline.handle(
      get('/public', { headers: { 'x-ultimate-build': 'build-1' } }),
      { role: 'web' },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['code']).toBe('X_BUILD_SKEW');
    expect(body['fix']).toContain('reload');
  });
});
