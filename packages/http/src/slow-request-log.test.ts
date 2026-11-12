// `http.request.slow`: one `warn` line for a request over `http.slowRequestMs`, its stage timings
// beside it, and none for a fast one. Driven through the real `handler` and `response` stages; the
// request's age is set on its context rather than slept, so the test pins the decision, not a clock.
import { afterEach, describe, expect, test } from 'bun:test';
import { instrument, runWithContext, structuredLogger } from '@ultimat3/core';
import { defineHttpConfig, type HttpConfigInput } from './config';
import { asCtx, type RequestContext, requestContext } from './context';
import { UltimateRequest } from './request';
import { subscribeRequestTimings } from './request-timings';
import { textResponse } from './response';
import { httpRouter } from './router';
import { SLOW_REQUEST_MESSAGE } from './slow-request-log';
import { stageRunners } from './stages';

const never = (): never => {
  throw new TypeError('the limiter is not consulted by these stages');
};

const limiter = {
  scope: 'process' as const,
  check: async () => never(),
  peek: async () => never(),
  headers: () => ({}),
  assert: async () => never(),
};

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

interface Served {
  readonly lines: readonly Record<string, unknown>[];
  readonly response: Response | undefined;
}

/** Run `handler` then `response` for GET /report, the request `ageMs` old when the handler ends. */
const serve = async (ageMs: number, input: HttpConfigInput = {}): Promise<Served> => {
  const config = defineHttpConfig({ rateLimit: { scope: 'process' }, buildId: null, ...input });
  const lines: Record<string, unknown>[] = [];
  const url = new URL('http://app.test/report');
  const route = {
    method: 'GET' as const,
    path: '/report',
    meta: { name: 'report', auth: 'public' as const },
    handler: async () => {
      // Two statements on the request's own stack, as the db funnel emits them.
      instrument('db.statement', { text: 'select 1', values: [], rows: 1, durationMs: 40 });
      instrument('db.statement', { text: 'select 2', values: [], rows: 1, durationMs: 60 });
      (ctx as { startedAt: number }).startedAt = performance.now() - ageMs;
      return textResponse('ok');
    },
  };
  const ctx: RequestContext = requestContext({
    url,
    method: 'GET',
    role: 'web',
    config,
    logger: structuredLogger({
      level: 'trace',
      writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  });
  ctx.route = route;
  const run = stageRunners({
    table: httpRouter([route]),
    config,
    limiter,
    hooks: {},
    middleware: [],
  });
  const request = new UltimateRequest(new Request(url), ctx);
  await runWithContext(asCtx(ctx), async () => {
    ctx.response = await run.handler(request, ctx);
    await run.response(request, ctx);
  });
  return { lines, response: ctx.response };
};

const slowLines = (served: Served) =>
  served.lines.filter((line) => line['msg'] === SLOW_REQUEST_MESSAGE);

describe('the slow-request line', () => {
  test('a 1.2 s request logs one warn line with its stage timings', async () => {
    release = subscribeRequestTimings();
    const [line, ...rest] = slowLines(await serve(1_200));
    expect(rest).toHaveLength(0);
    expect(line?.['level']).toBe('warn');
    expect(line?.['http.route']).toBe('/report');
    expect(line?.['http.request.method']).toBe('GET');
    expect(line?.['http.response.status_code']).toBe(200);
    expect(Number(line?.['durationMs'])).toBeGreaterThanOrEqual(1_200);
    expect(line?.['thresholdMs']).toBe(1_000);
    expect(line?.['dbStatements']).toBe(2);
    expect(line?.['dbMs']).toBe(100);
    expect(typeof line?.['gateMs']).toBe('number');
    expect(typeof line?.['handlerMs']).toBe('number');
    // The correlation ids ride the request logger's own binding.
    expect(String(line?.['requestId']).length).toBeGreaterThan(0);
  });

  test('a fast request logs no line', async () => {
    release = subscribeRequestTimings();
    expect(slowLines(await serve(5))).toHaveLength(0);
  });

  test('slowRequestMs: 0 writes no line, however slow', async () => {
    expect(slowLines(await serve(5_000, { slowRequestMs: 0 }))).toHaveLength(0);
  });

  test('the threshold is the configured one', async () => {
    expect(slowLines(await serve(300, { slowRequestMs: 250 }))).toHaveLength(1);
    expect(slowLines(await serve(200, { slowRequestMs: 250 }))).toHaveLength(0);
  });

  test('without the boot subscriber the line still carries total and the handler split', async () => {
    const [line] = slowLines(await serve(1_500));
    expect(line?.['dbStatements']).toBe(0);
    expect(typeof line?.['handlerMs']).toBe('number');
  });
});
