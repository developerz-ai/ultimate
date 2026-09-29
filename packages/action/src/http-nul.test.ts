// A NUL character in a `t.string` field, over the real pipeline: refused by the input schema as a
// 400, never handed to the handler — where the row write or a `where` bind would have answered
// Postgres's 22021 as `X_DB_STATEMENT_FAILED`, a 500 blaming the server for a byte the caller sent.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { toRoute } from './http';

describe('an action input carrying U+0000', () => {
  test('is a 400 naming the field, and the handler never runs', async () => {
    const calls = { count: 0 };
    const rename = action({
      input: t.object({ title: t.string }),
      output: t.object({ title: t.string }),
      policy: allow('public'),
      handle: ({ input }) => {
        calls.count += 1;
        return { title: input.title };
      },
    }).named('renamePost');
    const server = createServer({
      routes: [toRoute(rename)],
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
      hooks: { authenticate: () => userActor({ id: 'u1' }) },
    });
    const response = await server.fetch(
      new Request(`http://dev.test${toRoute(rename).path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://dev.test' },
        body: JSON.stringify({ title: 'a\u0000b' }),
      }),
    );
    const body = (await response.json()) as { code?: string; cause?: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe('X_INPUT_INVALID');
    expect(body.cause).toContain('title: expected a non-empty string');
    expect(body.cause).toContain('contains a NUL character (U+0000)');
    expect(calls.count).toBe(0);
  });
});
