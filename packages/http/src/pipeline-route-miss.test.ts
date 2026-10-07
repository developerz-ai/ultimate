// `hooks.explainMiss`: the one thing a higher tier may say about a request the router matched
// nothing for. It decides nothing about a request that DID match, and absent it a miss is the
// plain `X_ROUTE_NOT_FOUND` it always was.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import type { ServerHooks } from './hooks';
import { httpPipeline } from './pipeline';
import { textResponse } from './response';
import { httpRouter, type Route } from './router';

const routes: readonly Route[] = [
  {
    method: 'POST',
    path: '/api/publish-post',
    meta: { name: 'publishPost', auth: 'public' },
    handler: () => textResponse('published'),
  },
];

const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null });

const pipelineWith = (hooks: ServerHooks) =>
  httpPipeline({ table: httpRouter(routes), config, hooks });

const request = (method: string, path: string): Request =>
  new Request(`http://app.test${path}`, { method });

/** A code this package already owns a status row for, so the test reads the row and not a 500. */
const explained = (): UltimateError =>
  new UltimateError({
    code: 'X_BUILD_SKEW',
    cause: 'the caller derived this path under another rule',
    fix: 'x routes --json',
  });

const answer = async (
  response: Response,
): Promise<{ status: number; code: unknown; cause: unknown }> => {
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, code: body['code'], cause: body['cause'] };
};

describe('hooks.explainMiss', () => {
  test('its error is the answer to a miss, under that code’s own status', async () => {
    const asked: string[] = [];
    const pipeline = pipelineWith({
      explainMiss: (method, pathname) => {
        asked.push(`${method} ${pathname}`);
        return explained();
      },
    });
    const response = await pipeline.handle(request('POST', '/api/posts/publish'), { role: 'web' });

    expect(asked).toEqual(['POST /api/posts/publish']);
    expect(await answer(response)).toEqual({
      status: 409,
      code: 'X_BUILD_SKEW',
      cause: 'the caller derived this path under another rule',
    });
  });

  test('answering undefined keeps the plain miss', async () => {
    const pipeline = pipelineWith({ explainMiss: () => undefined });
    const response = await pipeline.handle(request('POST', '/api/nope'), { role: 'web' });
    const body = await answer(response);

    expect(body.status).toBe(404);
    expect(body.code).toBe('X_ROUTE_NOT_FOUND');
  });

  test('is never asked about a request a route answers, or one whose method is refused', async () => {
    let asked = 0;
    const pipeline = pipelineWith({
      explainMiss: () => {
        asked += 1;
        return explained();
      },
    });
    const served = await pipeline.handle(request('POST', '/api/publish-post'), { role: 'web' });
    const refused = await pipeline.handle(request('GET', '/api/publish-post'), { role: 'web' });

    expect(served.status).toBe(200);
    expect(refused.status).toBe(405);
    expect(asked).toBe(0);
  });
});
