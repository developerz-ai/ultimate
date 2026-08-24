// The `authz` stage's refusal, end to end: what a denied request is TOLD to run next. Split from
// `pipeline.test.ts`, which is at the file-size ceiling, and kept whole here because the fix line
// is the only part of a 403 an agent can act on.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import type { AuthzDecision } from './hooks';
import { createPipeline } from './pipeline';
import { createRateLimiter } from './rate-limit';
import { text } from './response';
import { createRouter, type Route } from './router';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/settings',
    // What `@ultimat3/cli`'s `dev-render.ts` writes for a page route: `meta.policy` is the
    // PERMISSION off `entry.config.policy`, which is exactly what `x policy explain` resolves.
    meta: { name: 'settings', auth: 'public', policy: 'member:self' },
    handler: () => text('never reached'),
  },
  {
    method: 'GET',
    path: '/unwired',
    meta: { name: 'unwired', auth: 'public', policy: 'post:publish' },
    handler: () => text('never reached'),
  },
];

const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false });

const pipelineWith = (decision?: AuthzDecision) =>
  createPipeline({
    table: createRouter(routes),
    config,
    limiter: createRateLimiter({
      config: {
        enabled: true,
        defaultBucket: 'default',
        tenantBucket: null,
        scope: 'process',
        buckets: { default: { capacity: 100, refillPerSecond: 1 } },
      },
    }),
    hooks: {
      authenticate: () => null,
      ...(decision === undefined ? {} : { authorize: (): AuthzDecision => decision }),
    },
  });

const get = (path: string) => new Request(`http://localhost${path}`);

/** The problem document is where a caller and an agent both read the fix. */
const problemOf = async (response: Response) => {
  const body: unknown = await response.json();
  const record = body as { readonly fix?: unknown; readonly code?: unknown };
  return { code: record.code, fix: record.fix };
};

describe('authz stage refusals', () => {
  test('a denied page route names its POLICY, not its pathname', async () => {
    const response = await pipelineWith({ allowed: false, reason: 'not the member' }).handle(
      get('/settings'),
      { role: 'web' },
    );
    expect(response.status).toBe(403);
    const problem = await problemOf(response);
    expect(problem.code).toBe('X_FORBIDDEN');
    // `x policy explain /settings` exits `X_DECLARATION_UNKNOWN`: a pathname is not a subject.
    expect(problem.fix).toBe('x policy explain member:self --json   # shows which clause denied');
  });

  test('a policy with no authorizer wired names the policy too', async () => {
    const response = await pipelineWith().handle(get('/unwired'), { role: 'web' });
    expect(response.status).toBe(403);
    const problem = await problemOf(response);
    expect(problem.fix).toBe('x policy explain post:publish --json   # shows which clause denied');
  });

  test('the cause still carries the pathname, so the log line locates the route', async () => {
    const response = await pipelineWith({ allowed: false, reason: 'not the member' }).handle(
      get('/settings'),
      { role: 'web' },
    );
    const body: unknown = await response.json();
    expect((body as { readonly cause: string }).cause).toContain('/settings');
  });
});
