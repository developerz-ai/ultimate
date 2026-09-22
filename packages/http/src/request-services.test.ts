// A registered service (`defineService`) closes over the actor it was built for. Over HTTP the
// context is created BEFORE the `auth` stage names the actor, so a service built there acts as
// anonymous for the whole request — the dummy app's `POST /api/posts/like` answered 500
// `X_ORG_NOT_A_MEMBER` for a signed-in member. These tests drive the real pipeline.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Actor, CtxFacts } from '@ultimat3/core';
import { anonymousActor, defineService, resetServices, useService } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { createRequestContext } from './context';
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

/** A bare request context — the constructor the pipeline uses, without a pipeline around it. */
const bare = (services?: Record<string, unknown>) =>
  createRequestContext({
    url: new URL('https://app.test/x'),
    method: 'GET',
    role: 'web',
    config,
    ...(services === undefined ? {} : { services }),
  });

const read = (ctx: object, name: string): unknown => Reflect.get(ctx, name);

describe('the lazy service bag', () => {
  test('an explicit init.services mock overrides the registered factory, on ctx and on ctx.services', () => {
    defineService('who', (ctx: CtxFacts) => ({ id: ctx.actor.id }));
    const mock = { id: 'mock' };
    const ctx = bare({ who: mock });
    expect(read(ctx, 'who')).toBe(mock);
    expect(ctx.services['who']).toBe(mock);
  });

  test('a service an app named after a framework field loses to the field, and stays in ctx.services', () => {
    defineService('locale', () => 'from-a-factory');
    const ctx = bare();
    expect(ctx.locale).toBe('en');
    ctx.locale = 'es';
    expect(ctx.locale).toBe('es');
    expect(ctx.services['locale']).toBe('from-a-factory');
  });

  test('an actor swapped AFTER a read is what the next read is built for', () => {
    defineService('who', (ctx: CtxFacts) => ({ id: ctx.actor.id }));
    const ctx = bare();
    expect(read(ctx, 'who')).toEqual({ id: 'anonymous' });
    ctx.actor = ada;
    expect(read(ctx, 'who')).toEqual({ id: 'ada' });
  });

  test('a locale change and a tz change between two reads each rebuild', () => {
    let builds = 0;
    defineService('where', (ctx: CtxFacts) => {
      builds += 1;
      return { locale: ctx.locale, tz: ctx.tz };
    });
    const ctx = bare();
    read(ctx, 'where');
    read(ctx, 'where');
    expect(builds).toBe(1);
    ctx.locale = 'es';
    expect(read(ctx, 'where')).toMatchObject({ locale: 'es' });
    ctx.tz = 'Europe/Madrid';
    expect(read(ctx, 'where')).toMatchObject({ tz: 'Europe/Madrid' });
    expect(builds).toBe(3);
  });
});
