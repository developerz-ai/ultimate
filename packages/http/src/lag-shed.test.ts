// H10: the `admit` stage sheds 503 + Retry-After while the event loop's lag p99 is over
// `http.shedLagMs` — and ships OFF (owner decision OD1): an app that never opts in sheds nothing
// and runs no sampler. Lag is scripted — a hand-driven tick on a hand-moved clock — never slept.
import { afterEach, describe, expect, test } from 'bun:test';
import { resetLifecycle } from '@ultimat3/core';
import { defineHttpConfig, type HttpConfigInput } from './config';
import { requestContext } from './context';
import {
  LAG_SAMPLE_MS,
  LAG_WINDOW,
  type LagSampler,
  lagSampler,
  replaceProcessLagSampler,
  stopProcessLagSampler,
} from './lag-shed';
import { httpPipeline } from './pipeline';
import { UltimateRequest } from './request';
import { textResponse } from './response';
import { httpRouter } from './router';
import { stageRunners } from './stages';

afterEach(() => {
  stopProcessLagSampler();
  resetLifecycle();
});

/** A sampler driven by hand: each `late(ms)` is one tick that fired `ms` after it was due. */
const scripted = () => {
  let now = 0;
  let tick = (): void => undefined;
  const sampler = lagSampler({
    clock: { now: () => new Date(0), monotonic: () => now },
    every: (fire) => {
      tick = fire;
      return () => undefined;
    },
  });
  return {
    sampler,
    late(ms: number, times = 1) {
      for (let i = 0; i < times; i += 1) {
        now += LAG_SAMPLE_MS + ms;
        tick();
      }
    },
  };
};

const admit = async (input: HttpConfigInput, lag: LagSampler | undefined) => {
  const config = defineHttpConfig({ rateLimit: { scope: 'process' }, buildId: null, ...input });
  const url = new URL('http://app.test/');
  const ctx = requestContext({ url, method: 'GET', role: 'web', config });
  const never = async (): Promise<never> =>
    expect.unreachable('the limiter is not consulted by admit');
  const run = stageRunners({
    table: httpRouter([]),
    config,
    limiter: { scope: 'process', check: never, peek: never, headers: () => ({}), assert: never },
    hooks: {},
    middleware: [],
    ...(lag === undefined ? {} : { lag }),
  });
  try {
    await run.admit(new UltimateRequest(new Request(url), ctx), ctx);
    return { refused: undefined, retryAfter: ctx.headers.get('retry-after') };
  } catch (error) {
    return { refused: error, retryAfter: ctx.headers.get('retry-after') };
  }
};

describe('the lag sampler', () => {
  test('p99 is the second-worst of a full window: one stall does not count, two do', () => {
    const lag = scripted();
    lag.late(0, LAG_WINDOW - 1);
    lag.late(400);
    expect(lag.sampler.p99Ms()).toBe(0);
    lag.late(300);
    expect(lag.sampler.p99Ms()).toBe(300);
  });

  test('the verdict ages out with the window', () => {
    const lag = scripted();
    lag.late(500, LAG_WINDOW);
    expect(lag.sampler.p99Ms()).toBe(500);
    lag.late(1, LAG_WINDOW);
    expect(lag.sampler.p99Ms()).toBe(1);
  });
});

describe('the admit stage under lag', () => {
  test('sheds 503 X_OVERLOADED with Retry-After when p99 is over shedLagMs', async () => {
    const lag = scripted();
    lag.late(300, LAG_WINDOW);
    const { refused, retryAfter } = await admit({ shedLagMs: 250 }, lag.sampler);
    expect((refused as { code?: unknown }).code).toBe('X_OVERLOADED');
    expect(String((refused as { cause?: unknown }).cause)).toContain('shedLagMs is 250');
    expect(retryAfter).toBe('1');
  });

  test('admits under the ceiling', async () => {
    const lag = scripted();
    lag.late(100, LAG_WINDOW);
    expect((await admit({ shedLagMs: 250 }, lag.sampler)).refused).toBeUndefined();
  });

  test('ships off: the default config never sheds on lag, however late the loop', async () => {
    expect(defineHttpConfig({ rateLimit: { scope: 'process' } }).shedLagMs).toBe(0);
    const lag = scripted();
    lag.late(5_000, LAG_WINDOW);
    expect((await admit({}, lag.sampler)).refused).toBeUndefined();
  });

  test('the process sampler a late loop reports is what the pipeline sheds on', async () => {
    const lag = scripted();
    replaceProcessLagSampler(lag.sampler);
    const pipeline = httpPipeline({
      table: httpRouter([
        {
          method: 'GET',
          path: '/',
          meta: { name: 'home', auth: 'public' },
          handler: () => textResponse('ok'),
        },
      ]),
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, buildId: null, shedLagMs: 50 }),
    });
    const call = () => pipeline.handle(new Request('http://app.test/'), { role: 'web' });
    expect((await call()).status).toBe(200);
    // Three CPU-bound stalls of 150 ms: each tick fires that late, on the scripted clock.
    lag.late(150, 3);
    const shed = await call();
    expect(shed.status).toBe(503);
    expect(shed.headers.get('retry-after')).toBe('1');
  });
});
