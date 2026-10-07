// The bearer mount hands its resolver the same `RequestFacts` `@ultimat3/mcp` does, so one
// resolver written for both (`apiKeyResolver`, or an app's) can read `facts` on either surface.
// The address is the pipeline's `ctx.ip` — a declared proxy's hop honoured, a forged one not.

import { describe, expect, test } from 'bun:test';
import { agentActor, frozenClock } from '@ultimat3/core';
import { bearerMount } from './bearer-mount';
import { defineHttpConfig } from './config';
import { httpPipeline } from './pipeline';
import { memoryRateLimitStore } from './rate-limit';
import type { RequestFacts } from './request-facts';
import { jsonResponse } from './response';
import { httpRouter, type Route } from './router';

const api: readonly Route[] = [
  {
    method: 'GET',
    path: '/_x/query/case-list',
    meta: { name: 'caseList', auth: 'required', enforcedBy: 'handler' },
    handler: () => jsonResponse({ ok: true }),
  },
];

const pipelineSeeing = (decide: (facts: RequestFacts) => boolean, trustProxy: boolean) => {
  const seen: RequestFacts[] = [];
  const mounted = bearerMount({
    prefix: '/v1',
    routes: api,
    scopes: { 'cases:read': ['caseList'] },
    resolveToken: (token, facts) => {
      seen.push(facts);
      return token === 'tok' && decide(facts)
        ? { actor: agentActor({ id: 'a1' }), scopes: new Set(['cases:read']) }
        : null;
    },
    rateLimitStore: memoryRateLimitStore(),
    clock: frozenClock(0),
  });
  const pipeline = httpPipeline({
    table: httpRouter([...api, ...mounted]),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      ...(trustProxy ? { trustProxy: true, trustedProxyHops: 1 } : {}),
    }),
  });
  return { pipeline, seen };
};

const get = (headers: Record<string, string>): Request =>
  new Request('http://localhost/v1/case-list?page=2', {
    headers: { authorization: 'Bearer tok', ...headers },
  });

describe('bearerMount: resolveToken(token, facts)', () => {
  test('the resolver is handed frozen facts, the address the pipeline resolved', async () => {
    const { pipeline, seen } = pipelineSeeing(() => true, true);
    const response = await pipeline.handle(
      get({ 'user-agent': 'agent/1', 'x-forwarded-for': '203.0.113.9' }),
      { role: 'web', ip: '10.0.0.1' },
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual([
      { address: '203.0.113.9', userAgent: 'agent/1', origin: null, path: '/v1/case-list' },
    ]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  test('an undeclared proxy is not trusted: the socket is the address', async () => {
    const { pipeline, seen } = pipelineSeeing(() => true, false);
    await pipeline.handle(get({ 'x-forwarded-for': '6.6.6.6' }), { role: 'web', ip: '10.0.0.1' });
    expect(seen[0]?.address).toBe('10.0.0.1');
  });

  test('a resolver refusing a browser origin answers the same 401 as a bad token', async () => {
    const { pipeline } = pipelineSeeing((facts) => facts.origin === null, false);
    const refused = await pipeline.handle(get({ origin: 'https://evil.example' }), { role: 'web' });
    expect(refused.status).toBe(401);
    expect((await pipeline.handle(get({}), { role: 'web' })).status).toBe(200);
  });
});
