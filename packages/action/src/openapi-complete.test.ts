// The complete document and a bearer mount's own: 401/429 exactly where the ROUTE authenticates
// or limits, the app's info/servers, the security schemes, and a mount cut to its scopes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { defineApi } from './define-api';
import { toRoute } from './http';
import { buildOpenApi } from './openapi';
import { completeOpenApi, mountOpenApi } from './openapi-complete';
import { listActions, resetRegistry } from './registry';

const Out = t.object({ ok: t.boolean });

beforeEach(() => {
  resetRegistry();
  defineApi({
    actions: {
      createCase: action({
        input: t.object({ title: t.string }),
        output: Out,
        policy: can('cases:create'),
        handle: () => ({ ok: true }),
      }),
      health: action({
        input: t.object({}),
        output: Out,
        policy: allow('health:read'),
        handle: () => ({ ok: true }),
      }),
      signIn: action({
        input: t.object({ email: t.string }),
        output: t.object({ session: t.string }),
        policy: allow('session:create'),
        rateLimit: { limit: 5, windowMs: 60_000 },
        handle: () => ({ session: 's' }),
      }),
      grantCredits: action({
        input: t.object({ orgId: t.string }),
        output: Out,
        policy: can('credits:grant'),
        handle: () => ({ ok: true }),
      }),
    },
    http: { pathStyle: 'readable' },
  });
});
afterEach(() => resetRegistry());

type Op = {
  responses: Record<string, { headers?: Record<string, unknown> }>;
  security?: unknown;
  'x-ultimate'?: Record<string, unknown>;
};
const op = (doc: { paths: Record<string, unknown> }, path: string, method = 'post'): Op =>
  (doc.paths[path] as Record<string, Op>)[method] as Op;

describe('completeOpenApi', () => {
  const complete = () =>
    completeOpenApi(buildOpenApi({ title: 'app', version: '0.1.0' }), {
      declared: {
        title: 'Notificado API',
        version: '1.0.0',
        servers: [{ url: 'https://www.notificado.co' }],
      },
      routes: listActions().map(toRoute),
      bearer: true,
    });

  test("carries the app's info and servers", () => {
    const doc = complete();
    expect(doc.info).toEqual({ title: 'Notificado API', version: '1.0.0' });
    expect(doc.servers).toEqual([{ url: 'https://www.notificado.co' }]);
  });

  test('declares the cookie scheme, and bearer when a mount exists', () => {
    expect(Object.keys(complete().components.securitySchemes ?? {}).sort()).toEqual([
      'bearer',
      'cookie',
    ]);
  });

  test('every authenticated operation documents 401 and 429 with Retry-After', () => {
    const created = op(complete(), '/api/create-case');
    expect(created.responses['401']).toBeDefined();
    expect(Object.keys(created.responses['429']?.headers ?? {})).toContain('Retry-After');
    expect(created.security).toEqual([{ cookie: [] }]);
  });

  test('a public operation gets neither, unless it declares a rate limit', () => {
    const health = op(complete(), '/api/health');
    expect(health.responses['401']).toBeUndefined();
    expect(health.responses['429']).toBeUndefined();
    expect(health.security).toBeUndefined();
    const signIn = op(complete(), '/api/sign-in');
    expect(signIn.responses['401']).toBeUndefined();
    expect(Object.keys(signIn.responses['429']?.headers ?? {}).sort()).toEqual([
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
    ]);
    expect(Object.keys(signIn.responses['200']?.headers ?? {})).toContain('RateLimit-Remaining');
  });
});

describe('mountOpenApi', () => {
  const mounted = () =>
    mountOpenApi(buildOpenApi({ title: 'app', version: '0.1.0' }), {
      declared: { title: 'Notificado API', version: '1.0.0' },
      mount: {
        prefix: '/v1',
        scopes: { 'cases:write': ['createCase'], 'ops:read': ['health'] },
        resolveToken: () => null,
        rateLimit: { limit: 60, windowMs: 60_000 },
      },
      routes: listActions().map(toRoute),
    });

  test('holds only the cut, at the mounted paths', () => {
    expect(Object.keys(mounted().paths)).toEqual(['/v1/create-case', '/v1/health']);
  });

  test('bearer only, with 401, the hidden 404, a limited 429, and the scope it needs', () => {
    const doc = mounted();
    expect(Object.keys(doc.components.securitySchemes ?? {})).toEqual(['bearer']);
    const created = op(doc, '/v1/create-case');
    expect(created.security).toEqual([{ bearer: ['cases:write'] }]);
    expect(Object.keys(created.responses).sort()).toEqual(
      ['200', '400', '401', '403', '404', '422', '429'].sort(),
    );
    expect(created['x-ultimate']?.['scope']).toBe('cases:write');
    expect(Object.keys(created.responses['401']?.headers ?? {})).toEqual(['WWW-Authenticate']);
  });

  test('each operation names ITS scope in the security requirement, never an empty list', () => {
    // `health` is public on the plain API; mounted, it is still a bearer route behind `ops:read`.
    expect(op(mounted(), '/v1/health').security).toEqual([{ bearer: ['ops:read'] }]);
  });

  test('the bearer scheme documents every scope and the operations it unlocks', () => {
    const bearer = mounted().components.securitySchemes?.['bearer'] as {
      readonly type: string;
      readonly description: string;
      readonly 'x-ultimate': { readonly scopes: Readonly<Record<string, readonly string[]>> };
    };
    expect(bearer.type).toBe('http');
    expect(bearer['x-ultimate'].scopes).toEqual({
      'cases:write': ['createCase'],
      'ops:read': ['health'],
    });
    expect(bearer.description).toContain('`cases:write`');
    expect(bearer.description).toContain('`ops:read`');
  });

  test('carries only the schemas the cut references', () => {
    expect(Object.keys(mounted().components.schemas).sort()).toEqual([
      'CreateCaseInput',
      'CreateCaseOutput',
      'HealthInput',
      'HealthOutput',
      'Problem',
    ]);
  });
});
