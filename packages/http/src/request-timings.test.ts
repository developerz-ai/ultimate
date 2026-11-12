// The `Server-Timing` breakdown: `db`, `render`, `cache`, the gate and the handler under `x dev`,
// `total` alone in production — a query's duration is a timing oracle on data the caller cannot
// read. And a statement is charged to the request that emitted it, never to a neighbour.
import { afterEach, describe, expect, test } from 'bun:test';
import { instrument, runWithContext } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { asCtx, requestContext } from './context';
import { httpPipeline } from './pipeline';
import { requestTimings, serverTimingValue, subscribeRequestTimings } from './request-timings';
import { textResponse } from './response';
import { httpRouter } from './router';

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

const pipelineFor = (dev: boolean) =>
  httpPipeline({
    table: httpRouter([
      {
        method: 'GET',
        path: '/feed',
        meta: { name: 'feed', auth: 'public' },
        handler: async () => {
          instrument('db.statement', { text: 'select 1', values: [], rows: 3, durationMs: 7 });
          instrument('render.page', { route: '/feed', durationMs: 4 });
          instrument('cache.hit', { tier: 'memory', key: 'k' });
          instrument('cache.miss', { tier: 'memory', key: 'j' });
          return textResponse('ok');
        },
      },
    ]),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, buildId: null, dev }),
  });

const timingOf = async (dev: boolean): Promise<string> => {
  const response = await pipelineFor(dev).handle(new Request('http://app.test/feed'), {
    role: 'web',
  });
  return response.headers.get('server-timing') ?? '';
};

describe('Server-Timing', () => {
  test('under x dev it breaks the request down by db, render and cache', async () => {
    release = subscribeRequestTimings();
    const value = await timingOf(true);
    expect(value).toMatch(/^total;dur=[\d.]+, gate;dur=[\d.]+, handler;dur=[\d.]+/);
    expect(value).toContain('db;dur=7;desc="1 statements"');
    expect(value).toContain('render;dur=4');
    expect(value).toContain('cache;desc="1 hit, 1 miss"');
  });

  test('in production it is total alone, subscriber or not', async () => {
    release = subscribeRequestTimings();
    expect(await timingOf(false)).toMatch(/^total;dur=[\d.]+$/);
  });

  test('a statement is charged to the request it ran in, and outside a request to none', () => {
    release = subscribeRequestTimings();
    const config = defineHttpConfig({ rateLimit: { scope: 'process' }, buildId: null });
    const make = () =>
      requestContext({ url: new URL('http://app.test/'), method: 'GET', role: 'web', config });
    const mine = make();
    const theirs = make();
    runWithContext(asCtx(mine), () => {
      instrument('db.statement', { text: 'select 1', values: [], rows: 1, durationMs: 2.5 });
    });
    instrument('db.statement', { text: 'select 2', values: [], rows: 1, durationMs: 9 });
    expect(requestTimings(mine)?.dbStatements).toBe(1);
    expect(requestTimings(mine)?.dbMs).toBe(2.5);
    expect(requestTimings(theirs)).toBeUndefined();
  });

  test('the unsubscribe stops the accounting', () => {
    subscribeRequestTimings()();
    const config = defineHttpConfig({ rateLimit: { scope: 'process' }, buildId: null });
    const ctx = requestContext({
      url: new URL('http://app.test/'),
      method: 'GET',
      role: 'web',
      config,
    });
    runWithContext(asCtx(ctx), () => {
      instrument('db.statement', { text: 'select 1', values: [], rows: 1, durationMs: 1 });
    });
    expect(requestTimings(ctx)).toBeUndefined();
  });

  test('no breakdown is asked for: total alone, whatever was recorded', () => {
    const timings = {
      gateMs: 1,
      handlerMs: 2,
      dbStatements: 1,
      dbMs: 1,
      renderMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };
    expect(serverTimingValue(3, timings, false)).toBe('total;dur=3');
    expect(serverTimingValue(3, timings, true)).toBe(
      'total;dur=3, gate;dur=1, handler;dur=2, db;dur=1;desc="1 statements"',
    );
  });
});
