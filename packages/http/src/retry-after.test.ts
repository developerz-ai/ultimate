// A refusal that computed a delay says when to come back. `Retry-After` was set for exactly one
// code — `X_RATE_LIMITED`, off the live limiter decision — so every other throwable carrying the
// number told the caller to retry and never said when, which is the shed-with-no-delay pattern the
// `admit` stage exists to avoid, one layer in.
//
// The contract is not this file's invention: `@ultimat3/auth`'s `kdfOverloaded` already says
// "`retryAfterSeconds` rides in `meta` because this package cannot reach an HTTP header; the host
// reads it onto `Retry-After`". Nothing was the host.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { defineHttpConfig, type HttpConfigInput } from './config';
import { retryAfterOf } from './error-map';
import { HttpError } from './errors';
import { createPipeline } from './pipeline';
import { rateLimited } from './rate-limit-errors';
import { text } from './response';
import { createRouter, type Route, type RouteHandler } from './router';

const routeWith = (handler: RouteHandler): readonly Route[] => [
  { method: 'GET', path: '/probe', meta: { name: 'probe', auth: 'public' }, handler },
];

const pipelineFor = (handler: RouteHandler, input: HttpConfigInput = {}) =>
  createPipeline({
    table: createRouter(routeWith(handler)),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      buildId: null,
      ...input,
    }),
    hooks: { authenticate: () => ({ id: 'u1' }) as never },
  });

const call = (pipeline: ReturnType<typeof createPipeline>): Promise<Response> =>
  pipeline.handle(new Request('http://app.test/probe'), { role: 'web' });

/**
 * The shape `@ultimat3/auth`'s `accountLocked` produces once it carries the field — a 429 built by
 * a package that cannot reach a header. Spelled here rather than imported: `auth` is this tier and
 * this package cannot import it.
 */
const lockedOut = (seconds: number): UltimateError =>
  new UltimateError({
    // Core's class and not `HttpError`: `HttpErrorCode` is a CLOSED union of this package's own
    // codes, and `X_ACCOUNT_LOCKED` is `@ultimat3/auth`'s — which is the whole point, since the
    // reader has to work for a throwable this package did not build.
    code: 'X_ACCOUNT_LOCKED',
    cause: 'locked out after repeated failures',
    fix: 'wait for the Retry-After header',
    meta: { retryAfterSeconds: seconds },
  });

describe('unit · what the reader accepts', () => {
  test('a number in meta, rounded up and floored at one second', () => {
    expect(retryAfterOf(lockedOut(30))).toBe(30);
    expect(retryAfterOf(lockedOut(4.2))).toBe(5);
    // `0` reads as "retry now", which is the stampede the header exists to spread.
    expect(retryAfterOf(lockedOut(0))).toBe(1);
  });

  test('anything that is not a usable number of seconds is no header at all', () => {
    expect(retryAfterOf(lockedOut(Number.NaN))).toBeUndefined();
    expect(retryAfterOf(lockedOut(-1))).toBeUndefined();
    expect(retryAfterOf(new HttpError({ code: 'X_FORBIDDEN', cause: 'no', fix: 'no' }))).toBe(
      undefined,
    );
    expect(retryAfterOf(null)).toBeUndefined();
    expect(retryAfterOf('a string')).toBeUndefined();
  });

  test('a throwable that fights being read answers undefined instead of throwing', () => {
    // The frame this runs in is the one deciding what the caller sees; a `meta` getter that raises
    // there takes the 500 renderer with it.
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new TypeError('no reads');
        },
      },
    );
    expect(retryAfterOf(hostile)).toBeUndefined();
  });
});

describe('the recover stage', () => {
  test('a 429 that computed a delay carries it', async () => {
    const pipeline = pipelineFor(() => {
      throw lockedOut(30);
    });
    const response = await call(pipeline);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
  });

  test('a refusal with no delay to give carries no header, rather than a made-up one', async () => {
    const pipeline = pipelineFor(() => {
      throw new HttpError({ code: 'X_FORBIDDEN', cause: 'not yours', fix: 'ask' });
    });
    const response = await call(pipeline);
    expect(response.status).toBe(403);
    expect(response.headers.get('retry-after')).toBeNull();
  });

  test("the limiter's own decision still wins for X_RATE_LIMITED", async () => {
    // The live decision knows this request's bucket; the throwable carries a copy of it. The
    // precedence is unchanged and asserted so a later edit cannot quietly invert it.
    const pipeline = pipelineFor(() => {
      throw rateLimited('probe|actor:u1', 7);
    });
    const response = await call(pipeline);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
  });

  test('a 200 is untouched', async () => {
    const pipeline = pipelineFor(() => text('ok'));
    const response = await call(pipeline);
    expect(response.status).toBe(200);
    expect(response.headers.get('retry-after')).toBeNull();
  });
});
