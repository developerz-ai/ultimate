import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { createRequestContext, type RequestContext } from './context';
import { compose, type Middleware } from './middleware';
import { UltimateRequest } from './request';
import { text } from './response';
import type { RouteHandler } from './router';

const config = defineHttpConfig({ dev: false, buildId: null, hostname: '127.0.0.1' });

const makeRequest = (): { request: UltimateRequest; ctx: RequestContext } => {
  const ctx = createRequestContext({
    url: new URL('http://x.test/posts'),
    method: 'GET',
    role: 'web',
    config,
  });
  return { request: new UltimateRequest(new Request('http://x.test/posts'), ctx), ctx };
};

describe('compose()', () => {
  test('runs middleware left-to-right, outermost-in, outermost-out', async () => {
    const order: string[] = [];
    const { request, ctx } = makeRequest();

    const a: Middleware = async (req, c, next) => {
      order.push('a-in');
      const response = await next(req, c);
      order.push('a-out');
      return response;
    };
    const b: Middleware = async (req, c, next) => {
      order.push('b-in');
      const response = await next(req, c);
      order.push('b-out');
      return response;
    };
    const handler: RouteHandler = () => {
      order.push('handler');
      return text('ok');
    };

    const composed = compose([a, b])(handler);
    const response = await composed(request, ctx);

    expect(order).toEqual(['a-in', 'b-in', 'handler', 'b-out', 'a-out']);
    expect(await response.text()).toBe('ok');
  });

  test('an empty middleware array passes request/ctx straight through to the handler', async () => {
    const { request, ctx } = makeRequest();
    let seen: { request: UltimateRequest; ctx: RequestContext } | undefined;

    const handler: RouteHandler = (req, c) => {
      seen = { request: req, ctx: c };
      return text('bare');
    };

    const composed = compose([])(handler);
    const response = await composed(request, ctx);

    expect(seen?.request).toBe(request);
    expect(seen?.ctx).toBe(ctx);
    expect(await response.text()).toBe('bare');
  });

  test('a middleware that never calls next short-circuits the chain', async () => {
    const order: string[] = [];
    const { request, ctx } = makeRequest();

    const shortCircuit: Middleware = (_req, _c, _next) => {
      order.push('short-circuit');
      return text('stopped', { status: 403 });
    };
    const neverRuns: Middleware = async (req, c, next) => {
      order.push('never-runs-in');
      return next(req, c);
    };
    const handler: RouteHandler = () => {
      order.push('handler');
      return text('unreachable');
    };

    const composed = compose([shortCircuit, neverRuns])(handler);
    const response = await composed(request, ctx);

    expect(order).toEqual(['short-circuit']);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('stopped');
  });
});
