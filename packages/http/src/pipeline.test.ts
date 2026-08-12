import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ErrorReport, ReadableSpan } from '@ultimat3/core';
import {
  collectMetrics,
  configureErrorReporting,
  configureTelemetry,
  memoryErrorReporter,
  memoryExporter,
  resetErrorReporting,
  resetMetrics,
  resetTelemetry,
} from '@ultimat3/core';
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
  {
    method: 'GET',
    path: '/self-guarded',
    meta: { name: 'self-guarded', auth: 'public', policy: 'post:publish', enforcedBy: 'handler' },
    handler: () => text('the handler decided'),
  },
  {
    method: 'GET',
    path: '/posts/:id',
    meta: { name: 'posts.show', auth: 'public' },
    handler: () => text('one post'),
  },
  {
    method: 'GET',
    path: '/boom/:id',
    meta: { name: 'boom', auth: 'public' },
    handler: () => {
      throw new TypeError('undefined is not a function');
    },
  },
];

const config = defineHttpConfig({ dev: false, buildId: null, hostname: '127.0.0.1' });

interface PipelineTestOptions {
  actorId?: string;
  decision?: AuthzDecision;
  buildId?: string | null;
  rateLimitCapacity?: number;
  /** Fires whenever the `authorize` hook is consulted, so "never asked" is assertable. */
  onAuthorize?: () => void;
}

const pipelineWith = (options: PipelineTestOptions) => {
  const active =
    options.buildId === undefined
      ? config
      : defineHttpConfig({ dev: false, buildId: options.buildId });
  const decision = options.decision;
  const actorId = options.actorId;
  const onAuthorize = options.onAuthorize;
  const authorize = (): AuthzDecision => {
    onAuthorize?.();
    return decision ?? { allowed: true };
  };
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
      ...(decision === undefined ? {} : { authorize }),
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

  // What the deployed app did to a person clicking a link: rendered the problem document as raw
  // text in the viewport. The document is right for the agent that asked for JSON and wrong for
  // the browser that asked for HTML, and `signInPath` is what separates them.
  test('a browser hitting the same route is sent to the sign-in page', async () => {
    const signIn = createPipeline({
      table: createRouter(routes),
      config: defineHttpConfig({ dev: false, signInPath: '/signin' }),
      hooks: { authenticate: () => null },
    });
    const response = await signIn.handle(get('/private', { headers: { accept: 'text/html' } }), {
      role: 'web',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/signin?next=%2Fprivate');
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

  test('a route enforced by its handler needs no authorizer and gets no second opinion', async () => {
    let asked = 0;
    const pipeline = pipelineWith({
      // Allowed, so a denial cannot be what proves the point — only the count can.
      decision: { allowed: true },
      onAuthorize: () => {
        asked += 1;
      },
    });

    // Two runs, one with a hook wired and one without: the stage stands down either way,
    // because the handler is where this route's policy is evaluated.
    expect((await pipeline.handle(get('/self-guarded'), { role: 'web' })).status).toBe(200);
    expect(asked).toBe(0);
    expect((await pipelineWith({}).handle(get('/self-guarded'), { role: 'web' })).status).toBe(200);
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

describe('the request span', () => {
  // The root span of a request is the only span a host can hang a timeline off, and it carried
  // no attributes at all — an exporter got a name and a duration with nothing to correlate.
  const spansOf = async (run: () => Promise<Response>): Promise<readonly ReadableSpan[]> => {
    const exporter = memoryExporter();
    configureTelemetry({ exporter });
    try {
      await run();
    } finally {
      resetTelemetry();
    }
    return exporter.spans;
  };

  test('is a server span naming the request id, method, route and status the client saw', async () => {
    const pipeline = pipelineWith({});
    const spans = await spansOf(() => pipeline.handle(get('/public'), { role: 'web' }));

    const root = spans.find((span) => span.parentSpanId === undefined);
    expect(root?.name).toBe('GET /public');
    expect(root?.kind).toBe('server');
    expect(root?.attributes['http.method']).toBe('GET');
    expect(root?.attributes['http.route']).toBe('/public');
    expect(root?.attributes['http.status_code']).toBe(200);
    expect(typeof root?.attributes['http.request_id']).toBe('string');
  });

  test('the id on the span is the id on the response, or the two cannot be joined', async () => {
    const pipeline = pipelineWith({});
    let response: Response | undefined;
    const spans = await spansOf(async () => {
      response = await pipeline.handle(get('/public'), { role: 'web' });
      return response;
    });

    const root = spans.find((span) => span.parentSpanId === undefined);
    expect(root?.attributes['http.request_id']).toBe(response?.headers.get('x-request-id'));
  });

  test('a refused request still reports the status it answered with', async () => {
    const pipeline = pipelineWith({ actorId: 'u_1', decision: { allowed: false, reason: 'nope' } });
    const spans = await spansOf(() => pipeline.handle(get('/guarded'), { role: 'web' }));

    const root = spans.find((span) => span.parentSpanId === undefined);
    // The refusal is the outcome worth finding in a timeline; a span that stopped at the throw
    // would report no status at all.
    expect(root?.attributes['http.status_code']).toBe(403);
  });
});

/** The point of the whole exercise: `docker/helm`'s web HPA derives `rps` from this counter. */
describe('every request lands in the metrics the deploy chart scales on', () => {
  const seriesOf = (name: string) =>
    collectMetrics().metrics.find((metric) => metric.descriptor.name === name)?.points ?? [];

  const totalFor = (route: string, status: string): number =>
    seriesOf('http_requests_total')
      .filter(
        (point) => point.attributes['route'] === route && point.attributes['status'] === status,
      )
      .reduce((sum, point) => sum + point.value, 0);

  beforeEach(() => {
    resetMetrics();
  });

  test('counts a served request once, with a duration beside it', async () => {
    const pipeline = pipelineWith({});
    await pipeline.handle(get('/public'), { role: 'web' });
    await pipeline.handle(get('/public'), { role: 'web' });

    expect(totalFor('/public', '2xx')).toBe(2);
    const duration = seriesOf('http_request_duration_seconds').find(
      (point) => point.attributes['route'] === '/public',
    );
    expect((duration as { count?: number } | undefined)?.count).toBe(2);
  });

  test('a refused request is counted too — an error path is not a request that did not happen', async () => {
    const pipeline = pipelineWith({ actorId: 'u_1', decision: { allowed: false, reason: 'nope' } });
    await pipeline.handle(get('/guarded'), { role: 'web' });

    expect(totalFor('/guarded', '4xx')).toBe(1);
  });

  test('the label is the route PATTERN, so a million ids are one series', async () => {
    const pipeline = pipelineWith({});
    for (const id of ['1', '2', '3']) {
      await pipeline.handle(get(`/posts/${id}`), { role: 'web' });
    }

    expect(totalFor('/posts/:id', '2xx')).toBe(3);
    // The concrete paths must appear nowhere: this is the cardinality bomb, and a metric label is
    // the one place an attacker gets to choose how much memory the monitoring stack allocates.
    expect(seriesOf('http_requests_total').map((point) => point.attributes['route'])).toEqual([
      '/posts/:id',
    ]);
  });

  test('an unmatched path collapses to one series instead of one per probe', async () => {
    const pipeline = pipelineWith({});
    await pipeline.handle(get('/wp-admin'), { role: 'web' });
    await pipeline.handle(get('/.env'), { role: 'web' });

    expect(totalFor('unmatched', '4xx')).toBe(2);
  });
});

/**
 * The seam that shipped with nothing plugged into it. `onError` stays the APP's sink; the
 * framework's own reporting is a stage, so an app that never writes a hook is still not blind.
 */
describe('a server fault reaches the error reporter', () => {
  const reporter = memoryErrorReporter();

  beforeEach(() => {
    resetErrorReporting();
    reporter.reset();
    configureErrorReporting({ reporter });
  });

  afterEach(() => {
    resetErrorReporting();
  });

  test('reports a 5xx with the request id, the trace and the route PATTERN', async () => {
    const pipeline = pipelineWith({});
    const response = await pipeline.handle(get('/boom/7'), { role: 'web' });

    expect(response.status).toBe(500);
    expect(reporter.events).toHaveLength(1);
    const event = reporter.events[0] as ErrorReport;
    expect(event.source).toBe('http');
    expect(event.code).toBe('X_INTERNAL');
    expect(event.scope.requestId).toBe(response.headers.get('x-request-id') as string);
    expect(event.scope.role).toBe('web');
    // The pattern, never `/boom/7`: a report facet is as attacker-chosen as a metric label.
    expect(event.scope.operation).toBe('GET /boom/:id');
  });

  test('a 4xx is the caller’s mistake and is NOT reported', async () => {
    const pipeline = pipelineWith({ actorId: 'u_1', decision: { allowed: false, reason: 'nope' } });
    await pipeline.handle(get('/guarded'), { role: 'web' });
    await pipeline.handle(get('/wp-admin'), { role: 'web' });

    expect(reporter.events).toEqual([]);
  });

  test('the app’s own onError hook still fires, alongside the framework’s report', async () => {
    const seen: string[] = [];
    const pipeline = createPipeline({
      table: createRouter(routes),
      config,
      hooks: { onError: (error) => seen.push((error as Error).name) },
    });
    await pipeline.handle(get('/boom/7'), { role: 'web' });

    expect(seen).toEqual(['TypeError']);
    expect(reporter.events).toHaveLength(1);
  });
});
