// A `%00` in a read's search string, over the real pipeline: decoded to U+0000 and refused by the
// query's own schema as a 400 — never bound into a `where`, where Postgres answers 22021 and the
// read became `X_DB_STATEMENT_FAILED`, a 500.

import { describe, expect, test } from 'bun:test';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryRoute } from './http';
import { query } from './query';
import { from } from './source';

describe('a query parameter carrying %00', () => {
  test('is a 400 X_INPUT_INVALID, and sql is never built', async () => {
    const builds = { count: 0 };
    const bySlug = query({
      input: t.object({ slug: t.string }),
      policy: allow('public'),
      sql: ({ slug }) => {
        builds.count += 1;
        return from<{ id: string; slug: string }>('posts', []).where({ slug });
      },
    }).named('postBySlug');
    const server = httpServer({
      routes: [toQueryRoute(bySlug)],
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
      hooks: { authenticate: () => null },
    });
    const response = await server.fetch(
      new Request('http://dev.test/_x/query/post-by-slug?slug=a%00b'),
    );
    const body = (await response.json()) as { code?: string; cause?: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe('X_INPUT_INVALID');
    expect(body.cause).toContain('contains a NUL character (U+0000)');
    expect(builds.count).toBe(0);
  });
});
