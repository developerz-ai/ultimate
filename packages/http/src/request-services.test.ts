// A registered service (`defineService`) closes over the actor it was built for. Over HTTP the
// context is created BEFORE the `auth` stage names the actor, so a service built there acts as
// anonymous for the whole request — the dummy app's `POST /api/posts/like` answered 500
// `X_ORG_NOT_A_MEMBER` for a signed-in member. These tests drive the real pipeline.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Actor, CtxFacts } from '@ultimat3/core';
import { anonymousActor, defineService, resetServices, useService } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { createRateLimiter } from './rate-limit';
import { json } from './response';
import { createRouter, type Route } from './router';

afterEach(() => {
  resetServices();
});

const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null });

function pipeline(routes: readonly Route[], authenticate: () => Actor | null) {
  return createPipeline({
    table: createRouter(routes),
    config,
    limiter: createRateLimiter({
      config: {
        enabled: false,
        defaultBucket: 'default',
        tenantBucket: null,
        scope: 'process',
        buckets: { default: { capacity: 100, refillPerSecond: 1 } },
      },
    }),
    hooks: { authenticate },
  });
}

const ada = { ...anonymousActor(), kind: 'user', id: 'ada' } as unknown as Actor;
const whoRoute = (name: string): Route => ({
  method: 'GET',
  path: `/${name}`,
  meta: { name, auth: 'public' },
  handler: (_request, ctx) =>
    json({
      actor: ctx.actor.id,
      service: useService<{ id: string }>('who').id,
      onCtx: (ctx as unknown as { who: { id: string } }).who.id,
    }),
});

describe('registered services over HTTP', () => {
  test('are bound to the actor the auth stage authenticated, not the anonymous one', async () => {
    defineService('who', (ctx: CtxFacts) => ({ id: ctx.actor.id }));
    const response = await pipeline([whoRoute('who')], () => ada).handle(
      new Request('http://localhost/who'),
      { role: 'web' },
    );
    expect(await response.json()).toEqual({ actor: 'ada', service: 'ada', onCtx: 'ada' });
  });

  test('are built once for the request, however many times the handler reads them', async () => {
    let builds = 0;
    defineService('who', (ctx: CtxFacts) => {
      builds += 1;
      return { id: ctx.actor.id };
    });
    await pipeline([whoRoute('once')], () => ada).handle(new Request('http://localhost/once'), {
      role: 'web',
    });
    expect(builds).toBe(1);
  });

  test('an authenticate hook that reads a service sees one, and the handler still sees the actor', async () => {
    const seen: string[] = [];
    defineService('who', (ctx: CtxFacts) => ({ id: ctx.actor.id }));
    const routes = [whoRoute('pre')];
    const response = await pipeline(routes, () => {
      seen.push(useService<{ id: string }>('who').id);
      return ada;
    }).handle(new Request('http://localhost/pre'), { role: 'web' });
    expect(seen[0]).not.toBe('ada');
    expect(await response.json()).toMatchObject({ service: 'ada', onCtx: 'ada' });
  });
});
