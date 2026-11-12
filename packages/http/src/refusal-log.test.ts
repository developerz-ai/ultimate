// H7: an anonymous hit on an `auth: 'required'` route is counted every time and logged at `info`
// once per route per minute, `debug` after — one scanner was five `info` lines in 13 minutes. A
// credential checker's own `X_UNAUTHENTICATED` is not routine and stays `warn`.
import { beforeEach, describe, expect, test } from 'bun:test';
import { collectMetrics, resetMetrics, structuredLogger } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { requestContext } from './context';
import { HttpError, unauthenticated } from './errors';
import { ROUTINE_REFUSAL_WINDOW_MS, refusalLogLevel, resetRefusalLog } from './refusal-log';
import { UltimateRequest } from './request';
import { httpRouter } from './router';
import { stageRunners } from './stages';

beforeEach(() => {
  resetRefusalLog();
  resetMetrics();
});

const refusalCount = (code: string): number =>
  (collectMetrics().metrics.find((m) => m.descriptor.name === 'http_refusals_total')?.points ?? [])
    .filter((point) => point.attributes['code'] === code)
    .reduce((sum, point) => sum + point.value, 0);

const wall = (nowMs: number, route = '/settings') =>
  refusalLogLevel({
    status: 401,
    code: 'X_UNAUTHENTICATED',
    error: unauthenticated(route),
    route,
    nowMs,
  });

describe('a routine refusal', () => {
  test('is info once per route per minute, debug inside the window, info again after it', () => {
    expect(wall(0)).toBe('info');
    expect(wall(1_000)).toBe('debug');
    expect(wall(ROUTINE_REFUSAL_WINDOW_MS - 1)).toBe('debug');
    expect(wall(ROUTINE_REFUSAL_WINDOW_MS)).toBe('info');
  });

  test('each route has its own window', () => {
    expect(wall(0, '/settings')).toBe('info');
    expect(wall(10, '/billing')).toBe('info');
    expect(wall(20, '/settings')).toBe('debug');
  });

  test('is counted every time, demoted or not', () => {
    for (let at = 0; at < 5; at += 1) wall(at);
    expect(refusalCount('X_UNAUTHENTICATED')).toBe(5);
  });

  test('a credential checker’s own 401 is not routine: warn, every time', () => {
    const rejected = new HttpError({
      code: 'X_UNAUTHENTICATED',
      cause: 'the password did not match',
      fix: 'sign in again',
    });
    const level = (nowMs: number) =>
      refusalLogLevel({
        status: 401,
        code: 'X_UNAUTHENTICATED',
        error: rejected,
        route: '/s',
        nowMs,
      });
    expect(level(0)).toBe('warn');
    expect(level(1)).toBe('warn');
  });

  test('a 5xx is never counted as a refusal and stays error', () => {
    expect(
      refusalLogLevel({ status: 500, code: 'X_INTERNAL', error: undefined, route: '/', nowMs: 0 }),
    ).toBe('error');
    expect(refusalCount('X_INTERNAL')).toBe(0);
  });
});

describe('the error-map line for a scanner on a required route', () => {
  test('the first is info, the next four are debug', async () => {
    const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null });
    const levels: unknown[] = [];
    const run = stageRunners({
      table: httpRouter([]),
      config,
      limiter: {
        scope: 'process',
        check: async () => ({}) as never,
        peek: async () => ({}) as never,
        headers: () => ({}),
        assert: async () => ({}) as never,
      },
      hooks: {},
      middleware: [],
    });
    for (let hit = 0; hit < 5; hit += 1) {
      const url = new URL('http://app.test/settings');
      const ctx = requestContext({
        url,
        method: 'GET',
        role: 'web',
        config,
        logger: structuredLogger({
          level: 'trace',
          writer: (line) => levels.push((JSON.parse(line) as { level: unknown }).level),
        }),
      });
      ctx.error = unauthenticated('/settings');
      await run['error-map'](new UltimateRequest(new Request(url), ctx), ctx);
    }
    expect(levels).toEqual(['info', 'debug', 'debug', 'debug', 'debug']);
  });
});
